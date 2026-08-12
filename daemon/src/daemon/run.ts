import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { TurnAutonomyBridge } from "../autonomy/registration.ts";
import { Diagnostics } from "../diagnostics.ts";
import { emitNewMessageEvent } from "../handler/persistence.ts";
import type { SessionTokens } from "../handler/persistence.ts";
import { createDefaultConfig } from "../config/loader.ts";
import { superviseMatrixBridge } from "../connections/matrix/supervise.ts";
import { tokenMatches, TOKEN_ENV } from "../config/token.ts";
import { buildMessageHandlerDeps, configReloader } from "../handler/deps.ts";
import { MessageHandler } from "../handler/router.ts";
import { Instances, type InstanceInfo } from "./instances.ts";
import type { SidecarProvider, SidecarRequest } from "../llm/types.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../runtime.ts";
import { DEFAULT_PROVIDERS } from "../llm/providers/table.ts";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { Logger } from "../swp/connection.ts";
import { buildHandshakeProvider } from "../swp/handshake.ts";
import { Server } from "../swp/server.ts";
import { localRfc3339 } from "../util/time.ts";
import { startAutoDiscovery } from "./auto_discovery.ts";
import { startConfigWatcher } from "./hot_reload.ts";
import { parseArgs, resolveStartup, sourceLabel, StartupError } from "./startup.ts";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface DaemonOptions {
  argv?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  instancesPath?: string | undefined;
  log?: Logger | undefined;
  newInstanceId?: (() => string) | undefined;
  watchConfig?: boolean | undefined;
  autoDiscovery?: boolean | undefined;
}

export interface RunningDaemon {
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly runtime: ShoreRuntime;
  readonly server: Server;
  readonly done: Promise<void>;
  stop(): void;
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const log = options.log;
  const cli = parseArgs(options.argv ?? []);
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
    token_source: startup.token.source,
  });
  if (startup.token.source === "generated") {
    log?.info?.("Wrote a new client token", {
      path: startup.token.path ?? "",
      hint: `clients elsewhere need this value in $${TOKEN_ENV}`,
    });
  }
  const { loaded } = startup;
  const server = new Server({
    addr: startup.bindAddr,
    serverName: "shore-daemon",
    authenticate: (presented) => tokenMatches(startup.token.token, presented),
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
  const resolvedAddr = formatAddr(bound.host, bound.port);

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

  const diagnostics = new Diagnostics();

  const runtime = await createRuntime({
    config: loaded,
    configPath: startup.configPath,
    providers: options.providers,
    env,
    diagnostics,
    onHistory: (history) => server.broadcast({ type: "history", ...history } as ServerMessage),
    emit: (character, revision, msg) =>
      emitNewMessageEvent(
        (message) => server.broadcast(message),
        character,
        msg.origin ?? "autonomous",
        revision,
        msg,
      ),
  });

  const handshake = buildHandshakeProvider(runtime.registry);
  server.setHandshakeProvider(handshake);

  const clocks = startRuntimeClocks(runtime);

  const assembly = {
    runtime,
    providers: runtime.providers,
    autonomy: new TurnAutonomyBridge(runtime.autonomy),
    router: server.sessionRouter,
    handshake,
    emitEvent: (message: ServerMessage) => server.broadcast(message),
    sessionTokens: newSessionTokens(),
    diagnostics,
    env,
    ...(log === undefined ? {} : { log }),
  };
  const handler = new MessageHandler(buildMessageHandlerDeps(assembly));

  const handlerDone = handler.run(server.routes());

  const watcher = options.watchConfig === false
    ? undefined
    : startConfigWatcher({
        configPath: startup.configPath,
        configDir: loaded.dirs.config,
        reload: configReloader(assembly),
        knownCharacter: (name) => runtime.registry.hasCharacter(name),
        ...(loaded.dirs.workspace === undefined
          ? {}
          : { workspaceDir: loaded.dirs.workspace }),
        ...(log === undefined ? {} : { log }),
      });

  const discovery =
    options.autoDiscovery === false
      ? undefined
      : startAutoDiscovery({
          config: () => runtime.registry.globalConfig(),
          ...(log === undefined ? {} : { log }),
        });

  const matrixBridge = superviseMatrixBridge({
    config: loaded,
    server,
    env,
    ...(log === undefined ? {} : { log }),
  });
  matrixBridge.done.catch((e: unknown) => {
    log?.warn?.("Matrix bridge supervisor stopped", { error: String(e) });
  });

  const served = server.serve();

  const done = (async () => {
    await served;
    watcher?.stop();
    discovery?.stop();
    await bounded(matrixBridge.stop(), "matrix bridge", log);
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

export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return String(reason);
}

async function runDaemon(options: DaemonOptions): Promise<void> {
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

  const onUnhandledRejection = (reason: unknown) => {
    options.log?.warn?.("Unhandled rejection; the daemon is still running", {
      error: describeRejection(reason),
    });
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    await daemon.done;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off("unhandledRejection", onUnhandledRejection);
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
    console.error(e instanceof StartupError ? e.message : String(e));
    process.exit(1);
  }
}

function format(level: string, msg: string, fields?: Record<string, unknown>): string {
  const pairs = Object.entries(fields ?? {}).map(([k, v]) => ` ${k}=${String(v)}`);
  return `${level} ${msg}${pairs.join("")}`;
}

export function formatAddr(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function newSessionTokens(): SessionTokens {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
}

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
