/**
 * The wiring a turn's tools run against.
 *
 * Ported from `build_tool_context` in `crates/daemon/src/handler/generation.rs`,
 * pinned by `tests/handler_fixtures/generation_parity.json`.
 *
 * Every field is derived from the character name and the two roots, and the
 * derivation is the whole of the behaviour: an image goes under *data*, a
 * workspace and its memory go under *config*, and the search index goes under
 * *cache*. Getting one wrong writes a character's files somewhere nothing reads
 * them back, which no test that stubs paths can catch — hence a fixture that
 * records the real ones.
 *
 * # Three optional wirings, and what each absence means
 *
 * - **No embedder.** Semantic retrieval degrades to lexical. Resolution failure
 *   is swallowed into a warning rather than raised: an unconfigured or
 *   key-less embedding provider must cost search quality, not the turn.
 * - **No image-generation config.** `generate_image` has nothing behind it and
 *   reports `io:`, because the tool is still registered and routed.
 * - **No sub-agent runtime.** `ask_*` is `NotImplemented`, which is also the
 *   recursion cap — a sub-agent's own context leaves this out, so it cannot
 *   delegate further.
 *
 * # What the Rust bundled that this does not
 *
 * `SharedToolContext` carried the `LlmClient` so `ledger_client()` could be
 * reached through the sub-agent runtime, and `HandlerToolContext` wrapped it to
 * add the autonomy manager. Neither wrapper survives: {@link ToolContext} is a
 * plain interface of what tools actually read, and the two callers that need
 * more hang it off their own closure.
 *
 * The **markdown memory store** is not opened either, and that is the one field
 * of `SharedToolContext` with no counterpart here. The Rust opened it on every
 * turn; the only thing that ever read it back was `subagent.rs` handing it to a
 * sub-agent's own context. No tool handler touches it, which is why
 * {@link ToolContext} has no slot for one — so opening it here would build a
 * field nothing reads. It comes back with the sub-agent runtime, or not at all.
 */

