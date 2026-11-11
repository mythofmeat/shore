import type { PushOutcome } from "../autonomy/push.ts";
import type { TriggersView } from "../autonomy/trigger_loop.ts";
import { characterMediaDir } from "../storage/media.ts";
import { shoreLog } from "../log.ts";
import { recordWorkspaceRead } from "../memory/dreaming/reads.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { toCredentialsEntry, type ProviderEntry as RegistryEntry } from "../config/providers.ts";
import {
  characterDataDir,
  rustJoin,
  threadDataDir,
  MAIN_THREAD,
} from "../config/dirs.ts";
import { HISTORY_DB_FILE } from "../engine/history_store.ts";
import type { ProviderEntry } from "../llm/credentials.ts";
import { resolveImageGenConfig } from "../llm/image_generate.ts";
import { historyIndexPath } from "../memory/history_index.ts";
import { resolveDisplayName } from "../config/app.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { ActivityStatsLookup } from "../tools/activity.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";
import type { Message } from "../engine/types.ts";
import type { StartThreadRequest } from "../tools/start_thread.ts";
import type { EditThreadRequest } from "../tools/edit_thread.ts";
import type { ThreadRecord } from "../engine/threads.ts";

export interface ToolConversation {
  thread: string;
  conversation: readonly Message[];
  recordWorkspaceWrite?: ToolContext["recordWorkspaceWrite"];
}

export interface ToolContextDeps extends Partial<ToolConversation> {
  dryRun?: boolean;
  countReads?: boolean;
  signal?: AbortSignal;
  mcpRegistry?: Pick<McpRegistry, "call">;
  mcpToolDefs?: McpRegistry["toolDefsFiltered"];
  runSubagent?: (parent: ToolContext) => NonNullable<ToolContext["runSubagent"]>;
  deferEdit?: (path: string) => Promise<void> | void;
  imageGenerator?: ToolContext["imageGenerator"];
  modelHistoryQuery?: ToolContext["modelHistoryQuery"];
  activityStats?: (character: string, days: number) => ReturnType<ActivityStatsLookup>;
  scheduleNextWake?: (character: string, hoursFromNow: number, reason: string) => number | undefined;
  triggersView?: (character: string) => TriggersView;
  push?: (character: string, message: string) => Promise<PushOutcome>;
  startThread?: (character: string, request: StartThreadRequest) => Promise<void>;
  editThread?: (character: string, request: EditThreadRequest) => Promise<ThreadRecord | undefined>;
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
  const workspace = characterWorkspace(config, charName);

  const mcp = deps.mcpRegistry;
  const activityStats = deps.activityStats;
  const scheduleNextWake = deps.scheduleNextWake;
  const triggersView = deps.triggersView;
  const push = deps.push;
  const startThread = deps.startThread;
  const editThread = deps.editThread;
  const subagentsConfigured = config.app.subagents.size > 0;

  const ctx: ToolContext = {
    thread: deps.thread ?? MAIN_THREAD,
    conversation: deps.conversation ?? [],
    shownPictures: [],
    ...(deps.dryRun === undefined ? {} : { dryRun: deps.dryRun }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    images: config.app.images,
    imageDir: characterMediaDir(dataDir, charName),
    cacheDir: config.dirs.cache,
    workspaceDir: workspace.dir,
    workspace,
    characterDataDir: charDataDir,
    conversationDir: threadDataDir(dataDir, charName, deps.thread ?? MAIN_THREAD),
    historyDbPath: rustJoin(dataDir, HISTORY_DB_FILE),
    characterName: charName,
    configDir,
    historyIndexPath: historyIndexPath(config.dirs.cache, charName),
    userName: resolveDisplayName(config.app.defaults),
    ...("ok" in imageGen ? { imageGenConfig: imageGen.ok } : {}),
    ...(deps.imageGenerator === undefined ? {} : { imageGenerator: deps.imageGenerator }),
    ...(deps.modelHistoryQuery === undefined ? {} : { modelHistoryQuery: deps.modelHistoryQuery }),
    ...(activityStats === undefined ? {} : { activityStats: (days: number) => activityStats(charName, days) }),
    ...(scheduleNextWake === undefined
      ? {}
      : { scheduleNextWake: (hours: number, reason: string) => scheduleNextWake(charName, hours, reason) }),
    ...(triggersView === undefined ? {} : { triggers: () => triggersView(charName) }),
    ...(push === undefined ? {} : { push: async (message: string) => await push(charName, message) }),
    ...(deps.deferEdit === undefined ? {} : { deferEdit: deps.deferEdit }),
    ...(deps.countReads === true && config.app.memory.dreaming.enabled ? { recordRead: (path: string) => { recordReadBestEffort(charDataDir, path); } } : {}),
    ...(startThread === undefined
      ? {}
      : { startThread: (request: StartThreadRequest) => startThread(charName, request) }),
    ...(editThread === undefined
      ? {}
      : { editThread: (request: EditThreadRequest) => editThread(charName, request) }),
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

function recordReadBestEffort(charDataDir: string, path: string): void {
  try {
    recordWorkspaceRead(charDataDir, path);
  } catch (e) {
    shoreLog.warn(`shore: could not count a read of ${path}: ${String(e)}`);
  }
}

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

export function credentialEntry(entry: RegistryEntry): ProviderEntry {
  return toCredentialsEntry(entry);
}
