import { localWallClock } from "../autonomy/activity.ts";
import { compactionGenerate } from "../autonomy/in_process.ts";
import type { InvalidationReason, LastRequestCache } from "../cache/last_request.ts";
import type { TurnAutonomyBridge } from "../autonomy/registration.ts";
import { CharacterError, type CharacterRegistry } from "../characters.ts";
import type { CommandDeps } from "../commands/dispatch.ts";
import type { ConfigRuntime } from "../commands/config.ts";
import {
  characterConfigDir,
  characterDataDir,
  discoverCharacters,
  rustJoin,
} from "../config/dirs.ts";
import { loadCharacterConfig, loadConfig, type LoadedConfig } from "../config/loader.ts";
import { restartRequiredChanges } from "../config/restart.ts";
import type { Diagnostics } from "../diagnostics.ts";
import {
  newlyCrossedBudgetWarnings,
  usageConfigView,
  type UsageBudgetWarningEvent,
  type UsageConfig,
} from "../ledger/budget.ts";
import { ledgerFor } from "../ledger/record.ts";
import type { SidecarProvider, SidecarRequest } from "../llm/types.ts";
import { queueDeferredEdit } from "../memory/deferred_edits.ts";
import { compactionRunner } from "../memory/compaction/run.ts";
import type { NotificationService } from "../notifications.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import {
  applySubscriptionProviders,
  mcpConfigView,
  sharedToolDeps,
  type ShoreRuntime,
} from "../runtime.ts";
import { McpRegistry } from "../tools/mcp_registry.ts";
import { pluginsDir } from "../config/dirs.ts";
import { historyMessage, type HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";
import { deferEditTo, timeoutFor, toolLimitsFrom, type ToolContext } from "../tools/dispatch.ts";
import { NotImplemented } from "../tools/errors.ts";
import { subagentRunner } from "../tools/subagent_loop.ts";
import {
  SubagentTaskManager,
  subagentResultMessage,
  type SubagentTaskRecord,
} from "../tools/subagent_tasks.ts";
import { makeDispatchCommand, type CommandPathDeps } from "./commands.ts";
import type { DispatchRuntime, ReloadSummary } from "./command_dispatch.ts";
import {
  generationEngine,
  makeRunGeneration,
  type GenerationDeps,
  type GenerationRegistry,
  type SubagentTurn,
} from "./generation.ts";
import { StreamLeases } from "./lease.ts";
import type {
  GenerationParams,
  HandlerNotifier,
  HandlerRegistry,
  MessageHandlerDeps,
  RunGeneration,
} from "./router.ts";
import type { ToolContextDeps } from "./tool_context.ts";
import { indexPath as workspaceIndexPath } from "../memory/workspace_index.ts";

export interface GenerationAssembly {
  runtime: ShoreRuntime;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  autonomy: TurnAutonomyBridge;
  emitEvent: (message: ServerMessage) => void;
  diagnostics: Diagnostics;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
  subagentTasks?: SubagentTaskManager | undefined;
}

export function buildGenerationDeps(a: GenerationAssembly): GenerationDeps {
  const { runtime } = a;
  const dataDir = runtime.config.dirs.data;
  const ledgerPath = rustJoin(dataDir, "ledger.db");
  const global = () => runtime.registry.globalConfig();
  const usage = (character: string) =>
    usageConfigView(runtime.registry.effectiveConfig(character).app.usage);

  return {
    registry: generationRegistry(runtime.registry),
    dataDir,
    providers: a.providers,
    ...(runtime.callStore === undefined ? {} : { callStore: runtime.callStore }),
    autonomy: turnAutonomy(a.autonomy, runtime.cache),
    notifier: runtime.notifier,
    diagnostics: a.diagnostics,
    emitEvent: a.emitEvent,
    mcpRegistry: {
      toolDefsFiltered: (patterns) => runtime.mcp.current.toolDefsFiltered(patterns),
      ...runtime.mcp.callView(),
    },
    compaction: chatCompactionRunner(a),
    newlyCrossedUsageBudgetWarnings: usageBudgetWarnings(ledgerPath, usage, a.now),
    ledgerPath,
    keepaliveMaxSecs: () =>
      Number(global().app.cache.keepalive_max.asSecs()),
    tools: (charName, turn) => chatToolDeps(a, charName, turn),
    ...(a.env === undefined ? {} : { env: a.env }),
  };
}

export function generationRegistry(registry: CharacterRegistry): GenerationRegistry {
  return {
    getOrCreate: async (name) => generationEngine(await registry.getOrCreate(name)),
    effectiveConfig: (name) => registry.effectiveConfig(name),
  };
}

export function turnAutonomy(
  bridge: TurnAutonomyBridge,
  cache: Pick<LastRequestCache, "set">,
): GenerationDeps["autonomy"] {
  return {
    ensureState: (character, config) => bridge.ensureState(character, config),
    needsActivityBackfill: (character) => bridge.needsActivityBackfill(character),
    backfillActivity: (character, timestamps) => {
      bridge.backfillActivity(character, timestamps);
    },
    onUserMessage: (character, turnCount) => {
      bridge.onUserMessage(character, turnCount);
    },
    shouldCompactNow: (character, turnCount, contextTokens) =>
      bridge.shouldCompactNow(character, turnCount, contextTokens),
    onCompactionComplete: (character, retained) => {
      bridge.onCompactionComplete(character, retained);
    },
    onCompactionFailed: (character, retryAt) => {
      bridge.onCompactionFailed(character, retryAt);
    },
    notifyAssistantMessage: (character, turnCount) => {
      bridge.onAssistantMessage(character, turnCount);
    },
    notifyLastRequest: (character, request, keepaliveIntervalMs) => {
      cache.set(character, request as SidecarRequest, keepaliveIntervalMs);
    },
  };
}

export type ToolAssembly = Pick<
  GenerationAssembly,
  "runtime" | "providers" | "diagnostics" | "env" | "subagentTasks"
>;

export function chatToolDeps(
  a: ToolAssembly,
  charName: string,
  turn: SubagentTurn,
): ToolContextDeps {
  const { runtime } = a;
  const subagentDeps = (parent: ToolContext, taskId?: string) => ({
    config: runtime.registry.effectiveConfig(charName),
    ctx: parent,
    providers: a.providers,
    ...(runtime.callStore === undefined ? {} : { callStore: runtime.callStore }),
    mcpRegistry: runtime.mcp.current,
    sendDirect: turn.send,
    conversation: turn.conversation,
    ...(a.env === undefined ? {} : { env: a.env }),
    ...(turn.rid === undefined ? {} : { rid: turn.rid }),
    now: turn.now,
    newMessageId: turn.newMessageId,
    ...(taskId === undefined ? {} : { taskId }),
  });
  return {
    ...sharedToolDeps(runtime.config, runtime.mcp),
    runSubagent: (parent: ToolContext) => subagentRunner(subagentDeps(parent)),
    ...(a.subagentTasks === undefined
      ? {}
      : {
          startSubagent: (parent: ToolContext) => (name: string, query: string, toolUseId?: string) => {
            const config = runtime.registry.effectiveConfig(charName);
            if (!config.app.subagents.has(name)) throw new NotImplemented(`ask_${name}`);
            const tasks = a.subagentTasks;
            if (tasks === undefined) throw new NotImplemented(`ask_${name}`);
            return tasks.start({
              character: charName,
              name,
              query,
              timeoutMs: timeoutFor(
                toolLimitsFrom(config.app.tools, config.app.subagents),
                `ask_${name}`,
              ),
              run: async (task, signal) =>
                await subagentRunner(subagentDeps(parent, task.id))(name, query, signal, toolUseId),
            });
          },
        }),
    deferEdit: deferEditTo(
      characterDataDir(runtime.config.dirs.data, charName),
      queueDeferredEdit,
    ),
    activityStats: (days: number) => {
      const report = runtime.autonomy.activityStats(
        charName,
        localWallClock(Date.now()),
        days,
      );
      return report === undefined
        ? undefined
        : { stats: report.stats, turnCount: report.messageCount };
    },
  };
}

export function chatCompactionRunner(a: GenerationAssembly): GenerationDeps["compaction"] {
  const { runtime } = a;
  return compactionRunner({
    generate: compactionGenerate({
      providers: a.providers,
      config: runtime.config,
      ...(a.env === undefined ? {} : { env: a.env }),
    }),
    cache: runtime.cache,
    rebuild: { mcpRegistry: runtime.mcp.current },
    tools: sharedToolDeps(runtime.config, runtime.mcp),
  });
}

export function usageBudgetWarnings(
  ledgerPath: string,
  usage: (character: string) => UsageConfig | undefined,
  now: (() => number) | undefined,
): (character: string) => Promise<UsageBudgetWarningEvent[]> {
  const clock = now ?? (() => Date.now());
  return (character) => {
    const config = usage(character);
    if (config === undefined || (config.budgets ?? []).length === 0) {
      return Promise.resolve([]);
    }
    const ledger = ledgerFor(ledgerPath);
    if (ledger === null) return Promise.resolve([]);
    return Promise.resolve(newlyCrossedBudgetWarnings(ledger.database, config, clock()));
  };
}

export interface HandlerAssembly
  extends Omit<GenerationAssembly, "emitEvent">,
    Omit<CommandAssembly, "runtime" | "autonomy" | "diagnostics" | "providers" | "env"> {
  runtime: ShoreRuntime;
  emitEvent: (message: ServerMessage) => void;
  log?: MessageHandlerDeps["log"];
}

function beginIndexForeground(a: HandlerAssembly): () => void {
  const endHistory = a.runtime.historyIndex.beginForeground();
  const endWorkspace = a.runtime.workspaceIndex.beginForeground();
  return () => {
    endHistory();
    endWorkspace();
  };
}

export function buildMessageHandlerDeps(a: HandlerAssembly): MessageHandlerDeps {
  const leases = new StreamLeases();

  async function runGenerationInForeground(params: GenerationParams): Promise<void> {
    const endForeground = beginIndexForeground(a);
    try {
      await runGeneration(params);
    } finally {
      endForeground();
    }
  }

  const subagentTasks = new SubagentTaskManager({
    emit: a.emitEvent,
    log: (msg) => {
      a.log?.info?.(msg);
    },
    onSettled: (task) => deliverSubagentResult(a, leases, runGenerationInForeground, task),
  });

  const runGeneration = makeRunGeneration(buildGenerationDeps({ ...a, subagentTasks }));
  const dispatchCommand = makeDispatchCommand(buildCommandPathDeps(a));
  return {
    router: a.router,
    leases,
    registry: handlerRegistry(a.runtime.registry),
    notifier: handlerNotifier(a.runtime.notifier),
    subagentTasks,
    dispatchCommand: async (command, meta) => {
      const endForeground = beginIndexForeground(a);
      try {
        return await dispatchCommand(command, meta);
      } finally {
        endForeground();
      }
    },
    runGeneration: runGenerationInForeground,
    ...(a.log === undefined ? {} : { log: a.log }),
  };
}

async function deliverSubagentResult(
  a: HandlerAssembly,
  leases: StreamLeases,
  runGeneration: RunGeneration,
  task: SubagentTaskRecord,
): Promise<void> {
  const leaseSend = leases.sendForCharacter(task.character, a.router);
  const send: (message: ServerMessage) => Promise<void> =
    leaseSend === undefined
      ? async () => {}
      : async (message) => {
          try {
            await leaseSend(message);
          } catch {
          }
        };

  await runGeneration({
    meta: {
      session: {
        clientId: -1,
        sessionId: -1,
        clientType: "daemon",
        clientName: "subagent-tasks",
        capabilities: [],
        selectedCharacter: task.character,
      },
      rid: null,
      kind: "message",
    },
    body: {
      rid: null,
      text: subagentResultMessage(task),
      stream: true,
      images: [],
      image_data: [],
    },
    regen: false,
    charName: task.character,
    rid: null,
    send,
    signal: new AbortController().signal,
  });
}

export function handlerRegistry(
  registry: Pick<CharacterRegistry, "resolveCharacter">,
): HandlerRegistry {
  return {
    resolveCharacter: (selected) => {
      try {
        return { name: registry.resolveCharacter(selected ?? undefined) };
      } catch (e) {
        return { error: e instanceof CharacterError ? e.message : String(e) };
      }
    },
  };
}

export function handlerNotifier(
  notifier: Pick<NotificationService, "notify">,
): HandlerNotifier {
  return {
    notify: (event, title, body) => {
      notifier.notify(event, title, body);
    },
  };
}

export interface CommandAssembly {
  runtime: ShoreRuntime;
  autonomy: TurnAutonomyBridge;
  diagnostics: Diagnostics;
  router: SessionRouter;
  handshake: HandshakeProvider;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  env?: NodeJS.ProcessEnv | undefined;
}

export function buildCommandPathDeps(a: CommandAssembly): CommandPathDeps {
  const { runtime } = a;
  return {
    registry: runtime.registry,
    globalConfig: () => runtime.registry.globalConfig(),
    configPath: runtime.configPath,
    dataDir: runtime.config.dirs.data,
    commands: commandDeps(a),
    runtime: configRuntime(a),
    dispatchRuntime: dispatchRuntime(a),
    router: a.router,
    handshake: a.handshake,
    ...(a.env === undefined ? {} : { env: a.env }),
  };
}

function configRuntime(a: CommandAssembly): ConfigRuntime {
  const { runtime } = a;
  return {
    reloadRuntimeConfig: () => {
      a.autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));
    },
    setUsageConfig: () => {},
    setCacheKeepaliveCeiling: () => {},
    notifyPromptSnapshotRefreshed: (character) => {
      runtime.cache.invalidate(character, "prompt_reload");
      void runtime.cache
        .reprimeFromDisk(character, runtime.config.dirs.data, runtime.registry.effectiveConfig(character), {
          mcpRegistry: runtime.mcp.current,
        })
        .catch((e: unknown) => {
          console.warn(`shore: keepalive reprime failed for ${character}: ${String(e)}`);
        });
    },
  };
}