import type { LoadedConfig } from "../config/loader.ts";
import type { ProviderEntry as RegistryEntry } from "../config/providers.ts";
import { characterDataDir, characterWorkspaceDir, rustJoin } from "../config/dirs.ts";
import type { ProviderEntry } from "../llm/credentials.ts";
import { resolveImageGenConfig } from "../llm/image_generate.ts";
import { ensureActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { resolveEmbedder } from "../memory/retrieval.ts";
import { indexPath, type RetrievalConfig } from "../memory/workspace_index.ts";
import type { RetrievalConfig as ConfiguredRetrieval } from "../config/app.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

/** What the builder needs beyond the config, because none of it is config. */
export interface ToolContextDeps {
  /** Live MCP connections. Absent leaves every `mcp__*` name uncallable. */
  mcpRegistry?: Pick<McpRegistry, "call">;
  /**
   * Runs a configured sub-agent. Wired only when `[subagents.*]` is non-empty,
   * matching the Rust — which built the runtime conditionally to avoid cloning
   * the config into an `Arc` on every turn that has no sub-agents.
   *
   * A **binder**, not the function itself, because a sub-agent's nested loop
   * runs against this very context minus its own `runSubagent` — that removal
   * is the recursion cap. So the runner cannot exist until the context does,
   * and the one place that knows both is here. A caller with nothing to pass
   * leaves `ask_*` uncallable, which is what a daemon without the runtime did.
   */
  runSubagent?: (parent: ToolContext) => NonNullable<ToolContext["runSubagent"]>;
  /** Records that a prompt-visible file changed. */
  deferEdit?: (path: string) => Promise<void> | void;
  /** `generate_image`'s backend, when one is configured. */
  imageGenerator?: ToolContext["imageGenerator"];
  /** `model_history`'s backend. */
  modelHistoryQuery?: ToolContext["modelHistoryQuery"];
  /** `activity`'s backend. */
  activityStats?: ToolContext["activityStats"];
  /** Injected for tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Assemble the tool context for one turn, and seed the active-prompt snapshot.
 *
 * The snapshot is a side effect rather than a return value, and it is here
 * rather than at the call site because it is the same "prepare the character's
 * files" step the paths above describe. A failure to write one warns and the
 * context is still built: the turn can run without a baseline to diff a
 * deferred edit against.
 */
export async function buildToolContext(
  config: LoadedConfig,
  dataDir: string,
  charName: string,
  deps: ToolContextDeps = {},
): Promise<ToolContext> {
  const providers = providerRecord(config);

  const imageGen = resolveImageGenConfig({
    ...(config.app.defaults.image_generation === undefined
      ? {}
      : { defaultRef: config.app.defaults.image_generation }),
    imageGen: Object.fromEntries(config.models.imageGeneration),
    providers,
  });

  const charDataDir = characterDataDir(dataDir, charName);
  const configDir = config.dirs.config;
  const workspaceDir = characterWorkspaceDir(configDir, charName);

  let embedder: ToolContext["embedder"];
  try {
    embedder = resolveEmbedder({
      ...(config.app.defaults.embedding === undefined
        ? {}
        : { defaultRef: config.app.defaults.embedding }),
      embedding: Object.fromEntries(config.models.embedding),
      providers,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  } catch (e) {
    console.warn(
      `shore: embedder unavailable for ${charName}; semantic memory retrieval disabled: ${String(e)}`,
    );
  }

  try {
    await ensureActivePromptSnapshot(charDataDir, configDir, charName);
  } catch (e) {
    console.warn(`shore: failed to prepare active prompt snapshot for ${charName}: ${String(e)}`);
  }

  const mcp = deps.mcpRegistry;
  // `[subagents]` being empty is the gate, not whether a runner was passed:
  // the Rust asked the config, and a caller that always passes a runner would
  // otherwise offer `ask_*` for sub-agents that do not exist.
  const subagentsConfigured = config.app.subagents.size > 0;

  const ctx: ToolContext = {
    imageDir: rustJoin(charDataDir, "images"),
    workspaceDir,
    characterDataDir: charDataDir,
    characterName: charName,
    configDir,
    searchConfig: config.app.tools.web_search,
    retrievalConfig: retrievalView(config.app.memory.retrieval),
    retrievalMode: config.app.memory.retrieval.mode,
    memoryIndexPath: indexPath(config.dirs.cache, charName),
    ...("ok" in imageGen ? { imageGenConfig: imageGen.ok } : {}),
    ...(deps.imageGenerator === undefined ? {} : { imageGenerator: deps.imageGenerator }),
    ...(deps.modelHistoryQuery === undefined ? {} : { modelHistoryQuery: deps.modelHistoryQuery }),
    ...(deps.activityStats === undefined ? {} : { activityStats: deps.activityStats }),
    ...(embedder === undefined ? {} : { embedder }),
    ...(deps.deferEdit === undefined ? {} : { deferEdit: deps.deferEdit }),
    ...(mcp === undefined
      ? {}
      : { mcpCall: (name: string, input: unknown) => mcp.call(name, input) }),
  };

  // Attached after the object exists, because the runner closes over it: the
  // nested loop a sub-agent runs gets this context with `runSubagent` gone.
  if (subagentsConfigured && deps.runSubagent !== undefined) {
    ctx.runSubagent = deps.runSubagent(ctx);
  }
  return ctx;
}

/**
 * `[providers.*]` as the two resolvers want it: keyed by provider, with the
 * entry's own `base_url` lifted out beside it.
 *
 * The key list is retyped on the way through, because the registry and the
 * credential resolver spell the same field differently — `warnOnFallback` in
 * the parsed config, `warn_on_fallback` in `llm/credentials.ts`, which took its
 * spelling from the wire. This is the first production caller to need both, and
 * one translation in one place is the cheaper of the two fixes.
 */
function providerRecord(
  config: LoadedConfig,
): Record<string, { entry?: ProviderEntry; baseUrl?: string }> {
  const out: Record<string, { entry?: ProviderEntry; baseUrl?: string }> = {};
  for (const [key, entry] of config.providers.entries()) {
    out[key] = {
      entry: credentialEntry(entry),
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
    };
  }
  return out;
}

/** A registry entry as the credential resolver reads it. */
export function credentialEntry(entry: RegistryEntry): ProviderEntry {
  return {
    enabled: entry.enabled,
    keys: entry.keys.map((k) => ({
      name: k.name,
      env: k.env,
      enabled: k.enabled,
      warn_on_fallback: k.warnOnFallback,
    })),
  };
}

/**
 * `[memory.retrieval]` as the index reads it.
 *
 * A rename, and only a rename: the config is snake_case because it is a TOML
 * table, and `memory/workspace_index.ts` is camelCase because it is not.
 */
function retrievalView(cfg: ConfiguredRetrieval): RetrievalConfig {
  return {
    maxFileBytes: cfg.max_file_bytes,
    maxIndexedFiles: cfg.max_indexed_files,
    maxTotalIndexedBytes: cfg.max_total_indexed_bytes,
    maxEmbedCharsPerFile: cfg.max_embed_chars_per_file,
    binary: cfg.binary,
  };
}
