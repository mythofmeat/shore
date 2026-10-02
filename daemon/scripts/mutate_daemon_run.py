#!/usr/bin/env python3
"""Mutation pass over the daemon's startup wiring (#18, step 5).

Almost nothing in `run.ts` is a computation. What it holds is an *order*, and
every mutant below reorders or unhooks something that still lets the daemon
come up and answer — which is what makes them worth writing down.

**The registered address.** `--addr 127.0.0.1:0` asks the kernel for a port.
Recording the requested address instead writes a literal `:0` into
`instances.json`, and every discovery client dials a port nobody opened. The
daemon itself is fine, and nothing logs anything.

**The handshake.** Attach it to the wrong thing, or not at all, and a client
still connects and is still answered — with one character called `default` and
an empty conversation.

**The handler before the accept.** A connection that hand-shakes while nothing
is draining `Server.routes` queues its messages and is never answered. Reversed,
the daemon serves normally right up until the first client is fast.

**The push channels.** The engine's history listener and the autonomous-message
emit are how a conversation reaches a connected client. Unwired, everything is
still persisted; it just stops appearing.

**Shutdown.** Unregistering, closing the stores, and stopping the clocks each
leave a different corpse behind: a registry entry pointing at a dead pid, an
MCP child that outlives its parent, a keepalive still spending money.

# Two that cannot die

Both are ordering guarantees with no observable consequence in a test that
stops a healthy daemon, and both are kept because the failure they prevent
only appears under load or over time:

- **The handler is not awaited.** It returns when the route stream closes,
  which the server does on its way out — so on a quiet daemon the wait is
  already over before it starts. It matters when a turn is mid-write: autonomy
  persists its state next, and a turn still appending would be writing to a
  conversation whose turn count has already been recorded.
- **The clocks are not stopped.** `setInterval` handles are `unref`'d, so
  nothing observes them after the process would exit anyway. It matters for a
  caller that starts a second daemon in the same process — a test harness, or
  anything embedding this — where the first daemon's keepalive would keep
  spending against a runtime that has been shut down.

A mutant is KILLED if `bun test tests/daemon_run.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_daemon_run.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
R = "src/daemon/run.ts"
D = "src/handler/deps.ts"
H = "src/daemon/hot_reload.ts"

TESTS = ["tests/daemon_run.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the registered address ----------------------------------------------
    ("registry: the requested address is recorded, so port zero is written as zero",
     R,
     "  const resolvedAddr = formatAddr(bound.host, bound.port);",
     "  const resolvedAddr = startup.bindAddr;"),
    ("registry: the instance is registered under a fresh id, ignoring --instance-id",
     R,
     "  const instanceId = cli.instanceId ?? options.newInstanceId?.() ?? randomUUID();",
     "  const instanceId = options.newInstanceId?.() ?? randomUUID();"),
    ("registry: the resolved directories are left off, so a CLI cannot find the ledger",
     R,
     "    data_dir: dataLease.dataDir,\n    config_dir: loaded.dirs.config,",
     "    data_dir: undefined,\n    config_dir: undefined,"),
    ("registry: the pid is not this process, so the entry prunes itself as dead",
     R,
     "    pid: process.pid,",
     "    pid: 999_999_999,"),
    ("registry: nothing is registered at all",
     R,
     "    instances.register(info);",
     "    void info;"),

    # --- ordering -------------------------------------------------------------
    ("order: the bind address is taken from the config rather than the command line",
     R,
     "  const cli = parseArgs(options.argv ?? []);\n  const startup = resolveStartup(cli, env, {",
     '  const cli = parseArgs(options.argv ?? []);\n'
     '  const startup = resolveStartup({ ...cli, addr: undefined }, env, {'),
    ("order: nothing drains the route stream, so a client is answered by nobody",
     R,
     "  const handlerDone = handler.run(server.routes());",
     "  const handlerDone = Promise.resolve();"),
    ("order: the instance is registered before the bind, so a failed bind leaves an entry",
     R,
     "  } catch (e) {\n"
     "    dataLease.release();\n"
     "    throw new StartupError(\n"
     '      "server_run",',
     "  } catch (e) {\n"
     "    dataLease.release();\n"
     "    new Instances(options.instancesPath).register({\n"
     '      id: "early", pid: process.pid, addr: startup.bindAddr, started_at: "now",\n'
     "    });\n"
     "    throw new StartupError(\n"
     '      "server_run",'),

    # --- the handshake --------------------------------------------------------
    ("handshake: never attached, so every client is told about a character called default",
     R,
     "  server.setHandshakeProvider(handshake);",
     "  void handshake;"),
    ("handshake: the command path gets its own provider rather than the server's",
     R,
     "      handshake,\n      emitEvent:",
     "      handshake: { hello: () => Promise.resolve({ characters: [] }),\n"
     "                 history: () => Promise.resolve({ messages: [], activeStart: 0, config: {},\n"
     "                                                  selectedCharacter: null, revision: 0 }) },\n"
     "      emitEvent:"),

    # --- the push channels ----------------------------------------------------
    ("push: history changes are not broadcast, so a conversation stops appearing",
     R,
     "    onHistory: (history) => server.broadcast({ type: \"history\", ...history }),",
     "    onHistory: () => {},"),
    ("push: the broadcast is used for routed replies, so a command answers everyone",
     R,
     "    emitEvent: (message: ServerMessage) => server.broadcast(message),",
     "    emitEvent: () => {},"),

    # --- the config the runtime runs on ---------------------------------------
    ("config: the runtime re-reads the default path rather than the one started with",
     R,
     "      config: loaded,\n      configPath: startup.configPath,",
     "      config: loaded,\n      configPath: undefined,"),

    # --- shutdown -------------------------------------------------------------
    ("shutdown: the instance is left in the registry, pointing at a dead process",
     R,
     "      instances.unregister(instanceId);",
     "      void instanceId;"),
    ("shutdown: the handler is not waited for, so a turn may still be writing", R,
     '    await bounded(handlerDone, "message handler", log);',
     "    void handlerDone;"),
    ("shutdown: the runtime is never let go, so MCP children outlive the daemon",
     R,
     '    await bounded(runtime.shutdown(), "runtime", log);',
     "    void 0;"),
    ("shutdown: the clocks keep running, so the keepalive spends after the exit", R,
     "    clocks.stop();",
     "    void clocks;"),
    ("shutdown: a step that overruns wedges the exit instead of being abandoned",
     R,
     "    const result = await Promise.race([work.then(() => \"done\" as const), expiry]);",
     "    const result = await work.then(() => \"done\" as const);"),

    # --- the config watcher ---------------------------------------------------
    ("watch: the daemon does not watch its config directory at all",
     R,
     "    const watcher = options.watchConfig === false\n      ? undefined\n      : startConfigWatcher({",
     "    const watcher = true\n      ? undefined\n      : startConfigWatcher({"),
    ("watch: the watcher is pointed at the data directory rather than the config one",
     R,
     "        configDir: loaded.dirs.config,",
     "        configDir: loaded.dirs.data,"),
    ("reload: a config that will not parse is adopted, flapping through every keystroke",
     D,
     "      shoreLog.warn(\n"
     "        `shore: config hot reload failed, keeping the running config — ${where}: ${String(e)}`,\n"
     "      );\n"
     "      a.emitEvent(configWarning(a.runtime.configPath, undefined, e));\n"
     "      return;",
     "      shoreLog.warn(String(e));\n"
     "      config = a.runtime.config;"),
    ("reload: per-character overlays are not validated before the global is committed",
     D,
     "    for (const name of discoverCharacters(config.dirs.config, config.dirs.workspace)) {",
     "    for (const name of [] as string[]) {"),
    ("reload: a broken overlay warns and the config is adopted anyway",
     D,
     "        a.emitEvent(\n"
     '          configWarning(rustJoin(characterConfigDir(config.dirs.config, name), "config.toml"), name, e),\n'
     "        );\n        return;",
     "        a.emitEvent(\n"
     '          configWarning(rustJoin(characterConfigDir(config.dirs.config, name), "config.toml"), name, e),\n'
     "        );"),
    ("reload: the watcher path never adopts what it loaded",
     D,
     "    await applyReloadedConfig(a, config);",
     "    void config;"),

    # --- the address string ---------------------------------------------------
    ("addr: an IPv6 host is not bracketed, so the string splits on the wrong colon",
     R,
     '  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;',
     "  return `${host}:${port}`;"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
