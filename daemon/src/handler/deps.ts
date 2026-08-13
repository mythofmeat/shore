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
import { mcpConfigView, sharedToolDeps, type ShoreRuntime } from "../runtime.ts";
import { McpRegistry } from "../tools/mcp_registry.ts";
import { pluginsDir } from "../config/dirs.ts";
import { historyMessage, type HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";
import { deferEditTo, type ToolContext } from "../tools/dispatch.ts";
import { subagentRunner } from "../tools/subagent_loop.ts";
import { makeDispatchCommand, type CommandPathDeps, type SessionCache } from "./commands.ts";
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
  HandlerNotifier,
  HandlerRegistry,
  MessageHandlerDeps,
} from "./router.ts";
import type { SessionTokens } from "./persistence.ts";
import type { ToolContextDeps } from "./tool_context.ts";

export interface GenerationAssembly {
  runtime: ShoreRuntime;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  autonomy: TurnAutonomyBridge;
  emitEvent: (message: ServerMessage) => void;
  sessionTokens: SessionTokens;
  diagnostics: Diagnostics;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
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
    sessionTokens: a.sessionTokens,
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

export function chatToolDeps(
  a: GenerationAssembly,
  charName: string,
  turn: SubagentTurn,
): ToolContextDeps {
  const { runtime } = a;
  return {
    ...sharedToolDeps(runtime.config, runtime.mcp),
    runSubagent: (parent: ToolContext) =>
      subagentRunner({
      config: runtime.registry.effectiveConfig(charName),
      ctx: parent,
      providers: a.providers,
      ...(runtime.callStore === undefined ? {} : { callStore: runtime.callStore }),
      mcpRegistry: runtime.mcp.current,
      sendDirect: turn.send,
      diagnostics: a.diagnostics.tool_calls,
      conversation: turn.conversation,
      ...(a.env === undefined ? {} : { env: a.env }),
      ...(turn.rid === undefined ? {} : { rid: turn.rid }),
      now: turn.now,
      newMessageId: turn.newMessageId,
      }),
    deferEdit: deferEditTo(
      characterDataDir(runtime.config.dirs.data, charName),
      queueDeferredEdit,
    ),
    activityStats: () => {
      const report = runtime.autonomy.activityStats(charName, Date.now());
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
    Omit<CommandAssembly, "runtime" | "autonomy" | "sessionTokens" | "diagnostics" | "providers" | "env"> {
  runtime: ShoreRuntime;
  emitEvent: (message: ServerMessage) => void;
  log?: MessageHandlerDeps["log"];
}

export function buildMessageHandlerDeps(a: HandlerAssembly): MessageHandlerDeps {
  return {
    router: a.router,
    leases: new StreamLeases(),
    registry: handlerRegistry(a.runtime.registry),
    notifier: handlerNotifier(a.runtime.notifier),
    dispatchCommand: makeDispatchCommand(buildCommandPathDeps(a)),
    runGeneration: makeRunGeneration(buildGenerationDeps(a)),
    ...(a.log === undefined ? {} : { log: a.log }),
  };
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
  sessionTokens: SessionTokens;
  diagnostics: Diagnostics;
  router: SessionRouter;
  handshake: HandshakeProvider;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  env?: NodeJS.ProcessEnv | undefined;
}

export function buildCommandPathDeps(a: CommandAssembly): CommandPathDeps {
  const { runtime } = a;
  const sessions = new ProcessSessionCache();
  return {
    registry: runtime.registry,
    globalConfig: () => runtime.registry.globalConfig(),
    configPath: runtime.configPath,
    dataDir: runtime.config.dirs.data,
    sessions,
    commands: commandDeps(a),
    runtime: configRuntime(a),
    dispatchRuntime: dispatchRuntime(a, sessions),
    router: a.router,
    handshake: a.handshake,
    ...(a.env === undefined ? {} : { env: a.env }),
  };
}

class ProcessSessionCache implements SessionCache {
  readonly #models = new Map<string, string>();

  static #key(sessionId: number, character: string | undefined): string {
    return `${sessionId} ${character ?? ""}`;
  }

  activeModel(sessionId: number, character: string | undefined): string | undefined {
    return this.#models.get(ProcessSessionCache.#key(sessionId, character));
  }

  setActiveModel(sessionId: number, character: string | undefined, model: string | undefined): void {
    const key = ProcessSessionCache.#key(sessionId, character);
    if (model === undefined) this.#models.delete(key);
    else this.#models.set(key, model);
  }

  clear(): void {
    this.#models.clear();
  }
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

function dispatchRuntime(
  a: CommandAssembly,
  sessions: ProcessSessionCache,
): DispatchRuntime {
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

    clearActiveModel: () => {
      sessions.clear();
    },
  };
}

export async function applyReloadedConfig(
  a: CommandAssembly,
  config: LoadedConfig,
): Promise<ReloadSummary> {
  const summary = await a.runtime.registry.reloadRuntimeState(config);
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
    sessionTokens: a.sessionTokens,
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
  };
}
