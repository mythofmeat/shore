/**
 * Everything the daemon builds once, before it serves anything.
 *
 * Ported from the assembly half of `crates/daemon/src/main.rs` —
 * `create_runtime_dirs`, `build_llm_client`, `build_autonomy_manager`, the
 * `CharacterRegistry`/`McpRegistry` construction inside
 * `build_server_and_handler`, and `spawn_call_store_rotation`.
 *
 * # Why this is a module rather than a few lines in `serveSidecar`
 *
 * Because the pieces are mutually dependent and the order is load-bearing in
 * ways nothing checks:
 *
 * - The **ledger file has to exist** before the first call is recorded.
 *   `ledgerFor` memoises a failed open, so a missing file is not one lost row —
 *   it is every row for the life of the process, and `shore usage` reporting a
 *   quiet month is the only symptom.
 * - The **MCP registry is built before the autonomy service**, because a
 *   heartbeat's tool surface has to be the one chat sees. A background tick
 *   offering fewer tools than the foreground writes a prompt prefix the next
 *   chat turn cannot reuse — the keepalive then pays for a cache write and buys
 *   nothing. This is the same reason `handler/context.ts` makes `mcpToolDefs` a
 *   thing its caller has to state.
 * - The **keepalive is built before the cache**, because arming is what reads
 *   the cadence off a body, and the cache is what does the arming.
 *
 * # Assembly here, clocks in {@link startRuntimeClocks}
 *
 * Building this runs I/O — it opens files and connects MCP servers — but it
 * starts no timers and registers no observers. Those are a *server's* effects,
 * and the split is the same one `serveSidecar` already made for the keepalive:
 * a runtime that merely exists should not be ticking.
 */

import { mkdirSync } from "node:fs";

import { InProcessAutonomyExecutor } from "./autonomy/in_process.ts";
import { KeepaliveService, startKeepaliveTimer } from "./autonomy/keepalive.ts";
import { LastRequestCache } from "./autonomy/last_request.ts";
import { AutonomyService, startAutonomyTimer } from "./autonomy/service.ts";
import { CallStore } from "./call_store.ts";
import { CharacterRegistry } from "./characters.ts";
import { pluginsDir, rustJoin } from "./config/dirs.ts";
import { loadConfig, type LoadedConfig } from "./config/loader.ts";
import type { HistoryListener } from "./engine/conversation.ts";
import type { Message } from "./engine/types.ts";
import type { ToolContextDeps } from "./handler/tool_context.ts";
import { Ledger } from "./ledger/store.ts";
import { ledgerFor } from "./ledger/record.ts";
import { setCallObserver } from "./ledger/record.ts";
import { modelUsageSummary } from "./ledger/query.ts";
import { generateImage } from "./llm/image_generate.ts";
import type { SidecarProvider, SidecarRequest } from "./llm/types.ts";
import { McpClient, type McpServerSpec } from "./mcp/client.ts";
import { NotificationService } from "./notifications.ts";
import { McpRegistry, type McpServerConfigView } from "./tools/mcp_registry.ts";

/** Observability store retention window: rows older than this are pruned. */
export const CALL_STORE_RETENTION_DAYS = 14;
/**
 * Observability store disk backstop (512 MiB). If 14 days of capture exceeds
 * it, the oldest calls are evicted; compression keeps real usage well under.
 */
export const CALL_STORE_MAX_BYTES = 536_870_912;
/** How often the rotation pass runs. */
export const CALL_STORE_ROTATE_MS = 3_600_000;

export interface RuntimeOptions {
  /** Provider adapters by sdk. Required, because the caller owns the table. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  /** `--config`. Re-homes the whole config directory, as the Rust's did. */
  configPath?: string | undefined;
  /** Already-loaded config, for a caller that has one. Skips the disk read. */
  config?: LoadedConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Where a new engine sends its history events, and where a delivered
   * autonomous message is pushed to connected clients.
   *
   * Both are the SWP broadcast, and both are absent until `swp_server` is
   * wired — a heartbeat still persists its message and still logs it, and the
   * client sees it on its next history read rather than as a push.
   */
  onHistory?: HistoryListener | undefined;
  emit?: ((character: string, revision: number, msg: Message) => void) | undefined;
  /** Injected so a test can stand up a registry without spawning processes. */
  connectMcp?: ((spec: McpServerSpec) => Promise<McpClient>) | undefined;
}

export interface ShoreRuntime {
  readonly config: LoadedConfig;
  readonly registry: CharacterRegistry;
  readonly cache: LastRequestCache;
  readonly mcp: McpRegistry;
  /** `undefined` when the store would not open — capture off, daemon up. */
  readonly callStore: CallStore | undefined;
  readonly notifier: NotificationService;
  readonly keepalive: KeepaliveService;
  readonly autonomy: AutonomyService;
  shutdown(): Promise<void>;
}

/**
 * Load the config, prepare the directories, open the stores, connect MCP, and
 * assemble the services that outlive a request.
 *
 * Fatal: a config that will not parse, a directory that cannot be created, a
 * ledger that cannot be opened. Best-effort: the call store, and every
 * individual MCP server. The split is the Rust's and the rule behind it is
 * whether the daemon can still do its job — it can talk without payload
 * capture and without an MCP server, and it cannot bill without a ledger.
 */
