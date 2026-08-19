import type { LoadedConfig } from "../config/loader.ts";
import type { ProviderEntry as RegistryEntry } from "../config/providers.ts";
import { characterDataDir, characterWorkspaceDir, rustJoin } from "../config/dirs.ts";
import type { ProviderEntry } from "../llm/credentials.ts";
import { resolveImageGenConfig } from "../llm/image_generate.ts";
import { ensureActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { resolveEmbedder } from "../memory/retrieval.ts";
import { indexPath, type RetrievalConfig } from "../memory/workspace_index.ts";
import { historyIndexPath } from "../memory/history_index.ts";
import type { RetrievalConfig as ConfiguredRetrieval } from "../config/app.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

export interface ToolContextDeps {
  mcpRegistry?: Pick<McpRegistry, "call">;
  runSubagent?: (parent: ToolContext) => NonNullable<ToolContext["runSubagent"]>;
  deferEdit?: (path: string) => Promise<void> | void;
  imageGenerator?: ToolContext["imageGenerator"];
  modelHistoryQuery?: ToolContext["modelHistoryQuery"];
  activityStats?: ToolContext["activityStats"];
  fetchImpl?: typeof fetch;
}

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
  const workspaceDir = characterWorkspaceDir(configDir, charName, config.dirs.workspace);

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
    await ensureActivePromptSnapshot(charDataDir, configDir, charName, config.dirs.workspace);
  } catch (e) {
    console.warn(`shore: failed to prepare active prompt snapshot for ${charName}: ${String(e)}`);
  }

  const mcp = deps.mcpRegistry;
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
    historyIndexPath: historyIndexPath(config.dirs.cache, charName),
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

  if (subagentsConfigured && deps.runSubagent !== undefined) {
    ctx.runSubagent = deps.runSubagent(ctx);
  }
  return ctx;
}

export function providerRecord(
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

export function retrievalView(cfg: ConfiguredRetrieval): RetrievalConfig {
  return {
    maxFileBytes: cfg.max_file_bytes,
    maxIndexedFiles: cfg.max_indexed_files,
    maxTotalIndexedBytes: cfg.max_total_indexed_bytes,
    maxEmbedCharsPerFile: cfg.max_embed_chars_per_file,
    binary: cfg.binary,
  };
}
