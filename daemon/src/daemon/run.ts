import { shoreLog } from "../log.ts";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { TurnAutonomyBridge } from "../autonomy/registration.ts";
import { Diagnostics } from "../diagnostics.ts";
import { emitNewMessageEvent } from "../handler/persistence.ts";
import { createDefaultConfig } from "../config/loader.ts";
import { superviseMatrixBridge } from "../connections/matrix/supervise.ts";
import { tokenMatches, TOKEN_ENV } from "../config/token.ts";
import { buildMessageHandlerDeps, configReloader } from "../handler/deps.ts";
import { MessageHandler } from "../handler/router.ts";
import { ensureAndBackfillAutonomy } from "../handler/turn.ts";
import { Instances, type InstanceInfo } from "./instances.ts";
import type { SidecarProvider, SidecarRequest } from "../llm/types.ts";
import {
  createRuntime,
  startRuntimeClocks,
  type RuntimeClockIntervals,
  type ShoreRuntime,
} from "../runtime.ts";
import { DEFAULT_PROVIDERS } from "../llm/providers/table.ts";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { Logger } from "../swp/connection.ts";
import { buildHandshakeProvider } from "../swp/handshake.ts";
import { Server } from "../swp/server.ts";
import type { RunningWebServer } from "../web/server.ts";
import { localRfc3339 } from "../util/time.ts";
import { startAutoDiscovery } from "./auto_discovery.ts";
import { acquireDataDirectoryLease } from "./data_directory_lease.ts";
import { startConfigWatcher } from "./hot_reload.ts";
import { parseArgs, resolveStartup, sourceLabel, StartupError } from "./startup.ts";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function registerKnownCharacters(
  runtime: ShoreRuntime,
  bridge: TurnAutonomyBridge,
  log: Logger | undefined,
): Promise<void> {
  const characters = runtime.registry.availableCharacters();
  for (const character of characters) {
    bridge.ensureState(character, runtime.registry.effectiveConfig(character));
  }
  await Promise.all(characters.map((character) => bridge.settled(character)));
  if (characters.length > 0) {
    log?.info?.("Autonomy started for known characters", {
      characters: characters.join(", "),
    });
  }
}

function seedActivityInBackground(
  runtime: ShoreRuntime,
  bridge: TurnAutonomyBridge,
  log: Logger | undefined,
): void {
  void (async () => {
    for (const character of runtime.registry.availableCharacters()) {
      if (!bridge.needsActivityBackfill(character)) continue;
      const started = performance.now();
      try {
        const engine = await runtime.registry.getOrCreate(character);
        await ensureAndBackfillAutonomy(
          { autonomy: bridge },
          engine,
          character,
          runtime.registry.effectiveConfig(character),
        );
        log?.info?.("Seeded activity from history", {
          character,
          took_ms: Math.round(performance.now() - started),
        });
      } catch (e) {
        shoreLog.warn(`shore: could not seed ${character}'s activity from history: ${String(e)}`);
      }
    }
  })();
}

export interface DaemonOptions {
  argv?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  instancesPath?: string | undefined;
  log?: Logger | undefined;
  newInstanceId?: (() => string) | undefined;
  watchConfig?: boolean | undefined;
  autoDiscovery?: boolean | undefined;
  clockIntervals?: RuntimeClockIntervals | undefined;
}

