import { shoreLog } from "./log.ts";

import { mkdirSync } from "node:fs";

import { InProcessAutonomyExecutor } from "./autonomy/in_process.ts";
import { KeepaliveService, startKeepaliveTimer } from "./cache/keepalive.ts";
import { LastRequestCache } from "./cache/last_request.ts";
import { AutonomyService, startAutonomyTimer } from "./autonomy/service.ts";
import { CallStore } from "./call_store.ts";
import { CharacterRegistry } from "./characters.ts";
import { characterDataDir, characterWorkspaceDir, pluginsDir, rustJoin } from "./config/dirs.ts";
import { loadConfig, type LoadedConfig } from "./config/loader.ts";
import type { HistoryListener } from "./engine/conversation.ts";
import type { Message } from "./engine/types.ts";
import type { SubagentTurn } from "./handler/generation.ts";
import type { ToolContextDeps } from "./handler/tool_context.ts";
import { providerRecord, retrievalView } from "./handler/tool_context.ts";
import { Diagnostics } from "./diagnostics.ts";
import type { ToolContext } from "./tools/dispatch.ts";
import { subagentRunner } from "./tools/subagent_loop.ts";
import { Ledger } from "./ledger/store.ts";
import { backfillLedgerCosts } from "./ledger/usage.ts";
import { setSubscriptionProviders } from "./ledger/store.ts";
import { DEFAULT_SUBSCRIPTION_PROVIDERS } from "./config/providers.ts";
import { ledgerFor } from "./ledger/record.ts";
import { setCallObserver } from "./ledger/record.ts";
import { modelUsageSummary } from "./ledger/query.ts";
import { captureProviders } from "./llm/capture.ts";
import { withResolvedCredential } from "./llm/generate.ts";
import { generateImage } from "./llm/image_generate.ts";
import type { SidecarProvider, SidecarRequest } from "./llm/types.ts";
import { installWireCapture } from "./llm/wire_capture.ts";
import { prefixFingerprint } from "./cache/keepalive.ts";
import { McpClient, type McpServerSpec } from "./mcp/client.ts";
import { NotificationService } from "./notifications.ts";
import {
  McpRegistry,
  type McpRegistryOptions,
  type McpServerConfigView,
} from "./tools/mcp_registry.ts";
import { McpHolder } from "./tools/mcp_holder.ts";
import { resolveEmbedder } from "./memory/retrieval.ts";
import { historyIndexPath } from "./memory/history_index.ts";
import { HistoryIndexService } from "./memory/history_index_service.ts";
import { indexPath as workspaceIndexPath } from "./memory/workspace_index.ts";
import { WorkspaceIndexService } from "./memory/workspace_index_service.ts";

const CALL_STORE_RETENTION_DAYS = 14;
const CALL_STORE_MAX_BYTES = 536_870_912;
const CALL_STORE_ROTATE_MS = 3_600_000;
const COST_BACKFILL_MS = 6 * 3_600_000;

export interface RuntimeOptions {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  configPath?: string | undefined;
  config?: LoadedConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onHistory?: HistoryListener | undefined;
  emit?: ((character: string, revision: number, msg: Message) => void) | undefined;
  connectMcp?: ((spec: McpServerSpec) => Promise<McpClient>) | undefined;
  mcpRegistryOptions?: Omit<McpRegistryOptions, "onToolsChanged"> | undefined;
  diagnostics?: Diagnostics | undefined;
}

