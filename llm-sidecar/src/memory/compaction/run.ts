/**
 * Everything a compaction pass needs, resolved and handed to the pass.
 *
 * Ported from `run_compaction` and `resolve_compaction_deps` in
 * `crates/daemon/src/memory/compaction/background.rs`, together with the
 * `prepare_and_run_compaction` half of
 * `crates/daemon/src/commands/state/memory.rs`, pinned by
 * `tests/memory_fixtures/compaction_assembly_parity.json`.
 *
 * `background.ts` said in its own header that this "lands with `handler/`,
 * which is also where its one caller lives". It has three callers, and that is
 * the reason it is one function: the idle trigger, the inline compaction a chat
 * turn schedules, and `shore compact`. The Rust had two copies of this
 * assembly — one in `background.rs` and one in `commands/state/memory.rs`,
 * differing in which error type they raised and whether a dry run was possible
 * — and a difference between them was a difference in what the model was shown.
 *
 * # What it resolves
 *
 * - **The effective config**: global with the character's overlay merged over
 *   it, so a per-character `[memory]` or `[models]` setting applies to a
 *   background pass exactly as it does to a turn.
 * - **The two templates**, per character, then global, then the bundled
 *   default.
 * - **The background model**, which is `[models.background.compaction]` before
 *   the app default. No model is a refusal, not a fallback.
 * - **The chat-shape request the pass extends.** The cached `last_request`
 *   first, because it is already warm against the provider's prompt cache;
 *   otherwise one rebuilt from disk to the same wire shape, so the next chat
 *   turn can still hit the prefix this seeds.
 * - **The tool context**, which is the same one a turn builds minus the
 *   sub-agent runtime — a compaction pass has no client to stream to and
 *   nothing to delegate to.
 *
 * # The guard is the first thing and the last thing
 *
 * `tryBeginCompaction` writes a lock the whole pass runs under. Two passes over
 * one character would archive the same segment twice and race the retained
 * write, so a second caller is refused rather than queued — a compaction whose
 * trigger fired while another was running is a compaction whose trigger will
 * fire again.
 */

import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { resolvePromptTemplate } from "../../config/dirs.ts";
import { characterMemoryDir } from "../../config/dirs.ts";
import { resolveDisplayName } from "../../config/app.ts";
import { resolveBackgroundModel, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { configView } from "../../config/preferences.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import { toRequestModel } from "../../config/models.ts";
import type { SidecarRequest } from "../../llm/types.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "../../handler/tool_context.ts";
import { dispatchTool } from "../../tools/dispatch.ts";
import { ensureWorkspaceGitRepoBestEffort, gitCommitAll } from "../../tools/workspace.ts";
import { MarkdownMemoryStore } from "../markdown_store.ts";
import { applyDeferredEdits } from "../deferred_edits.ts";
import type { CompactionRunner } from "../../handler/turn.ts";
import { conversationManager, segmentCount } from "./archive.ts";
import { handleCompactionOutcome, loadMessagesForCompaction, pushAfterCompaction } from "./background.ts";
import { RealCompactionLlm, type RealCompactionLlmOptions } from "./llm.ts";
import { compact, tryBeginCompaction } from "./manager.ts";
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM } from "./prompts.ts";
import { CompactionError, type CompactionOutcome, type CompactionTools } from "./types.ts";

/** What the assembly needs that the config does not carry. */
export interface CompactionRunDeps {
  /** The global config; the character's overlay is merged over it here. */
  config: LoadedConfig;
  /** Makes the provider calls the pass makes, and writes their ledger rows. */
  generate: RealCompactionLlmOptions["generate"];
  /** The conversation's cached `last_request`, when there is one. */
  cachedRequest?: SidecarRequest;
  /** A desktop notification. */
  notify?: (title: string, body: string) => void;
  /** What the tool context needs beyond the config — never a sub-agent runner. */
  tools?: Omit<ToolContextDeps, "runSubagent">;
  /** Injected so a replay can pin the manifest's stamp and the pass's id. */
  now?: () => string;
  newId?: () => string;
}

/** What one call may override about the pass itself. */
export interface CompactionRunOptions {
  dryRun?: boolean;
  keepTurnsOverride?: number;
  /** The idle path keeps a trailing autonomous run out of the archive. */
  retainTrailingAutonomous?: boolean;
}

/**
 * Run a pass, and return how many turns it retained.
 *
 * Zero means "nothing to do" as well as "nothing was written": an empty
 * conversation, and a pass whose model produced no memory writes, both return
 * it. That is the Rust's contract and the callers treat it the same way — the
 * next trigger tries again against a conversation that is still intact.
 */