export interface RunningDaemon {
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly runtime: ShoreRuntime;
  readonly server: Server;
  readonly web?: RunningWebServer;
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
  const instanceId = cli.instanceId ?? options.newInstanceId?.() ?? randomUUID();
  const startedAt = localRfc3339(new Date());
  let dataLease: ReturnType<typeof acquireDataDirectoryLease>;
  try {
    dataLease = acquireDataDirectoryLease(loaded.dirs.data, {
      instanceId,
      startedAt,
    });
  } catch (e) {
    throw new StartupError(
      "own_data_directory",
      `Failed to claim the Shore data directory ${loaded.dirs.data}: ${String(e)}`,
    );
  }
  log?.info?.("Claimed Shore data directory", {
    instance_id: instanceId,
    data_dir: dataLease.dataDir,
    ownership_path: dataLease.path,
  });
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
    dataLease.release();
    throw new StartupError(
      "server_run",
      `Failed to start shore-daemon on ${startup.bindAddr}: ${String(e)}`,
    );
  }
  const resolvedAddr = formatAddr(bound.host, bound.port);

  let web: RunningWebServer | undefined;
  try {
    if (loaded.app.daemon.web.enabled) {
      const { startWebServer } = await import("../web/server.ts");
      web = startWebServer({
        config: loaded.app.daemon.web,
        server,
        authenticate: (presented) => tokenMatches(startup.token.token, presented),
        recovery: { dataDir: dataLease.dataDir, cacheDir: loaded.dirs.cache, token: startup.token.token },
      });
    }
  } catch (error) {
    server.stop();
    await server.serve();
    dataLease.release();
    throw new StartupError("server_run", `Failed to start browser transport: ${String(error)}`);
  }

  const instances =
    options.instancesPath === undefined ? new Instances() : new Instances(options.instancesPath);
  const info: InstanceInfo = {
    id: instanceId,
    pid: process.pid,
    addr: resolvedAddr,
    started_at: startedAt,
    data_dir: dataLease.dataDir,
    config_dir: loaded.dirs.config,
  };
  try {
    instances.register(info);
  } catch (e) {
    await web?.stop();
    server.stop();
    await server.serve();
    dataLease.release();
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

  const rollback: (() => void | Promise<void>)[] = [() => { instances.unregister(instanceId); }];
  try {
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
      onHistory: (history) => server.broadcast({ type: "history", ...history }),
      emit: (character, revision, msg, thread) =>
        emitNewMessageEvent(
          (message) => server.broadcast(message),
          character,
          msg.origin ?? "autonomous",
          revision,
          msg,
          thread,
        ),
    });
    rollback.push(async () => { await runtime.shutdown(); });
    rollback.push(async () => { await runtime.autonomy.shutdown(); });

    const handshake = buildHandshakeProvider(runtime.registry);
    server.setHandshakeProvider(handshake);

    const assembly = {
      runtime,
      providers: runtime.providers,
      autonomy: new TurnAutonomyBridge(runtime.autonomy),
      router: server.sessionRouter,
      handshake,
      emitEvent: (message: ServerMessage) => server.broadcast(message),
      diagnostics,
      env,
      ...(log === undefined ? {} : { log }),
    };
    await registerKnownCharacters(runtime, assembly.autonomy, log);
    seedActivityInBackground(runtime, assembly.autonomy, log);
    const clocks = startRuntimeClocks(runtime, options.clockIntervals ?? {});
    rollback.push(() => { clocks.stop(); });

    const handler = new MessageHandler(buildMessageHandlerDeps(assembly));
    server.setControlHandler((routed) => handler.handleControl(routed));

    const handlerDone = handler.run(server.routes());
    rollback.push(async () => { await handlerDone; });
    web?.activate();
    if (web !== undefined) log?.info?.("Browser transport listening", { origin: web.origin });
    const reloadConfig = configReloader(assembly);

    const watcher = options.watchConfig === false
      ? undefined
      : startConfigWatcher({
          configPath: startup.configPath,
          configDir: loaded.dirs.config,
          reload: async (changedPaths) =>
            await runtime.snapshotGate.withActivity(async () => await reloadConfig(changedPaths)),
          knownCharacter: (name) => runtime.registry.hasCharacter(name),
          ...(loaded.dirs.workspace === undefined
            ? {}
            : { workspaceDir: loaded.dirs.workspace }),
          ...(log === undefined ? {} : { log }),
        });
    rollback.push(async () => { await watcher?.stop(); });

    const discovery =
      options.autoDiscovery === false
        ? undefined
        : startAutoDiscovery({
            config: () => runtime.registry.globalConfig(),
            ...(log === undefined ? {} : { log }),
          });
    rollback.push(() => { discovery?.stop(); });

    const matrixBridge = superviseMatrixBridge({
      config: loaded,
      server,
      env,
      ...(log === undefined ? {} : { log }),
    });
    rollback.push(async () => { await matrixBridge.stop(); });
    matrixBridge.done.catch((e: unknown) => {
      log?.warn?.("Matrix bridge supervisor stopped", { error: String(e) });
    });

    const served = server.serve();

    const done = (async () => {
      await served;
      if (web !== undefined) await bounded(web.stop(), "browser transport", log);
      await watcher?.stop();
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
      if (!dataLease.release()) {
        log?.warn?.("Could not release Shore data-directory ownership", {
          instance_id: instanceId,
          data_dir: dataLease.dataDir,
          ownership_path: dataLease.path,
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
      ...(web === undefined ? {} : { web }),
      done,
      stop: () => {
        void web?.stop().catch((error: unknown) => {
          log?.warn?.("Browser transport shutdown failed", { error: String(error) });
        });
        server.stop();
      },
    };
  } catch (error) {
    server.stop();
    await Promise.allSettled([web?.stop(), server.serve()]);
    for (const cleanup of rollback.reverse()) {
      try { await cleanup(); }
      catch (failure) { log?.warn?.("Startup cleanup failed", { error: String(failure) }); }
    }
    dataLease.release();
    throw new StartupError("server_run", `Failed to initialize shore-daemon: ${String(error)}`);
  }
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
        info: (msg, fields) => shoreLog.error(format("INFO", msg, fields)),
        warn: (msg, fields) => shoreLog.error(format("WARN", msg, fields)),
        error: (msg, fields) => shoreLog.error(format("ERROR", msg, fields)),
      },
    });
  } catch (e) {
    shoreLog.error(e instanceof StartupError ? e.message : String(e));
    // eslint-disable-next-line unicorn/no-process-exit
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
