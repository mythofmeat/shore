/**
 * Starting the daemon: bind, assemble, register, serve, and stop cleanly.
 *
 * Ported from `run_daemon` and `build_server_and_handler` in
 * `crates/daemon/src/main.rs`. The policy this runs on is `startup.ts`; the
 * pieces it assembles are `runtime.ts` and `handler/deps.ts`. What is left here
 * is the *order*, and every step below is where it is for a reason.
 *
 * # The order
 *
 * ```text
 * resolveStartup            policy first: a refused bind opens nothing
 * new Server                the broadcast the registry is built with
 * server.bind()             a real port before anything records one
 * register instance         discovery can find it from here on
 * createRuntime             stores, MCP, characters, the autonomy loop
 * setHandshakeProvider      closes the cycle the broadcast opened
 * handler.run(routes)       a consumer before there can be a message
 * server.serve()            accept
 * ```
 *
 * Two of those are subtle enough to be worth stating.
 *
 * **Bind before the runtime.** Opening databases and spawning MCP servers takes
 * real time, and the one failure most likely at startup is a port already in
 * use — a second daemon, or the one systemd has not finished stopping. Binding
 * first means that failure costs nothing and is reported as itself.
 *
 * **The handler starts before `serve`.** A connection that hand-shakes while
 * nothing is draining {@link Server.routes} queues its messages and is never
 * answered. `bind` and `serve` are separate precisely so this can go between
 * them.
 *
 * # What is not here yet
 *
 * `spawn_background_services` had three tasks. Two have ported and start
 * below: the config watcher (`hot_reload.ts`) and provider auto-discovery
 * (`auto_discovery.ts`). The third, the sidecar supervisor, does not move at
 * all — it supervises the process this port is being written into.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { TurnAutonomyBridge } from "../autonomy/registration.ts";
import { Diagnostics } from "../diagnostics.ts";
import { emitNewMessageEvent } from "../handler/persistence.ts";
import type { SessionTokens } from "../handler/persistence.ts";
import { createDefaultConfig } from "../config/loader.ts";
import { buildMessageHandlerDeps, configReloader } from "../handler/deps.ts";
import { MessageHandler } from "../handler/router.ts";
import { Instances, type InstanceInfo } from "../instances.ts";
import type { SidecarProvider, SidecarRequest } from "../llm/types.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../runtime.ts";
import { DEFAULT_PROVIDERS } from "../llm/providers/table.ts";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { Logger } from "../swp/connection.ts";
import { buildHandshakeProvider } from "../swp/handshake.ts";
import { Server } from "../swp/server.ts";
import { localRfc3339 } from "../time.ts";
import { startAutoDiscovery } from "./auto_discovery.ts";
import { startConfigWatcher } from "./hot_reload.ts";
import { parseArgs, resolveStartup, sourceLabel, StartupError } from "./startup.ts";

/**
 * How long to wait for each shutdown step before giving up on it.
 *
 * Bounded rather than awaited outright, as the Rust's `tokio::time::timeout`
 * around every join. A hung MCP server must not be the difference between a
 * clean exit and systemd resorting to SIGKILL — at which point the autonomy
 * state file is what does not get written.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface DaemonOptions {
  /** `process.argv.slice(2)`. */
  argv?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** One adapter per dialect. Required, because the caller owns the table. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  /** Overridden by a test so a run does not touch the real registry file. */
  instancesPath?: string | undefined;
  log?: Logger | undefined;
  /** Injected so a test can pin the id it then looks for. */
  newInstanceId?: (() => string) | undefined;
  /**
   * Watch the config directory for edits. On by default.
   *
   * Off is for a test that is asserting something else: a recursive watch over
   * a temp directory turns every file the test writes into a config reload.
   */
  watchConfig?: boolean | undefined;
  /**
   * Refresh provider model lists on a schedule. On by default.
   *
   * Off is for a test, which must not make a network request to be told a
   * provider it invented is unreachable.
   */
  autoDiscovery?: boolean | undefined;
}

/** A daemon that is serving. */
export interface RunningDaemon {
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly runtime: ShoreRuntime;
  readonly server: Server;
  /** Resolves once the server has stopped and everything has been let go. */
  readonly done: Promise<void>;
  /** Ask it to stop. {@link RunningDaemon.done} is how you wait. */
  stop(): void;
}

