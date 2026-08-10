import { mkdirSync } from "node:fs";

import { InProcessAutonomyExecutor } from "./autonomy/in_process.ts";
import { KeepaliveService, startKeepaliveTimer } from "./cache/keepalive.ts";
import { LastRequestCache } from "./cache/last_request.ts";
import { AutonomyService, startAutonomyTimer } from "./autonomy/service.ts";
import { CallStore } from "./call_store.ts";
import { CharacterRegistry } from "./characters.ts";
import { pluginsDir, rustJoin } from "./config/dirs.ts";
import { loadConfig, type LoadedConfig } from "./config/loader.ts";
import type { HistoryListener } from "./engine/conversation.ts";
import type { Message } from "./engine/types.ts";
import type { ToolContextDeps } from "./handler/tool_context.ts";
import { Diagnostics } from "./diagnostics.ts";
import type { ToolContext } from "./tools/dispatch.ts";
import { subagentRunner } from "./tools/subagent_loop.ts";
import { Ledger } from "./ledger/store.ts";
import { ledgerFor } from "./ledger/record.ts";
import { setCallObserver } from "./ledger/record.ts";
import { modelUsageSummary } from "./ledger/query.ts";
import { captureProviders } from "./llm/capture.ts";
import { withResolvedCredential } from "./llm/generate.ts";
import { generateImage } from "./llm/image_generate.ts";
import type { SidecarProvider, SidecarRequest } from "./llm/types.ts";
import { installWireCapture } from "./llm/wire_capture.ts";
import { McpClient, type McpServerSpec } from "./mcp/client.ts";
import { NotificationService } from "./notifications.ts";
import { McpRegistry, type McpServerConfigView } from "./tools/mcp_registry.ts";
import { McpHolder } from "./tools/mcp_holder.ts";

const CALL_STORE_RETENTION_DAYS = 14;
const CALL_STORE_MAX_BYTES = 536_870_912;
const CALL_STORE_ROTATE_MS = 3_600_000;

export interface RuntimeOptions {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  configPath?: string | undefined;
  config?: LoadedConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onHistory?: HistoryListener | undefined;
  emit?: ((character: string, revision: number, msg: Message) => void) | undefined;
  connectMcp?: ((spec: McpServerSpec) => Promise<McpClient>) | undefined;
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

  const registry = await CharacterRegistry.create(
    config.dirs.config,
    config.dirs.data,
    config,
    options.onHistory,
  );

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
        Number(registry.globalConfig().app.behavior.autonomy.cache_keepalive_max.asSecs()),
    },
  );
  const cache = new LastRequestCache(keepalive);

  const connectMcp = options.connectMcp ?? McpClient.connect;
  const mcp = new McpHolder(await connectMcpRegistry(config, connectMcp));

  const autonomy = new AutonomyService(
    new InProcessAutonomyExecutor({
      registry,
      cache,
      providers,
      tools: sharedToolDeps(config, mcp, {
        providers,
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
      ...(callStore === undefined ? {} : { callStore }),
      ...(options.emit === undefined ? {} : { emit: options.emit }),
      ...(options.env === undefined ? {} : { env: options.env }),
      notifyAutonomousMessage: autonomousMessageNotifier(notifier),
      notifyCompactionComplete: compactionCompleteNotifier(notifier),
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
    async shutdown() {
      await mcp.current.shutdown();
      uninstallWireCapture();
      callStore?.close();
    },
  };
}

export function startRuntimeClocks(runtime: ShoreRuntime): { stop: () => void } {
  setCallObserver((ctx, model, callType) => {
    runtime.keepalive.observe(ctx.character, model, callType, ctx.keepalive_max_secs);
  });
  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive);
  const autonomyTimer = startAutonomyTimer(runtime.autonomy);
  const rotation = startCallStoreRotation(runtime.callStore);

  return {
    stop: () => {
      keepaliveTimer.stop();
      autonomyTimer.stop();
      rotation.stop();
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
    console.info(`shore: call payload store enabled at ${path}`);
    return store;
  } catch (e) {
    console.warn(`shore: cannot open the call store at ${path}; capture disabled: ${String(e)}`);
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
): Promise<McpRegistry> {
  return await McpRegistry.fromConfig(
    mcpConfigView(config),
    pluginsDir(config.dirs.data),
    connect,
  );
}

export function sharedToolDeps(
  config: LoadedConfig,
  mcp: McpHolder,
  subagent?: {
    providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
    env?: NodeJS.ProcessEnv | undefined;
  },
): ToolContextDeps {
  return {
    mcpRegistry: mcp.callView(),
    ...(subagent === undefined
      ? {}
      : {
          runSubagent: (parent: ToolContext) =>
            subagentRunner({
              config,
              ctx: parent,
              providers: subagent.providers,
              mcpRegistry: mcp.current,
              diagnostics: new Diagnostics().tool_calls,
              ...(subagent.env === undefined ? {} : { env: subagent.env }),
            }),
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

function startCallStoreRotation(store: CallStore | undefined): { stop: () => void } {
  if (store === undefined) return { stop: () => {} };

  const rotate = () => {
    try {
      const stats = store.rotate(
        new Date(Date.now() - CALL_STORE_RETENTION_DAYS * 86_400_000),
        CALL_STORE_MAX_BYTES,
      );
      if (stats.deleted_by_age > 0 || stats.deleted_by_size > 0) {
        console.info(
          `shore: call store rotation pruned ${stats.deleted_by_age} rows by age and ` +
            `${stats.deleted_by_size} by size`,
        );
      }
    } catch (e) {
      console.warn(`shore: call store rotation failed: ${String(e)}`);
    }
  };

  rotate();
  const timer = setInterval(rotate, CALL_STORE_ROTATE_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