function dispatchRuntime(a: CommandAssembly): DispatchRuntime {
  const { runtime } = a;
  return {
    globalConfig: () => runtime.registry.globalConfig(),

    reloadGlobalConfig: () => {
      try {
        return loadConfig(runtime.configPath, a.env === undefined ? {} : { env: a.env });
      } catch (e) {
        console.warn(`shore: could not re-read ${runtime.configPath}: ${String(e)}`);
        return undefined;
      }
    },

    setEffectiveConfig: (character, config) => {
      runtime.registry.setRuntimeEffectiveConfig(character, config);
      return Promise.resolve();
    },

    reloadRuntimeConfig: () => {
      a.autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));
    },

    applyReloadedConfig: async (config) => await applyReloadedConfig(a, config),
  };
}

export async function applyReloadedConfig(
  a: CommandAssembly,
  config: LoadedConfig,
): Promise<ReloadSummary> {
  const summary = await a.runtime.registry.reloadRuntimeState(config);
  applySubscriptionProviders(a.runtime.registry);
  await a.runtime.refreshHistoryIndexes();
  await reconnectMcpIfChanged(a, config);
  a.autonomy.reloadConfig((name) => a.runtime.registry.effectiveConfig(name));
  await pushHistorySnapshots(a);
  return {
    characterDiscoveryChanged: summary.characterDiscoveryChanged,
    droppedEngines: summary.droppedEngines,
  };
}