/**
 * Bring a daemon up and return once it is accepting connections.
 *
 * Separate from {@link runDaemon} so a test can drive one without installing
 * process-wide signal handlers or waiting on a promise that only a signal
 * resolves.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const log = options.log;
  const cli = parseArgs(options.argv ?? []);
  // A first run has no `config.toml` and no config directory to put one in.
  // This is the only caller that opts into writing them — see
  // `createDefaultConfig`. Best-effort: it warns and returns `undefined` rather
  // than throwing, and the daemon comes up on an empty table either way.
  const startup = resolveStartup(cli, env, {
    createDefault: (configDir) => {
      const written = createDefaultConfig(configDir);
      if (written !== undefined) log?.info?.("Created default config.toml", { path: written });
    },
  });

  log?.info?.("Startup configuration resolved", {
    config_path: startup.configPath,
    bind_addr: startup.bindAddr,
    bind_addr_source: sourceLabel(startup.bindAddrSource),
    allow_remote_access: startup.allowRemoteAccess,
    allow_remote_access_source: startup.allowRemoteAccessSource,
  });
  for (const warning of startup.remoteAccessWarnings) {
    log?.warn?.("Daemon remote access warning", {
      addr: warning.addr,
      bind_addr_source: sourceLabel(warning.bindAddrSource),
      warning: warning.message,
    });
  }

  const { loaded } = startup;
  const server = new Server({
    addr: startup.bindAddr,
    allowedHosts: loaded.app.daemon.allowed_hosts,
    serverName: "shore-daemon",
    ...(log === undefined ? {} : { log }),
  });

  let bound: { host: string; port: number };
  try {
    bound = await server.bind();
  } catch (e) {
    throw new StartupError(
      "server_run",
      `Failed to start shore-daemon on ${startup.bindAddr}: ${String(e)}`,
    );
  }
  // The resolved address, not the requested one. `--addr 127.0.0.1:0` asks the
  // kernel to choose, and what goes in the registry has to be the port it
  // chose — a literal `:0` sends every discovery client somewhere unopened.
  const resolvedAddr = formatAddr(bound.host, bound.port);

  // `--instance-id` pins it, so `shore-mcp` can rediscover a daemon it spawned
  // earlier. Unset means a fresh one per startup.
  const instanceId = cli.instanceId ?? options.newInstanceId?.() ?? randomUUID();
  const instances =
    options.instancesPath === undefined ? new Instances() : new Instances(options.instancesPath);
  const info: InstanceInfo = {
    id: instanceId,
    pid: process.pid,
    addr: resolvedAddr,
    started_at: localRfc3339(new Date()),
    data_dir: loaded.dirs.data,
    config_dir: loaded.dirs.config,
  };
  try {
    instances.register(info);
  } catch (e) {
    throw new StartupError(
      "register_instance",
      `Failed to register daemon instance in ${instances.path}: ${String(e)}`,
    );
  }
  log?.info?.("Registered daemon instance", {
    instance_id: instanceId,
    registry_path: instances.path,
    addr: resolvedAddr,
    data_dir: loaded.dirs.data,
  });

  // Made before anything looks at it. A workspace root is created per character
  // by `ensureCharacterWorkspace`, so with no characters yet the root itself
  // never appears — and the watcher below cannot watch a directory that is not
  // there, which is exactly the first run where a character is about to be
  // created. Best-effort: a root that cannot be made is a warning here and an
  // error at the point something actually writes to it.
  if (loaded.dirs.workspace !== undefined) {
    try {
      mkdirSync(loaded.dirs.workspace, { recursive: true });
    } catch (e) {
      log?.warn?.("Could not create the workspace directory", {
        workspace_dir: loaded.dirs.workspace,
        error: String(e),
      });
    }
  }

  const runtime = await createRuntime({
    config: loaded,
    configPath: startup.configPath,
    providers: options.providers,
    env,
    // Both directions of the push channel the Rust cloned a `broadcast::Sender`
    // into. A state change in any engine is a `history` frame; a delivered
    // autonomous message is the incremental `new_message` beside it.
    onHistory: (history) => server.broadcast({ type: "history", ...history } as ServerMessage),
    emit: (character, revision, msg) =>
      emitNewMessageEvent(
        (message) => server.broadcast(message),
        character,
        // Already `autonomous` on everything that reaches here — this channel
        // has one producer — but taken from the message rather than asserted,
        // so a second producer would announce itself honestly.
        msg.origin ?? "autonomous",
        revision,
        msg,
      ),
  });

  // Closes the cycle: the provider answers out of the registry, and the
  // registry was built with the broadcast belonging to this server. One
  // provider, not two — the command path pushes a history snapshot through the
  // same answers a connecting client gets, and two would be two chances to
  // configure one of them differently.
  const handshake = buildHandshakeProvider(runtime.registry);
  server.setHandshakeProvider(handshake);

  const clocks = startRuntimeClocks(runtime);

  const assembly = {
    runtime,
    providers: options.providers,
    autonomy: new TurnAutonomyBridge(runtime.autonomy),
    router: server.sessionRouter,
    handshake,
    emitEvent: (message: ServerMessage) => server.broadcast(message),
    sessionTokens: newSessionTokens(),
    diagnostics: new Diagnostics(),
    env,
    ...(log === undefined ? {} : { log }),
  };
  const handler = new MessageHandler(buildMessageHandlerDeps(assembly));

  // Started, not awaited: it returns when the route stream closes, which is
  // shutdown. Before `serve`, so no message can arrive with nobody draining.
  const handlerDone = handler.run(server.routes());

  // Watched rather than polled, and it does exactly what `config_reload` does
  // — a file saved in the config directory and a client asking for a reload
  // are the same event as far as the daemon is concerned.
  const watcher = options.watchConfig === false
    ? undefined
    : startConfigWatcher({
        configPath: startup.configPath,
        configDir: loaded.dirs.config,
        reload: configReloader(assembly),
        // Read through the registry per event, not captured: the whole point
        // is that the answer changes the moment a reload adopts the character
        // this predicate let through.
        knownCharacter: (name) => runtime.registry.hasCharacter(name),
        ...(loaded.dirs.workspace === undefined
          ? {}
          : { workspaceDir: loaded.dirs.workspace }),
        ...(log === undefined ? {} : { log }),
      });

  // Reads the registry's config per pass rather than this one, so a provider
  // added to `config.toml` is picked up by the watcher above and discovered on
  // the next tick.
  const discovery =
    options.autoDiscovery === false
      ? undefined
      : startAutoDiscovery({
          config: () => runtime.registry.globalConfig(),
          ...(log === undefined ? {} : { log }),
        });

  const served = server.serve();

  const done = (async () => {
    await served;
    // Stopped first, and before anything is torn down: a reload that landed
    // after the registry had been let go would be adopting into nothing.
    watcher?.stop();
    discovery?.stop();
    // Ordered, and each step waits for the one before it. The server closing
    // its route queue is what ends the handler; the handler finishing is what
    // guarantees no turn is still writing when autonomy persists its state.
    await bounded(handlerDone, "message handler", log);
    clocks.stop();
    await bounded(runtime.autonomy.shutdown(), "autonomy", log);
    await bounded(runtime.shutdown(), "runtime", log);
    try {
      instances.unregister(instanceId);
      log?.info?.("Unregistered daemon instance", {
        instance_id: instanceId,
        registry_path: instances.path,
      });
    } catch (e) {
      log?.warn?.("Failed to unregister daemon instance", {
        instance_id: instanceId,
        registry_path: instances.path,
        error: String(e),
      });
    }
    log?.info?.("Daemon shut down cleanly");
  })();

  return {
    host: bound.host,
    port: bound.port,
    instanceId,
    runtime,
    server,
    done,
    stop: () => server.stop(),
  };
}

/**
 * Start a daemon and run it until a signal says otherwise.
 *
 * `SIGTERM` is what systemd sends and `SIGINT` is Ctrl-C; both mean the same
 * thing here. Registered once and removed on the way out, so a caller that
 * starts a second daemon in the same process does not inherit the first's.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const daemon = await startDaemon(options);

  const stop = (signal: NodeJS.Signals) => () => {
    options.log?.info?.(`Received ${signal}`);
    daemon.stop();
  };
  const handlers: [NodeJS.Signals, () => void][] = [
    ["SIGINT", stop("SIGINT")],
    ["SIGTERM", stop("SIGTERM")],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);

  try {
    await daemon.done;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (import.meta.main) {
  try {
    await runDaemon({
      argv: process.argv.slice(2),
      providers: DEFAULT_PROVIDERS,
      log: {
        info: (msg, fields) => console.error(format("INFO", msg, fields)),
        warn: (msg, fields) => console.error(format("WARN", msg, fields)),
      },
    });
  } catch (e) {
    // Every refusal in `startup.ts` says what to change; printing the message
    // alone rather than a stack is what makes that legible in `journalctl`.
    console.error(e instanceof StartupError ? e.message : String(e));
    process.exit(1);
  }
}

/** `LEVEL message key=value`, which is what `HumanLogFormat` produced. */
function format(level: string, msg: string, fields?: Record<string, unknown>): string {
  const pairs = Object.entries(fields ?? {}).map(([k, v]) => ` ${k}=${String(v)}`);
  return `${level} ${msg}${pairs.join("")}`;
}

/**
 * `host:port`, bracketing an IPv6 host.
 *
 * `SocketAddr`'s `Display` in the Rust, and the shape everything downstream
 * parses back: `instances.json` holds this string, and a client splits it on
 * the last colon.
 */
export function formatAddr(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Process-lifetime token totals, starting at zero. */
function newSessionTokens(): SessionTokens {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
}

/**
 * Wait for a shutdown step, but not forever.
 *
 * A step that overruns is logged and abandoned rather than retried: the next
 * one is more likely to matter than this one is to finish, and the whole
 * sequence is racing whatever is about to SIGKILL the process.
 */
export async function bounded(
  work: Promise<unknown>,
  what: string,
  log: Logger | undefined,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([work.then(() => "done" as const), expiry]);
    if (result === "timeout") {
      log?.warn?.("Shutdown step timed out", { step: what, timeout_ms: timeoutMs });
    }
  } catch (e) {
    log?.warn?.("Shutdown step failed", { step: what, error: String(e) });
  } finally {
    clearTimeout(timer);
  }
}
