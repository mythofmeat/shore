import { closeStorageConnections } from "./storage/store.ts";
import { initializeDatabase } from "./storage/database.ts";
import { evictCachedImages, setImageCacheLimit } from "./storage/image_cache.ts";
import { moveImagesToCache } from "./storage/image_migration.ts";
import { startDiagnosticRetention } from "./storage/retention.ts";
import { shoreLog } from "./log.ts";

import { mkdirSync } from "node:fs";

import { InProcessAutonomyExecutor } from "./autonomy/in_process.ts";
import { localWallClock } from "./autonomy/activity.ts";
import { KeepaliveService, startKeepaliveTimer } from "./cache/keepalive.ts";
import { LastRequestCache } from "./cache/last_request.ts";
import { AutonomyService, startAutonomyTimer } from "./autonomy/service.ts";
import { CallStore } from "./call_store.ts";
import { CharacterRegistry } from "./characters.ts";
import {
  characterWorkspaceDir,
  pluginsDir,
  rustJoin,
  threadDataDir,
  MAIN_THREAD,
} from "./config/dirs.ts";
import { HISTORY_DB_FILE } from "./engine/history_store.ts";
import { mcpBearerToken, type McpServerConfig } from "./config/app.ts";
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
import { setNanoGptSubscription, setSubscriptionProviders } from "./ledger/store.ts";
import { DEFAULT_SUBSCRIPTION_PROVIDERS } from "./config/providers.ts";
import { ledgerFor, setNanoGptSubscriptionCacheDir } from "./ledger/record.ts";
import { closeLedgers, setCallObserver } from "./ledger/record.ts";
import { modelUsageSummary } from "./ledger/query.ts";
import { configureClaudePlanLimits, type ClaudePlanLimitsOptions } from "./ledger/plan_limits.ts";
import { captureProviders } from "./llm/capture.ts";
import { withResolvedCredential, withWorkspaceDir } from "./llm/generate.ts";
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
import { SnapshotGate } from "./snapshot_gate.ts";
import { cachePath, readCacheSync } from "./llm/discovery.ts";
import {
  nanoGptSubscriptionPath,
  readNanoGptSubscriptionSync,
} from "./llm/nanogpt_subscription.ts";
import { NANOGPT_PROVIDER } from "./llm/providers/nanogpt_config.ts";

const COST_BACKFILL_MS = 6 * 3_600_000;

