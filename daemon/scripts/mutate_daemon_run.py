#!/usr/bin/env python3
"""Mutation pass over the daemon's startup wiring in `run.ts`: the order things
start in, what is attached, the instance registry, shutdown, and config
reloads.
"""
import sys

R = "src/daemon/run.ts"
D = "src/handler/deps.ts"

TESTS = ["tests/daemon_run.test.ts"]

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
     "  const handlerDone = messages.run(server.routes());",
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
     "                 history: () => Promise.resolve({ messages: [], previousSegment: null, config: {},\n"
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

    # --- draining before a stop -----------------------------------------------
    ("drain: a shutdown stops at once instead of waiting for running work",
     R,
     '        await bounded(idle, "running work", log, graceMs);',
     "        void idle;"),
    ("drain: new messages are still taken while the daemon drains",
     R,
     "        messages.close();\n",
     ""),
    ("drain: status never hears about the running work",
     R,
     "      running,\n      ...(log === undefined ? {} : { log }),",
     "      ...(log === undefined ? {} : { log }),"),
    ("drain: the grace period is ignored and the drain waits for ever",
     R,
     '        await bounded(idle, "running work", log, graceMs);',
     "        await idle;"),

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