export async function runCompaction(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<number> {
  const outcome = await runCompactionPass(character, deps, options);
  if (outcome === undefined) return 0;
  return handleCompactionOutcome(character, deps.notify ?? (() => {}), outcome);
}

/**
 * The same pass, with its raw outcome.
 *
 * `shore compact` renders all three outcomes — a dry run's preview, a pass that
 * wrote nothing, a pass that archived — so it needs what
 * {@link runCompaction} folds into a number. `undefined` is the
 * nothing-to-compact case, which is not an outcome at all.
 */
export async function runCompactionPass(
  character: string,
  deps: CompactionRunDeps,
  options: CompactionRunOptions = {},
): Promise<CompactionOutcome | undefined> {
  const dataDir = deps.config.dirs.data;

  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) {
    throw CompactionError.conversationManager(`Compaction already running for ${character}`);
  }

  try {
    const loaded = await loadMessagesForCompaction(dataDir, character);
    if (loaded.messages.length === 0) return undefined;

    const resolved = await resolveDeps(character, deps);
    const chatRequest = await resolveChatRequest(character, deps, loaded, resolved.effective);

    const outcome = await compact(
      {
        conversationId: character,
        messages: loaded.messages,
        activeContent: loaded.rawContent,
        systemTemplate: resolved.systemTemplate,
        promptTemplate: resolved.promptTemplate,
        charName: character,
        userName: resolved.displayName,
        llm: resolved.llm,
        conversationMgr: conversationManager(
          loaded.characterDir,
          deps.now ?? (() => new Date().toISOString()),
          deps.newId ?? (() => crypto.randomUUID()),
        ),
        ...(resolved.markdownStore === undefined ? {} : { markdownStore: resolved.markdownStore }),
        dryRun: options.dryRun ?? false,
        ...(options.keepTurnsOverride === undefined
          ? {}
          : { keepTurnsOverride: options.keepTurnsOverride }),
        retainTrailingAutonomous: options.retainTrailingAutonomous ?? false,
        chatRequest,
        dataDir,
        tools: resolved.tools,
        ...(resolved.maxToolIterations === undefined
          ? {}
          : { maxToolIterations: resolved.maxToolIterations }),
      },
      { keepRecentTurns: resolved.effective.app.memory.compaction.keep_recent_turns },
    );

    // Opt-in and best-effort: a push that fails must never undo an archive that
    // already happened.
    await pushAfterCompaction(resolved.effective.app.memory.git_push, outcome, async () => {
      await gitCommitAll(resolved.tools.workspaceDir, character, "memory: compaction");
    });

    return outcome;
  } finally {
    guard.release();
  }
}

// ── the dependencies ────────────────────────────────────────────────────

interface ResolvedDeps {
  effective: LoadedConfig;
  systemTemplate: string;
  promptTemplate: string;
  displayName: string;
  llm: RealCompactionLlm;
  markdownStore: MarkdownMemoryStore | undefined;
  tools: CompactionTools;
  maxToolIterations: number | undefined;
}