async function reconnectMcpIfChanged(a: CommandAssembly, config: LoadedConfig): Promise<void> {
  const servers = mcpConfigView(config);
  if (a.runtime.mcp.current.matchesConfig(servers)) return;

  let next: McpRegistry;
  try {
    next = await McpRegistry.fromConfig(
      servers,
      pluginsDir(config.dirs.data),
      a.runtime.connectMcp,
    );
  } catch (e) {
    console.error(`shore: [mcp] reload failed, keeping the running servers: ${String(e)}`);
    return;
  }

  if (Object.keys(servers).length > 0 && next.connectedServers() === 0) {
    console.error(
      "shore: [mcp] reload connected none of the configured servers; " +
        "keeping the running ones",
    );
    await next.shutdown();
    return;
  }

  const previous = a.runtime.mcp.replace(next);
  try {
    await previous.shutdown();
  } catch (e) {
    console.warn(`shore: shutting down the previous MCP registry failed: ${String(e)}`);
  }
  await repointCachedRequests(a, config, "mcp_reload");
  console.info("shore: [mcp] changed; reconnected servers and swapped the tool surface");
}

async function repointCachedRequests(
  a: CommandAssembly,
  config: LoadedConfig,
  reason: InvalidationReason,
): Promise<void> {
  const { runtime } = a;
  for (const character of runtime.cache.cachedCharacters()) {
    runtime.cache.invalidate(character, reason);
    try {
      await runtime.cache.reprimeFromDisk(
        character,
        config.dirs.data,
        runtime.registry.effectiveConfig(character),
        { mcpRegistry: runtime.mcp.current },
      );
    } catch (e) {
      console.warn(`shore: keepalive reprime failed for ${character}: ${String(e)}`);
    }
  }
}