export interface RuntimeOptions {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  configPath?: string | undefined;
  config?: LoadedConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onHistory?: HistoryListener | undefined;
  emit?: ((character: string, revision: number, msg: Message, thread: string) => void) | undefined;
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
  readonly snapshotGate: SnapshotGate;
  refreshHistoryIndexes(): Promise<void>;
  refreshMcpCaches(registry: McpRegistry): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions): Promise<ShoreRuntime> {
  const config =
    options.config ??
    loadConfig(options.configPath, options.env === undefined ? {} : { env: options.env });

  createRuntimeDirs(config);
  initializeDatabase(config.dirs.data);
  setImageCacheLimit(config.app.daemon.image_cache_bytes);
  moveImagesToCache(config.dirs.data, config.dirs.cache);
  evictCachedImages(config.dirs.cache);

  const notifier = new NotificationService(config.app.notifications);
  const snapshotGate = new SnapshotGate();
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
      if (character !== undefined) {
        historyIndex?.noteMutation(character);
      }
      options.onHistory?.(history);
    },
  );

  applySubscriptionProviders(registry);
  configureClaudePlanLimits({ cacheDir: config.dirs.cache, ...claudePlanFetcher(options.providers.claude_agent) });

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
        conversationDir: threadDataDir(
          effective.dirs.data,
          character,
          MAIN_THREAD,
        ),
        dbPath: rustJoin(effective.dirs.data, HISTORY_DB_FILE),
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
        withResolvedCredential(withWorkspaceDir(req, config), config, options.env ?? process.env),
        signal,
      );
    },
    () => Date.now(),
    {
      ledgerPath: rustJoin(config.dirs.data, "shore.db"),
      runActivity: async (run) => await snapshotGate.withActivity(run),
    },
  );
  const cache = new LastRequestCache(keepalive);

  const connectMcp = options.connectMcp ?? McpClient.connect;
  const refreshMcpCaches = async (mcpRegistry: McpRegistry): Promise<void> => {
    await refreshMcpPromptCaches(cache, registry, config.dirs.data, mcpRegistry, options.env);
  };
  const mcp = new McpHolder(
    await connectMcpRegistry(
      config,
      connectMcp,
      refreshMcpCaches,
      options.mcpRegistryOptions,
      options.env,
    ),
  );

  const autonomy: AutonomyService = new AutonomyService(
    new InProcessAutonomyExecutor({
      registry,
      cache,
      providers,
      tools: sharedToolDeps(config, mcp, {
        activityStats: (character, localAt, days) => autonomy.activityStats(character, localAt, days),
      }, {
        providers,
        registry,
        ...(callStore === undefined ? {} : { callStore }),
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
      rebuild: {
        ...(options.env === undefined ? {} : { env: options.env }),
        mcpRegistry: {
          toolDefsFiltered: (patterns) => mcp.current.toolDefsFiltered(patterns),
        },
      },
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
      runActivity: async (run) => await snapshotGate.withActivity(run),
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
    snapshotGate,
    refreshHistoryIndexes,
    refreshMcpCaches,
    async shutdown() {
      await historyIndex.shutdown();
      await workspaceIndex.shutdown();
      await mcp.current.shutdown();
      closeStorageConnections();
      uninstallWireCapture();
      callStore?.close();
      closeLedgers();
    },
  };
}

export interface RuntimeClockIntervals {
  keepaliveMs?: number | undefined;
  diagnosticRetentionMs?: number | undefined;
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
      prefixFingerprint(req),
      usage,
      req,
    );
  });
  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);
  const autonomyTimer = startAutonomyTimer(runtime.autonomy);
  const retention = startDiagnosticRetention(runtime.config.dirs.data, runtime.snapshotGate, intervals.diagnosticRetentionMs);
  const costBackfill = startCostBackfill(
    rustJoin(runtime.config.dirs.data, "shore.db"),
    runtime.snapshotGate,
  );

  return {
    stop: () => {
      keepaliveTimer.stop();
      autonomyTimer.stop();
      costBackfill.stop();
      retention.stop();
      setCallObserver(undefined);
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

function openCallStore(config: LoadedConfig): CallStore {
  const path = rustJoin(config.dirs.data, "shore.db");
  const store = CallStore.open(path);
  shoreLog.info(`shore: call payload store enabled at ${path}`);
  return store;
}

function installCallStoreWireCapture(store: CallStore | undefined): () => void {
  if (store === undefined) return () => {};
  return installWireCapture((exchange) => {
    store.recordHttpCall(exchange);
  });
}

function ensureLedger(config: LoadedConfig): void {
  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();
}

export function mcpConfigView(
  config: LoadedConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, McpServerConfigView> {
  const servers: Record<string, McpServerConfigView> = {};
  for (const [name, server] of config.app.mcp) {
    servers[name] = {
      ...(server.command === undefined ? {} : { command: server.command }),
      args: server.args,
      env: Object.fromEntries(server.env),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.url === undefined ? {} : { url: server.url }),
      headers: mcpHeaders(name, server, env),
    };
  }
  return servers;
}

function mcpHeaders(
  name: string,
  server: McpServerConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers = Object.fromEntries(server.headers);
  if (server.bearer_token_env === undefined) return headers;
  const token = mcpBearerToken(server, env);
  if (token === undefined) {
    shoreLog.warn(
      `shore: mcp.${name}.bearer_token_env names $${server.bearer_token_env}, which is not set; ` +
        "connecting without credentials",
    );
    return headers;
  }
  return { ...headers, Authorization: `Bearer ${token}` };
}

async function connectMcpRegistry(
  config: LoadedConfig,
  connect: (spec: McpServerSpec) => Promise<McpClient>,
  onToolsChanged: (registry: McpRegistry, server: string) => Promise<void>,
  options: Omit<McpRegistryOptions, "onToolsChanged"> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpRegistry> {
  return await McpRegistry.fromConfig(
    mcpConfigView(config, env),
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
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  for (const character of cache.cachedCharacters()) {
    cache.invalidate(character, "mcp_recovery");
    try {
      await cache.reprimeFromDisk(character, dataDir, registry.effectiveConfig(character), {
        mcpRegistry,
        ...(env === undefined ? {} : { env }),
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
  activity: Pick<AutonomyService, "activityStats">,
  subagent?: SubagentToolDeps,
): ToolContextDeps {
  return {
    activityStats: (character, days) => {
      const report = activity.activityStats(character, localWallClock(Date.now()), days);
      return report === undefined
        ? undefined
        : { stats: report.stats, turnCount: report.messageCount };
    },
    ...(subagent?.turn === undefined ? {} : { signal: subagent.turn.signal }),
    ...(subagent?.turn === undefined ? {} : { conversation: subagent.turn.conversation }),
    ...(subagent?.turn?.thread === undefined ? {} : { thread: subagent.turn.thread }),
    mcpRegistry: mcp.callView(),
    mcpToolDefs: (patterns) => mcp.current.toolDefsFiltered(patterns),
    ...(subagent === undefined
      ? {}
      : {
          runSubagent: (parent: ToolContext) => {
            const turn = subagent.turn;
            return subagentRunner({
              config: subagent.registry.effectiveConfig(parent.characterName),
              ctx: parent,
              conversation: parent.conversation,
              providers: subagent.providers,
              ...(subagent.callStore === undefined ? {} : { callStore: subagent.callStore }),
              mcpRegistry: mcp.current,
              ...(subagent.env === undefined ? {} : { env: subagent.env }),
              ...(turn === undefined
                ? {}
                : {
                    sendDirect: turn.send,
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
      const ledger = ledgerFor(rustJoin(config.dirs.data, "shore.db"));
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

function claudePlanFetcher(provider: SidecarProvider | undefined): Pick<ClaudePlanLimitsOptions, "fetch"> {
  return provider === undefined ? {} : { fetch: () => provider.planLimits?.() ?? Promise.resolve(undefined) };
}

export function applySubscriptionProviders(registry: CharacterRegistry): void {
  const policy = (config: LoadedConfig): Set<string> => {
    const providers = new Set<string>(DEFAULT_SUBSCRIPTION_PROVIDERS);
    for (const [name, subscription] of config.providers.subscriptionSettings()) {
      if (subscription) providers.add(name);
      else providers.delete(name);
    }
    return providers;
  };
  setSubscriptionProviders(policy(registry.globalConfig()), registry.availableCharacters().map(
    (character) => [character, policy(registry.effectiveConfig(character))] as const,
  ));
  const config = registry.globalConfig();
  const models = readCacheSync(cachePath(config.dirs.cache, NANOGPT_PROVIDER));
  const state = readNanoGptSubscriptionSync(nanoGptSubscriptionPath(config.dirs.cache));
  setNanoGptSubscription(
    (models?.models ?? [])
      .filter((model) => model.subscription_included === true)
      .map((model) => model.model_id),
    state,
  );
  setNanoGptSubscriptionCacheDir(config.dirs.cache);
}

function startCostBackfill(ledgerPath: string, gate?: SnapshotGate): { stop: () => void } {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await (gate?.withActivity(async () => await backfillLedgerCosts(ledgerPath)) ??
        backfillLedgerCosts(ledgerPath));
      if (result.updated > 0) {
        shoreLog.info(
          `shore: priced ${result.updated} of ${result.total} ledger rows that had no cost`,
        );
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