async function resolveDeps(character: string, deps: CompactionRunDeps): Promise<ResolvedDeps> {
  // A character overlay that will not load is a warning and the global config,
  // not a refusal: the pass is a background task and the overlay only holds
  // overrides.
  let effective = deps.config;
  try {
    effective = loadCharacterConfig(deps.config, character) ?? deps.config;
  } catch (e) {
    console.warn(
      `shore: character config failed to load for ${character}; ` +
        `compacting under the global config: ${String(e)}`,
    );
  }

  const configDir = effective.dirs.config;
  const systemTemplate =
    resolvePromptTemplate(configDir, character, "compact_system.md") ?? DEFAULT_COMPACT_SYSTEM;
  const promptTemplate =
    resolvePromptTemplate(configDir, character, "compact.md") ?? DEFAULT_COMPACT_PROMPT;

  const model = resolveBackgroundModel(configView(effective), "compaction", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (model === undefined) {
    throw CompactionError.llm("No model configured for background compaction");
  }

  let markdownStore: MarkdownMemoryStore | undefined;
  try {
    markdownStore = await MarkdownMemoryStore.open(characterMemoryDir(configDir, character));
  } catch (e) {
    // A dry run can proceed without one; a live pass cannot, and `compact`
    // refuses on its own with a message that says so.
    console.warn(`shore: markdown memory store unavailable for ${character}: ${String(e)}`);
  }

  const toolCtx = await buildToolContext(effective, effective.dirs.data, character, deps.tools ?? {});
  const entry = effective.providers.get(model.providerKey);
  const providerEntry = entry === undefined ? undefined : credentialEntry(entry);

  return {
    effective,
    systemTemplate,
    promptTemplate,
    displayName: resolveDisplayName(effective.app.defaults),
    llm: new RealCompactionLlm({
      // The wire-shaped copy: `llm/request.ts` builds from snake_case fields,
      // and the catalog is camelCase. `toRequestModel` is the one translation.
      model: toRequestModel(model),
      character,
      generate: deps.generate,
      // The provider entry, so a compaction honours `[providers.<name>].keys`
      // rather than looking only at the model's own `api_key_env`.
      ...(providerEntry === undefined ? {} : { providerEntry }),
    }),
    markdownStore,
    tools: compactionTools(toolCtx),
    maxToolIterations: model.maxToolIterations,
  };
}

/**
 * The tool surface a compaction pass reaches for.
 *
 * The context is a turn's, minus the sub-agent runtime — `buildToolContext`
 * leaves that out unless a runner is passed, and this never passes one. What is
 * added is the rendering: a pass hands the model a string, so a tool's value
 * becomes text and its failure becomes text with a flag, which is what
 * `content_util::dispatch_result_to_output` did.
 */
export function compactionTools(ctx: Parameters<typeof dispatchTool>[2]): CompactionTools {
  return {
    workspaceDir: ctx.workspaceDir,
    configDir: ctx.configDir,
    dispatch: (name, input) => renderToolOutcome(() => dispatchTool(name, input, ctx)),
    ensureWorkspaceGitRepo: async (workspaceDir) => {
      await ensureWorkspaceGitRepoBestEffort(workspaceDir);
    },
    gitCommitAll: async (workspaceDir, charName, message) =>
      await gitCommitAll(workspaceDir, charName, message),
  };
}

/**
 * A tool call's outcome as the model sees it.
 *
 * The port of `content_util::dispatch_result_to_output`, which took a
 * `Result<Value, ToolError>` and produced `(String, bool)`. Here the result is
 * a call that may throw, so the function takes the call — but the two branches
 * are its branches:
 *
 * - A **string** value is its own text. Not re-serialized, which would wrap it
 *   in quotes the model then has to read past.
 * - Anything else is compact JSON.
 * - A **failure** is the error's own message, prefixes included — `invalid
 *   args: `, `io: `. Those prefixes are the contract the model reads, which is
 *   why this is `e.message` and not `String(e)`: the latter puts `Error: ` in
 *   front of them.
 */
export async function renderToolOutcome(
  call: () => Promise<unknown>,
): Promise<{ output: string; isError: boolean }> {
  try {
    const value = await call();
    return { output: typeof value === "string" ? value : (JSON.stringify(value) ?? ""), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

// ── the chat-shape request ──────────────────────────────────────────────

/**
 * The body the pass extends: the cached one, or one rebuilt to match it.
 *
 * The cached `last_request` is preferred because it is the body a chat turn
 * just sent, so extending it lands on a prompt prefix the provider still has.
 * Rebuilding produces the same wire shape from disk — same system blocks, same
 * tool surface, same messages — so a pass that had no cache still seeds a
 * prefix the next chat turn can hit.
 */
async function resolveChatRequest(
  character: string,
  deps: CompactionRunDeps,
  loaded: Awaited<ReturnType<typeof loadMessagesForCompaction>>,
  effective: LoadedConfig,
): Promise<SidecarRequest> {
  if (deps.cachedRequest !== undefined) return deps.cachedRequest;

  const chatModel = resolveChatModelForCharacter(configView(effective), character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (chatModel === undefined) {
    throw CompactionError.llm("No chat model configured for compaction prefix rebuild");
  }

  const hasPriorContext = (await segmentCount(loaded.characterDir)) > 0;
  const built = await buildChatShapeRequestFromDisk(
    character,
    loaded.characterDir,
    effective,
    chatModel,
    [...loaded.store.messages()],
    hasPriorContext,
  );
  return built.request;
}

/** Where a character's conversation lives, for callers that only have a root. */
export function characterDir(dataDir: string, character: string): string {
  return join(dataDir, character);
}

/**
 * The assembly as `handler/turn.ts` wants it.
 *
 * The inline compaction a chat turn schedules is the same pass as the idle
 * trigger's, and it was injected into the generation driver as a
 * `CompactionRunner` because this had not ported. This is that injection's
 * value.
 *
 * `config` is passed per call rather than read off `deps`: the driver holds the
 * character-effective config for the turn it is finishing, and handing that one
 * over is what keeps an inline pass running under the same settings the turn
 * did.
 */
export function compactionRunner(
  deps: Omit<CompactionRunDeps, "config">,
): CompactionRunner {
  return {
    run: (character, config) => runCompaction(character, { ...deps, config }),
    applyDeferredEdits: (charDataDir, configDir, charName) =>
      applyDeferredEdits(charDataDir, configDir, charName),
  };
}
