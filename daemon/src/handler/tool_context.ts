import { characterMediaDir } from "../storage/media.ts";
import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import type { ProviderEntry as RegistryEntry } from "../config/providers.ts";
import {
  characterDataDir,
  characterWorkspaceDir,
  rustJoin,
  threadDataDir,
  MAIN_THREAD,
} from "../config/dirs.ts";
import { HISTORY_DB_FILE } from "../engine/history_store.ts";
import type { ProviderEntry } from "../llm/credentials.ts";
import { resolveImageGenConfig } from "../llm/image_generate.ts";
import { resolveEmbedder } from "../memory/retrieval.ts";
import { indexPath, type RetrievalConfig } from "../memory/workspace_index.ts";
import { historyIndexPath } from "../memory/history_index.ts";
import type { RetrievalConfig as ConfiguredRetrieval } from "../config/app.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { ActivityStatsLookup } from "../tools/activity.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";
import type { Message } from "../engine/types.ts";

export interface ToolConversation {
  thread: string;
  conversation: readonly Message[];
}

export interface ToolContextDeps extends Partial<ToolConversation> {
  dryRun?: boolean;
  signal?: AbortSignal;
  mcpRegistry?: Pick<McpRegistry, "call">;
  mcpToolDefs?: McpRegistry["toolDefsFiltered"];
  runSubagent?: (parent: ToolContext) => NonNullable<ToolContext["runSubagent"]>;
  deferEdit?: (path: string) => Promise<void> | void;
  imageGenerator?: ToolContext["imageGenerator"];
  modelHistoryQuery?: ToolContext["modelHistoryQuery"];
  activityStats?: (character: string, days: number) => ReturnType<ActivityStatsLookup>;
  scheduleNextWake?: (character: string, hoursFromNow: number, reason: string) => number | undefined;
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
    imageGen: Object.fromEntries([...config.models.imageGeneration].map(([name, settings]) => {
      const { aspectRatio, imageSize, ...rest } = settings;
      return [name, {
        ...rest,
        ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
        ...(imageSize === undefined ? {} : { image_size: imageSize }),
      }];
    })),
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
    shoreLog.warn(
      `shore: embedder unavailable for ${charName}; semantic memory retrieval disabled: ${String(e)}`,
    );
  }

  const mcp = deps.mcpRegistry;
  const activityStats = deps.activityStats;
  const scheduleNextWake = deps.scheduleNextWake;
  const subagentsConfigured = config.app.subagents.size > 0;

  const ctx: ToolContext = {
    thread: deps.thread ?? MAIN_THREAD,
    conversation: deps.conversation ?? [],
    ...(deps.dryRun === undefined ? {} : { dryRun: deps.dryRun }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    imageDir: characterMediaDir(dataDir, charName),
    workspaceDir,
    characterDataDir: charDataDir,
    conversationDir: threadDataDir(dataDir, charName, deps.thread ?? MAIN_THREAD),
    historyDbPath: rustJoin(dataDir, HISTORY_DB_FILE),
    characterName: charName,
    configDir,
    retrievalConfig: retrievalView(config.app.memory.retrieval),
    retrievalMode: config.app.memory.retrieval.mode,
    memoryIndexPath: indexPath(config.dirs.cache, charName),
    historyIndexPath: historyIndexPath(config.dirs.cache, charName),
    ...("ok" in imageGen ? { imageGenConfig: imageGen.ok } : {}),
    ...(deps.imageGenerator === undefined ? {} : { imageGenerator: deps.imageGenerator }),
    ...(deps.modelHistoryQuery === undefined ? {} : { modelHistoryQuery: deps.modelHistoryQuery }),
    ...(activityStats === undefined ? {} : { activityStats: (days: number) => activityStats(charName, days) }),
    ...(scheduleNextWake === undefined
      ? {}
      : { scheduleNextWake: (hours: number, reason: string) => scheduleNextWake(charName, hours, reason) }),
    ...(embedder === undefined ? {} : { embedder }),
    ...(deps.deferEdit === undefined ? {} : { deferEdit: deps.deferEdit }),
    ...(mcp === undefined
      ? {}
      : {
          mcpCall: (name: string, input: unknown, signal?: AbortSignal) =>
            mcp.call(name, input, signal),
        }),
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
