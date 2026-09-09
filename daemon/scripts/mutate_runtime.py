#!/usr/bin/env python3
"""Mutation pass over the daemon's startup assembly (#18, step 5).

Assembly code is where a mistake is quietest: nothing throws, the daemon comes
up, and the damage shows up weeks later as a number nobody can explain. So the
mutants are the ways this file can be wrong while still starting.

**A store that is not there.** The ledger has to be *created*, not opened — a
reader that finds nothing memoises the failure and every call after it records
nothing, which reads as a quiet month in `shore usage` rather than as an error.
The call store is the mirror image: it must never be fatal, because refusing to
start over a diagnostic trades the service for the telemetry.

**A directory that is not there.** `<data>/plugins` is the root relative
`[mcp.*]` paths resolve against, so its absence is a server that will not start
with a path that looks right in the config.

**A wire that goes to the wrong place.** The keepalive's ping sender has to be
the same adapter table chat sends through; a ping through a different one warms
a prefix nothing will read, which costs money and buys nothing. The MCP `env`
map has to actually convert, because a `Map` that spreads to `{}` starts the
server without its token — and the only symptom is an auth failure in someone
else's logs.

**Diagnostic retention.** Starting the runtime must not prune captured calls.

A mutant is KILLED if `bun test tests/runtime.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_runtime.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
R = "src/runtime.ts"

TESTS = ["tests/runtime.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- stores ---------------------------------------------------------------
    ("ledger: opened instead of created, so a first run records nothing ever after",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     '  Ledger.open(rustJoin(config.dirs.data, "shore.db")).close();'),
    ("ledger: never touched at all",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     "  void config;"),
    ("ledger: created somewhere other than the data dir the recorders read",
     R,
     '  Ledger.create(rustJoin(config.dirs.data, "shore.db")).close();',
     '  Ledger.create(rustJoin(config.dirs.cache, "shore.db")).close();'),
    ("call store: a failed open becomes fatal, trading the daemon for its telemetry",
     R,
     "  } catch (e) {\n"
     "    shoreLog.warn(`shore: cannot open the call store at ${path}; capture disabled: ${String(e)}`);\n"
     "    return undefined;\n"
     "  }",
     "  } catch (e) {\n"
     "    throw e;\n"
     "  }"),

    # --- directories ----------------------------------------------------------
    ("dirs: the plugins root is not created, so relative [mcp.*] paths resolve nowhere",
     R,
     "    config.dirs.data,\n    pluginsDir(config.dirs.data),\n    config.dirs.cache,",
     "    config.dirs.data,\n    config.dirs.cache,"),
    ("dirs: created without recursion, so a fresh install stops at the first parent",
     R,
     "    mkdirSync(dir, { recursive: true });",
     "    mkdirSync(dir, { recursive: false });"),
    ("dirs: the cache dir is skipped, which the call store then cannot open under",
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
    # `KeepaliveService` calls its sender as `this.#send(ping)` at both sites,
    # so the signal parameter is never populated and dropping it changes
    # nothing. Kept as a recorded equivalent rather than deleted: it is the
    # mutant someone will write again, and the reason it cannot die belongs
    # beside it.
    # ("keepalive: pings are sent without the abort signal that bounds them", ...)
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
     "    mcpConfigView(config),\n    pluginsDir(config.dirs.data),\n    connect,",
     "    mcpConfigView(config),\n    config.dirs.data,\n    connect,"),
    ("registry: discovery walks the data dir instead of the config dir",
     R,
     "    config.dirs.config,\n    config.dirs.data,\n    config,",
     "    config.dirs.data,\n    config.dirs.data,\n    config,"),
    ("notify: a heartbeat's message is filed under the wrong toggle",
     R,
     '  return (title, body) => notifier.notify("autonomous_message", title, body);',
     '  return (title, body) => notifier.notify("compaction_complete", title, body);'),
    ("notify: an archived conversation is filed under the wrong toggle",
     R,
     '  return (title, body) => notifier.notify("compaction_complete", title, body);',
     '  return (title, body) => notifier.notify("autonomous_message", title, body);'),
    # Stubbing the `notify:` assignment itself survives, and the reason is a
    # coverage boundary rather than a gap. Its two ends are each pinned
    # elsewhere: which event is chosen, by the mutant above; that a delivered
    # heartbeat message calls `notify` at all, by `heartbeat_tick.test.ts`.
    # Killing the assignment in between needs a whole heartbeat driven through
    # `createRuntime`, which pins the assembly's plumbing by re-testing the
    # tick. Recorded rather than chased.
    # ("notify: the executor is handed a notifier bound to no event at all", ...)

    ("retention: starting runtime clocks purges retained diagnostics",
     R,
     "  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);",
     "  runtime.callStore?.rotate(new Date(), 0);\n"
     "  const keepaliveTimer = startKeepaliveTimer(runtime.keepalive, intervals.keepaliveMs);"),

]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
