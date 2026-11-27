import type { PushOutcome } from "../autonomy/push.ts";
import type { TriggersView } from "../autonomy/trigger_loop.ts";

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
import { historyIndexPath } from "../memory/history_index.ts";
import { resolveDisplayName } from "../config/app.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import { guideValues, readGuide } from "../tools/guide.ts";
import { ALL_TOOLS, toolEnabled } from "../tools/registry.ts";
import type { ActivityStatsLookup } from "../tools/activity.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";
import type { Message } from "../engine/types.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import type { StartedSealedThread } from "../tools/start_sealed_thread.ts";
import type { StartThreadRequest } from "../tools/start_thread.ts";
import type { WakeHandOff, WakeInThreadRequest } from "../tools/wake_in_thread.ts";
import type { EditThreadRequest } from "../tools/edit_thread.ts";
import type { ThreadRecord } from "../engine/threads.ts";
import { Texts } from "../texts/texts.ts";

export interface ToolConversation {
  thread: string;
  conversation: readonly Message[];
  recordWorkspaceWrite?: ToolContext["recordWorkspaceWrite"];
  sendMessage?: ToolContext["sendMessage"];
}

export interface ToolContextDeps extends Partial<ToolConversation> {
  fresh?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  mcpRegistry?: Pick<McpRegistry, "call">;
  mcpToolDefs?: McpRegistry["toolDefsFiltered"];
  runSubagent?: (parent: ToolContext) => NonNullable<ToolContext["runSubagent"]>;
  deferEdit?: (path: string) => Promise<void> | void;
  modelHistoryQuery?: ToolContext["modelHistoryQuery"];
  activityStats?: (character: string, days: number) => ReturnType<ActivityStatsLookup>;
  triggersView?: (character: string) => Promise<TriggersView>;
  push?: (character: string, message: string) => Promise<PushOutcome>;
  wakeInThread?: (character: string, from: string, request: WakeInThreadRequest) => WakeHandOff;
  startThread?: (character: string, request: StartThreadRequest) => Promise<void>;
  sealThread?: (character: string, request: NewSealedThread) => Promise<StartedSealedThread>;
  editThread?: (character: string, request: EditThreadRequest) => Promise<ThreadRecord | undefined>;
}

export async function buildToolContext(
  config: LoadedConfig,
  dataDir: string,
  charName: string,
  deps: ToolContextDeps = {},
): Promise<ToolContext> {
  const charDataDir = characterDataDir(dataDir, charName);
  const configDir = config.dirs.config;
  const workspace = characterWorkspace(config, charName);

  const mcp = deps.mcpRegistry;
  const activityStats = deps.activityStats;
  const triggersView = deps.triggersView;
  const wakeInThread = deps.wakeInThread;
  const startThread = deps.startThread;
  const sealThread = deps.sealThread;
  const editThread = deps.editThread;
  const subagentsConfigured = config.app.subagents.agents.size > 0;
  const userName = resolveDisplayName(config.app.chat);

  const texts = Texts.of(config);
  const ctx: ToolContext = {
    texts,
    thread: deps.thread ?? MAIN_THREAD,
    conversation: deps.conversation ?? [],
    ...(deps.fresh === undefined ? {} : { fresh: deps.fresh }),
    ...(deps.dryRun === undefined ? {} : { dryRun: deps.dryRun }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    images: config.app.images,
    cacheDir: config.dirs.cache,
    workspaceDir: workspace.dir,
    workspace,
    characterDataDir: charDataDir,
    conversationDir: threadDataDir(dataDir, charName, deps.thread ?? MAIN_THREAD),
    historyDbPath: rustJoin(dataDir, HISTORY_DB_FILE),
    characterName: charName,
    configDir,
    historyIndexPath: historyIndexPath(config.dirs.cache, charName),
    userName,
    guide: (input) => readGuide(texts, input, guideValues(config, userName), ALL_TOOLS.map((tool) => ({ name: tool.name, enabled: toolEnabled(config.app.tools, tool.name) }))),
    ...(deps.modelHistoryQuery === undefined ? {} : { modelHistoryQuery: deps.modelHistoryQuery }),
    ...(activityStats === undefined ? {} : { activityStats: (days: number) => activityStats(charName, days) }),
    ...(triggersView === undefined ? {} : { triggers: () => triggersView(charName) }),
    ...(deps.sendMessage === undefined ? {} : { sendMessage: deps.sendMessage }),
    ...(wakeInThread === undefined ? {} : { wakeInThread: (request: WakeInThreadRequest) => wakeInThread(charName, deps.thread ?? MAIN_THREAD, request) }),
    ...(deps.deferEdit === undefined ? {} : { deferEdit: deps.deferEdit }),
    ...(startThread === undefined
      ? {}
      : { startThread: (request: StartThreadRequest) => startThread(charName, request) }),
    ...(sealThread === undefined ? {} : { sealThread: async (request: NewSealedThread) => await sealThread(charName, request) }),
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

export function credentialEntry(entry: RegistryEntry): ProviderEntry {
  return toCredentialsEntry(entry);
}