export interface ConfigReloadAssembly extends CommandAssembly {
  emitEvent: (message: ServerMessage) => void;
}

export function configWarning(
  path: string,
  character: string | undefined,
  cause: unknown,
): ServerMessage {
  return {
    type: "config_warning",
    path,
    ...(character === undefined ? {} : { character }),
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

export function configReloader(
  a: ConfigReloadAssembly,
): (changedPaths: readonly string[]) => Promise<void> {
  return async (changedPaths) => {
    const where = `${a.runtime.configPath} (changed: ${changedPaths.join(", ")})`;

    let config: LoadedConfig;
    try {
      config = loadConfig(a.runtime.configPath, a.env === undefined ? {} : { env: a.env });
    } catch (e) {
      console.warn(
        `shore: config hot reload failed, keeping the running config — ${where}: ${String(e)}`,
      );
      a.emitEvent(configWarning(a.runtime.configPath, undefined, e));
      return;
    }

    for (const name of discoverCharacters(config.dirs.config, config.dirs.workspace)) {
      try {
        loadCharacterConfig(config, name);
      } catch (e) {
        console.warn(
          `shore: config hot reload failed on ${name}'s overlay, keeping the running config — ` +
            `${where}: ${String(e)}`,
        );
        a.emitEvent(
          configWarning(rustJoin(characterConfigDir(config.dirs.config, name), "config.toml"), name, e),
        );
        return;
      }
    }

    const restart = restartRequiredChanges(a.runtime.registry.globalConfig(), config);
    if (restart.length > 0) {
      console.warn(
        `shore: config hot reload saw startup-owned changes (${restart.join(", ")}); ` +
          `restart the daemon to apply them`,
      );
    }

    await applyReloadedConfig(a, config);
    console.info(`shore: config hot reload applied — ${where}`);
  };
}

async function pushHistorySnapshots(a: CommandAssembly): Promise<void> {
  for (const [sessionId, character] of a.router.sessions()) {
    if (character === null) continue;
    try {
      const snapshot = await a.handshake.history(character);
      await a.router.sendToSession(sessionId, historyMessage(snapshot, undefined));
    } catch (e) {
      console.warn(`shore: could not push history to session ${sessionId}: ${String(e)}`);
    }
  }
}

function commandDeps(a: CommandAssembly): CommandDeps {
  const { runtime } = a;
  const ledgerPath = rustJoin(runtime.config.dirs.data, "ledger.db");
  return {
    autonomy: runtime.autonomy,
    diagnostics: a.diagnostics,
    callStore: runtime.callStore,
    ledgerPath,
    compaction: {
      run: {
        generate: compactionGenerate({
          providers: a.providers,
          config: runtime.config,
          ...(a.env === undefined ? {} : { env: a.env }),
        }),
        tools: sharedToolDeps(runtime.config, runtime.mcp),
      },
      repoint: async (character, config) => {
        runtime.cache.invalidate(character, "compaction");
        await runtime.cache.reprimeFromDisk(character, config.dirs.data, config, {
          mcpRegistry: runtime.mcp.current,
        });
      },
    },
    keepalive: {
      keepalive: runtime.keepalive,
      lastRequest: runtime.cache,
      rebuild: { mcpRegistry: runtime.mcp.current },
    },
    activate: {
      register: async (character, config) => {
        const created = a.autonomy.ensureState(character, config);
        await a.autonomy.settled(character);
        return created;
      },
    },
    runTool: {
      tools: (charName, turn) => chatToolDeps(a, charName, turn),
      mcpTools: () => runtime.mcp.current.allTools(),
    },
    workspaceIndex: {
      indexPathFor: (character) => {
        if (!runtime.registry.hasCharacter(character)) return undefined;
        return workspaceIndexPath(runtime.registry.effectiveConfig(character).dirs.cache, character);
      },
      progressFor: (character) => runtime.workspaceIndex.progress(character),
    },
  };
}