export async function createRuntime(options: RuntimeOptions): Promise<ShoreRuntime> {
  const config =
    options.config ??
    loadConfig(options.configPath, options.env === undefined ? {} : { env: options.env });

  createRuntimeDirs(config);

  const notifier = new NotificationService(config.app.notifications);
  const callStore = openCallStore(config);
  ensureLedger(config);

  // The ping sender is the same dispatch the request path uses. Built here
  // rather than taken as an option so the two cannot drift: a keepalive that
  // pings through a different adapter than chat sends through is warming a
  // prefix nothing will read.
  const keepalive = new KeepaliveService((req, signal) => {
    const provider = options.providers[req.sdk];
    if (!provider) throw new Error(`unsupported sdk: ${req.sdk}`);
    return provider.generate(req, signal);
  });
  const cache = new LastRequestCache(keepalive);

  const mcp = await connectMcpRegistry(config, options.connectMcp ?? McpClient.connect);

  const registry = await CharacterRegistry.create(
    config.dirs.config,
    config.dirs.data,
    config,
    options.onHistory,
  );

  const autonomy = new AutonomyService(
    new InProcessAutonomyExecutor({
      registry,
      cache,
      providers: options.providers,
      tools: backgroundToolDeps(config, mcp),
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
    registry,
    cache,
    mcp,
    callStore,
    notifier,
    keepalive,
    autonomy,
    async shutdown() {
      await mcp.shutdown();
      callStore?.close();
    },
  };
}

/**
 * Start the three clocks and the ledger observer.
 *
 * Separate from assembly because these are what make a runtime *run*: the
 * keepalive spends money on a schedule, the autonomy tick starts heartbeats,
 * and the rotation pass deletes rows. A test that wants a registry and a cache
 * should not inherit any of them.
 */
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

/**
 * The executor's notifications, each bound to the event that gates it.
 *
 * Named functions rather than lambdas at the call site because the event name
 * *is* the decision: `[notifications.events]` has a toggle per event, and a
 * message filed under the wrong one obeys a switch the user set for something
 * else. The Rust chose per call site and so do these — `AutonomousMessage` at
 * `manager.rs:1837` for a delivered heartbeat message, `CompactionComplete` at
 * `manager.rs:625` for the deep archive's pure-archive arm.
 *
 * Idle compaction gets neither, and that is the port rather than a gap: its
 * notification is fired from *inside* the pass, where the "ran but wrote no
 * memory" outcome exists. See `memory/compaction/run.ts`.
 */
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

/**
 * Create the directories anything is about to write into.
 *
 * `<data>/plugins/` is here for a reason that is not "something writes to it":
 * it is the root relative `[mcp.*]` paths resolve against, and creating it up
 * front makes it discoverable without reading the docs.
 */
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

/**
 * Open the payload store, or carry on without capture.
 *
 * Capture is always on when it can be: every LLM call is recorded to the
 * compressed, bounded store behind `shore log`. A store that will not open
 * disables capture and never blocks the daemon.
 */
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

/**
 * Make sure the ledger file and its schema exist, then let go of it.
 *
 * Opened and closed rather than held: every reader and writer goes through
 * `ledgerFor`, which opens lazily and memoises. What this call is for is the
 * *creation* — `Ledger.open` refuses a file that is not there, and a recorder
 * that finds nothing caches the failure and silently stops billing.
 */
function ensureLedger(config: LoadedConfig): void {
  Ledger.create(rustJoin(config.dirs.data, "ledger.db")).close();
}

/**
 * Connect every configured MCP server and snapshot its tool surface.
 *
 * An empty `[mcp]` yields an empty registry, which costs nothing.
 */
async function connectMcpRegistry(
  config: LoadedConfig,
  connect: (spec: McpServerSpec) => Promise<McpClient>,
): Promise<McpRegistry> {
  const servers: Record<string, McpServerConfigView> = {};
  for (const [name, server] of config.app.mcp) {
    servers[name] = {
      ...(server.command === undefined ? {} : { command: server.command }),
      args: server.args,
      env: Object.fromEntries(server.env),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.url === undefined ? {} : { url: server.url }),
    };
  }
  return await McpRegistry.fromConfig(servers, pluginsDir(config.dirs.data), connect);
}

/**
 * The tool backends a background turn gets, which is not all of them.
 *
 * Three fields the chat path will want are deliberately absent, and each for
 * its own reason rather than as a batch:
 *
 * - **`runSubagent`** is unported — the nested loop driver is still
 *   `crates/daemon/src/tools/subagent.rs`. `ask_*` is uncallable until it
 *   lands, which is what a daemon without the runtime did.
 * - **`activityStats` and `deferEdit`** are per-character, and this object is
 *   shared. The Rust's `build_tool_context` for a heartbeat set neither, so
 *   their absence here is the port rather than a gap.
 */
function backgroundToolDeps(config: LoadedConfig, mcp: McpRegistry): ToolContextDeps {
  return {
    mcpRegistry: mcp,
    // `generateImage` speaks the sidecar's request shape; the tool speaks its
    // own, with every field present and possibly undefined. The optional ones
    // are dropped rather than passed as `undefined`, which is not the same
    // request under `exactOptionalPropertyTypes`.
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

/**
 * Prune the payload store on a schedule: rows past the retention window first,
 * then oldest-first until the size backstop is met.
 *
 * The first pass runs immediately, matching the Rust's `interval`, whose first
 * tick fires at once — a daemon restarted after a long gap should not carry a
 * fortnight of stale rows until the next hour comes round.
 */
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