export interface ShoreRuntime {
  readonly config: LoadedConfig;
  readonly configPath: string;
  readonly registry: CharacterRegistry;
  readonly cache: LastRequestCache;
  readonly mcp: McpHolder;
  readonly connectMcp: (spec: McpServerSpec) => Promise<McpClient>;
  readonly callStore: CallStore | undefined;
  readonly providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  readonly notifier: NotificationService;
  readonly keepalive: KeepaliveService;
  readonly autonomy: AutonomyService;
  readonly historyIndex: HistoryIndexService;
  readonly workspaceIndex: WorkspaceIndexService;
  refreshHistoryIndexes(): Promise<void>;
  refreshMcpCaches(registry: McpRegistry): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions): Promise<ShoreRuntime> {
  const config =
    options.config ??
    loadConfig(options.configPath, options.env === undefined ? {} : { env: options.env });

  createRuntimeDirs(config);

  const notifier = new NotificationService(config.app.notifications);
  const callStore = openCallStore(config);
  ensureLedger(config);

  const providers = captureProviders(options.providers, callStore);
  const uninstallWireCapture = installCallStoreWireCapture(callStore);

  let historyIndex: HistoryIndexService | undefined;
  let workspaceIndex: WorkspaceIndexService | undefined;
  const registry = await CharacterRegistry.create(
    config.dirs.config,
    config.dirs.data,
    config,
    (history) => {
      const character = history.selected_character;
      if (character !== undefined) historyIndex?.noteMutation(character);
      options.onHistory?.(history);
    },
  );

  applySubscriptionProviders(registry);

  historyIndex = new HistoryIndexService();
  workspaceIndex = new WorkspaceIndexService();
  const refreshHistoryIndexes = async () => {
    const available = new Set(registry.availableCharacters());
    for (const character of historyIndex?.registeredCharacters() ?? []) {
      if (!available.has(character)) historyIndex?.unregister(character);
    }
    for (const character of workspaceIndex?.registeredCharacters() ?? []) {
      if (!available.has(character)) workspaceIndex?.unregister(character);
    }
    for (const character of available) {
      const effective = registry.effectiveConfig(character);
      let embedder;
      let embedderError;
      try {
        embedder = resolveEmbedder({
          ...(effective.app.defaults.embedding === undefined
            ? {}
            : { defaultRef: effective.app.defaults.embedding }),
          embedding: Object.fromEntries(effective.models.embedding),
          providers: providerRecord(effective),
        });
      } catch (e) {
        embedderError = e instanceof Error ? e.message : String(e);
      }
      historyIndex?.register({
        character,
        characterDataDir: characterDataDir(effective.dirs.data, character),
        indexPath: historyIndexPath(effective.dirs.cache, character),
        ...(embedder === undefined ? {} : { embedder }),
      });
      workspaceIndex?.register({
        character,
        workspaceDir: characterWorkspaceDir(
          effective.dirs.config,
          character,
          effective.dirs.workspace,
        ),
        indexPath: workspaceIndexPath(effective.dirs.cache, character),
        retrievalConfig: retrievalView(effective.app.memory.retrieval),
        ...(embedder === undefined ? {} : { embedder }),
        ...(embedderError === undefined ? {} : { embedderError }),
      });
    }
  };
  await refreshHistoryIndexes();
  await historyIndex.start();
  await workspaceIndex.start();

  const keepalive = new KeepaliveService(
    (req, signal) => {
      const provider = providers[req.sdk];
      if (!provider) throw new Error(`unsupported sdk: ${req.sdk}`);
      return provider.generate(
        withResolvedCredential(req, config, options.env ?? process.env),
        signal,
      );
    },
    () => Date.now(),
    {
      ledgerPath: rustJoin(config.dirs.data, "ledger.db"),
      maxIdleSecs: () =>
        Number(registry.globalConfig().app.cache.keepalive_max.asSecs()),
    },
  );
  const cache = new LastRequestCache(keepalive);

  const connectMcp = options.connectMcp ?? McpClient.connect;
  const refreshMcpCaches = async (mcpRegistry: McpRegistry): Promise<void> => {
    await refreshMcpPromptCaches(cache, registry, config.dirs.data, mcpRegistry);
  };
  const mcp = new McpHolder(
    await connectMcpRegistry(
      config,
      connectMcp,
      refreshMcpCaches,
      options.mcpRegistryOptions,
    ),
  );

  const autonomy = new AutonomyService(
    new InProcessAutonomyExecutor({
      registry,
      cache,
      providers,
      tools: sharedToolDeps(config, mcp, {
        providers,
        registry,
        ...(callStore === undefined ? {} : { callStore }),
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
      ...(callStore === undefined ? {} : { callStore }),
      ...(options.emit === undefined ? {} : { emit: options.emit }),
      ...(options.env === undefined ? {} : { env: options.env }),
      notifyAutonomousMessage: autonomousMessageNotifier(notifier),
      notifyCompactionComplete: compactionCompleteNotifier(notifier),
      beginForeground: () => {
        const endHistory = historyIndex.beginForeground();
        const endWorkspace = workspaceIndex.beginForeground();
        return () => {
          endHistory();
          endWorkspace();
        };
      },
    }),
  );
  autonomy.attachKeepalive(keepalive);

  return {
    config,
    configPath: options.configPath ?? rustJoin(config.dirs.config, "config.toml"),
    registry,
    cache,
    mcp,
    connectMcp,
    callStore,
    providers,
    notifier,
    keepalive,
    autonomy,
    historyIndex,
    workspaceIndex,
    refreshHistoryIndexes,
    refreshMcpCaches,
    async shutdown() {
      await historyIndex.shutdown();
      await workspaceIndex.shutdown();
      await mcp.current.shutdown();
      uninstallWireCapture();
      callStore?.close();
    },
  };
}

export interface RuntimeClockIntervals {
  keepaliveMs?: number | undefined;
}

export function startRuntimeClocks(
  runtime: ShoreRuntime,
  intervals: RuntimeClockIntervals = {},
): { stop: () => void } {
  setCallObserver((ctx, model, callType, req, usage) => {
    runtime.keepalive.observe(
      ctx.character,
      model,
      callType,
      ctx.keepalive_max_secs,
      prefixFingerprint(req),
      usage,
    );
  });
  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);
  const autonomyTimer = startAutonomyTimer(runtime.autonomy);
  const rotation = startCallStoreRotation(runtime.callStore);
  const costBackfill = startCostBackfill(
    rustJoin(runtime.config.dirs.data, "ledger.db"),
  );

  return {
    stop: () => {
      keepaliveTimer.stop();
      autonomyTimer.stop();
      rotation.stop();
      costBackfill.stop();
    },
  };
}

export function autonomousMessageNotifier(
  notifier: Pick<NotificationService, "notify">,
): (title: string, body: string) => void {
  return (title, body) => notifier.notify("autonomous_message", title, body);
}

export function compactionCompleteNotifier(
  notifier: Pick<NotificationService, "notify">,
): (title: string, body: string) => void {
  return (title, body) => notifier.notify("compaction_complete", title, body);
}

function createRuntimeDirs(config: LoadedConfig): void {
  for (const dir of [
    config.dirs.data,
    pluginsDir(config.dirs.data),
    config.dirs.cache,
    config.dirs.runtime,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function openCallStore(config: LoadedConfig): CallStore | undefined {
  const path = rustJoin(config.dirs.cache, "calls.db");
  try {
    const store = CallStore.open(path);
    shoreLog.info(`shore: call payload store enabled at ${path}`);
    return store;
  } catch (e) {
    shoreLog.warn(`shore: cannot open the call store at ${path}; capture disabled: ${String(e)}`);
    return undefined;
  }
}

function installCallStoreWireCapture(store: CallStore | undefined): () => void {
  if (store === undefined) return () => {};
  return installWireCapture((exchange) => {
    store.recordHttpCall(exchange);
  });
}

function ensureLedger(config: LoadedConfig): void {
  Ledger.create(rustJoin(config.dirs.data, "ledger.db")).close();
}

export function mcpConfigView(config: LoadedConfig): Record<string, McpServerConfigView> {
  const servers: Record<string, McpServerConfigView> = {};
  for (const [name, server] of config.app.mcp) {
    servers[name] = {
      ...(server.command === undefined ? {} : { command: server.command }),
      args: server.args,
      env: Object.fromEntries(server.env),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.url === undefined ? {} : { url: server.url }),
      headers: Object.fromEntries(server.headers),
    };
  }
  return servers;
}

async function connectMcpRegistry(
  config: LoadedConfig,
  connect: (spec: McpServerSpec) => Promise<McpClient>,
  onToolsChanged: (registry: McpRegistry, server: string) => Promise<void>,
  options: Omit<McpRegistryOptions, "onToolsChanged"> = {},
): Promise<McpRegistry> {
  return await McpRegistry.fromConfig(
    mcpConfigView(config),
    pluginsDir(config.dirs.data),
    connect,
    undefined,
    { ...options, onToolsChanged },
  );
}

export async function refreshMcpPromptCaches(
  cache: Pick<LastRequestCache, "cachedCharacters" | "invalidate" | "reprimeFromDisk">,
  registry: Pick<CharacterRegistry, "effectiveConfig">,
  dataDir: string,
  mcpRegistry: Pick<McpRegistry, "toolDefsFiltered">,
): Promise<void> {
  for (const character of cache.cachedCharacters()) {
    cache.invalidate(character, "mcp_recovery");
    try {
      await cache.reprimeFromDisk(character, dataDir, registry.effectiveConfig(character), {
        mcpRegistry,
      });
    } catch (e) {
      shoreLog.warn(`shore: mcp recovery cache refresh failed for ${character}: ${String(e)}`);
    }
  }
}

export interface SubagentToolDeps {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  registry: Pick<CharacterRegistry, "effectiveConfig">;
  callStore?: CallStore | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  turn?: SubagentTurn | undefined;
}

export function sharedToolDeps(
  config: LoadedConfig,
  mcp: McpHolder,
  subagent?: SubagentToolDeps,
): ToolContextDeps {
  return {
    mcpRegistry: mcp.callView(),
    ...(subagent === undefined
      ? {}
      : {
          runSubagent: (parent: ToolContext) => {
            const turn = subagent.turn;
            return subagentRunner({
              config: subagent.registry.effectiveConfig(parent.characterName),
              ctx: parent,
              providers: subagent.providers,
              ...(subagent.callStore === undefined ? {} : { callStore: subagent.callStore }),
              mcpRegistry: mcp.current,
              ...(subagent.env === undefined ? {} : { env: subagent.env }),
              ...(turn === undefined
                ? {}
                : {
                    sendDirect: turn.send,
                    conversation: turn.conversation,
                    ...(turn.rid === undefined ? {} : { rid: turn.rid }),
                    now: turn.now,
                    newMessageId: turn.newMessageId,
                  }),
            });
          },
        }),
    imageGenerator: async (params) =>
      await generateImage({
        provider_key: params.provider_key,
        model: params.model,
        api_key: params.api_key,
        prompt: params.prompt,
        ...(params.base_url === undefined ? {} : { base_url: params.base_url }),
        ...(params.size === undefined ? {} : { size: params.size }),
        ...(params.quality === undefined ? {} : { quality: params.quality }),
        ...(params.aspect_ratio === undefined ? {} : { aspect_ratio: params.aspect_ratio }),
        ...(params.image_size === undefined ? {} : { image_size: params.image_size }),
      }),
    modelHistoryQuery: (character, since, until) => {
      const ledger = ledgerFor(rustJoin(config.dirs.data, "ledger.db"));
      if (ledger === null) throw new Error("the ledger is unavailable");
      return Promise.resolve(
        modelUsageSummary(ledger.database, {
          character,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
        }),
      );
    },
  };
}

export function applySubscriptionProviders(registry: CharacterRegistry): void {
  const flat = new Set<string>(DEFAULT_SUBSCRIPTION_PROVIDERS);
  const configs = [
    registry.globalConfig(),
    ...registry.availableCharacters().map((c) => registry.effectiveConfig(c)),
  ];
  for (const config of configs) {
    for (const [name, subscription] of config.providers.subscriptionSettings()) {
      if (subscription) flat.add(name);
      else flat.delete(name);
    }
  }
  setSubscriptionProviders(flat);
}

function startCostBackfill(ledgerPath: string): { stop: () => void } {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await backfillLedgerCosts(ledgerPath);
      if (result.updated > 0) {
        shoreLog.info(
          `shore: priced ${result.updated} of ${result.total} ledger rows that had no cost`,
        );
      }
      for (const failure of result.failures) {
        shoreLog.warn(`shore: still no pricing for ${failure.model}: ${failure.reason}`);
      }
    } catch (e) {
      shoreLog.warn(`shore: ledger cost backfill failed: ${String(e)}`);
    } finally {
      running = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), COST_BACKFILL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function startCallStoreRotation(store: CallStore | undefined): { stop: () => void } {
  if (store === undefined) return { stop: () => {} };

  const rotate = () => {
    try {
      const stats = store.rotate(
        new Date(Date.now() - CALL_STORE_RETENTION_DAYS * 86_400_000),
        CALL_STORE_MAX_BYTES,
      );
      if (stats.deleted_by_age > 0 || stats.deleted_by_size > 0) {
        shoreLog.info(
          `shore: call store rotation pruned ${stats.deleted_by_age} rows by age and ` +
            `${stats.deleted_by_size} by size`,
        );
      }
    } catch (e) {
      shoreLog.warn(`shore: call store rotation failed: ${String(e)}`);
    }
  };

  rotate();
  const timer = setInterval(rotate, CALL_STORE_ROTATE_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
