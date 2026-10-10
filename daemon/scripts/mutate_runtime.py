#!/usr/bin/env python3
"""Mutation pass over the daemon's runtime assembly: directories, the ledger,
the keepalive, MCP, the registry, notifiers, and retention clocks.
"""
import sys

R = "src/runtime.ts"

TESTS = ["tests/runtime.test.ts"]

MUTANTS = [
    # --- stores ---------------------------------------------------------------
    ("ledger: opened instead of created, so calls a crash left pending stay pending after startup",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     '  Ledger.open(rustJoin(config.dirs.data, "shore.db")).close();'),
    ("ledger: never touched, so calls a crash left pending stay pending after startup",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     "  void config;"),
    ("ledger: recovered somewhere other than the data dir the recorders read",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     '  Ledger.create(rustJoin(config.dirs.cache, "shore.db")).close();'),

    # --- directories ----------------------------------------------------------
    ("dirs: the plugins root is not created, so relative [mcp.*] paths resolve nowhere",
     R,
     "    config.dirs.data,\n    pluginsDir(config.dirs.data),\n    config.dirs.cache,",
     "    config.dirs.data,\n    config.dirs.cache,"),
    ("dirs: created without recursion, so a fresh install stops at the first parent",
     R,
     "    mkdirSync(dir, { recursive: true });",
     "    mkdirSync(dir, { recursive: false });"),
    ("dirs: the cache dir is skipped, so a later start has none once the one-time image move stops making it",
     R,
     "    config.dirs.cache,\n    config.dirs.runtime,",
     "    config.dirs.runtime,"),

    # --- wiring ---------------------------------------------------------------
    ("keepalive: an unknown sdk pings nothing and reports success",
     R,
     "      const provider = providers[req.sdk];\n"
     "      if (!provider) throw new Error(`unsupported sdk: ${req.sdk}`);\n"
     "      return provider.generate(",
     "      const provider = providers[req.sdk];\n      return provider?.generate("),
    ("cache: built without the keepalive, so a real turn never arms a schedule",
     R,
     "  const cache = new LastRequestCache(keepalive);",
     "  const cache = new LastRequestCache();"),
    ("mcp: the env map is spread rather than converted, dropping every variable",
     R,
     "      env: Object.fromEntries(server.env),",
     "      env: { ...server.env },"),
    ("mcp: servers resolve against the data dir rather than its plugins root",
     R,
     "    mcpConfigView(config, env),\n    pluginsDir(config.dirs.data),\n    connect,",
     "    mcpConfigView(config, env),\n    config.dirs.data,\n    connect,"),
    ("registry: discovery walks the data dir instead of the config dir",
     R,
     "    config.dirs.config,\n    config.dirs.data,\n    config,",
     "    config.dirs.data,\n    config.dirs.data,\n    config,"),
    ("notify: a heartbeat's message is filed under the wrong toggle",
     R,
     '  return (title, body, picture) => notifier.notify("autonomous_message", title, body, picture);',
     '  return (title, body, picture) => notifier.notify("compaction_complete", title, body, picture);'),
    ("notify: an archived conversation is filed under the wrong toggle",
     R,
     '  return (title, body) => notifier.notify("compaction_complete", title, body);',
     '  return (title, body) => notifier.notify("autonomous_message", title, body);'),
    ("notify: the executor is handed a notifier that delivers nothing (NEEDS A SEAM — runtime.test.ts never "
     "drives a heartbeat through createRuntime; the toggle is pinned by the two mutants above, and that a "
     "heartbeat message notifies at all by heartbeat_tick.test.ts)",
     R,
     "      notifyAutonomousMessage: autonomousMessageNotifier(notifier),",
     "      notifyAutonomousMessage: () => {},"),

    ("retention: starting runtime clocks purges retained diagnostics",
     R,
     "  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);",
     "  runtime.callStore?.rotate(new Date(), 0);\n"
     "  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);"),

]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
