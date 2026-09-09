#!/usr/bin/env python3
"""Mutation pass over the chat turn's assembly (#18, step 5).

Wiring fails quietly by construction: every mutant here type-checks, every one
of them runs, and none of them raises. What each changes is which of several
identically-shaped things a turn is handed.

**The two per-character backends.** `deferEdit` writes into one character's
queue and `activityStats` reads one character's tracker. Point either at the
data root and one character's self-edit is applied to another's prompt at the
next compaction; drop either and both quietly do nothing, which reads as "no
edits pending" and "no activity recorded".

**The cached request.** One compaction runner serves every character, so the
body it extends has to be looked up per pass. A fixed one hands Ada's
conversation to Nova's compaction — same shape, entirely the wrong bytes, and
nothing downstream can tell.

**What is read live.** `[usage]` and the keepalive ceiling come off the
registry's global config on each call. Captured at assembly instead, they answer
with whatever the daemon started with for the rest of the process, and a budget
added by `shore config` is simply never enforced.

**The budget check.** It is a read that writes: each threshold it reports is
marked delivered. It must not run when no budget is configured — an open per
turn to be told there is nothing to say — and it must not fail a turn that has
already been persisted and answered.

A mutant is KILLED if `bun test tests/handler_deps.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_deps.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = "src/handler/deps.ts"

TESTS = ["tests/handler_deps.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the per-character tool backends --------------------------------------
    ("tools: deferred edits queue at the data root, so every character shares one",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      queueDeferredEdit,\n    ),",
     "    deferEdit: deferEditTo(runtime.config.dirs.data, queueDeferredEdit),"),
    ("tools: there is no deferred-edit queue, so a self-edit lands live",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      queueDeferredEdit,\n    ),",
     "    deferEdit: undefined,"),
    ("tools: the heatmap always reads the same character's tracker", D,
     "      const report = runtime.autonomy.activityStats(\n        charName,",
     '      const report = runtime.autonomy.activityStats(\n        "ada",'),
    ("tools: the heatmap is never wired, so every character reads as inactive", D,
     "      return report === undefined\n"
     "        ? undefined\n"
     "        : { stats: report.stats, turnCount: report.messageCount };",
     "      void report;\n      return undefined;"),
    ("tools: the heatmap ignores the window it was asked for", D,
     "        localWallClock(Date.now()),\n        days,",
     "        localWallClock(Date.now()),\n        undefined,"),
    ("tools: the turn count is dropped on the rename, so the heatmap has no total",
     D,
     "        : { stats: report.stats, turnCount: report.messageCount };",
     "        : { stats: report.stats, turnCount: 0 };"),
    ("tools: a chat turn's sub-agents are handed no turn, so they cannot stream out", D,
     "      ...(a.env === undefined ? {} : { env: a.env }),\n      turn,\n    }),",
     "      ...(a.env === undefined ? {} : { env: a.env }),\n    } as never),"),
    ("tools: the shared backends are dropped, so chat is offered less than a heartbeat", D,
     "    ...sharedToolDeps(runtime.config, runtime.mcp, {\n"
     "      providers: a.providers,\n"
     "      registry: runtime.registry,\n"
     "      ...(runtime.callStore === undefined ? {} : { callStore: runtime.callStore }),\n"
     "      ...(a.env === undefined ? {} : { env: a.env }),\n"
     "      turn,\n"
     "    }),",
     "    ...({} as Record<string, never>),"),

    # --- the autonomy surface -------------------------------------------------
    ("autonomy: the cached body is queued behind registration, leaving a live prefix unarmed", D,
     "    notifyLastRequest: (character, request, keepalive) => {\n"
     "      cache.set(character, request as SidecarRequest, keepalive);\n    },",
     "    notifyLastRequest: (character, request, keepalive) => {\n"
     "      void bridge.settled(character).then(() => {\n"
     "        cache.set(character, request as SidecarRequest, keepalive);\n"
     "      });\n    },"),
    ("autonomy: the assistant turn is reported to nobody",
     D,
     "    notifyAssistantMessage: (character, turnCount) => {\n"
     "      bridge.onAssistantMessage(character, turnCount);\n    },",
     "    notifyAssistantMessage: () => {},"),
    ("autonomy: only the model and the messages are cached, dropping the prefix's key", D,
     "      cache.set(character, request as SidecarRequest, keepalive);",
     "      cache.set(\n"
     "        character,\n"
     "        { model: request.model, messages: request.messages } as SidecarRequest,\n"
     "        keepalive,\n      );"),
    ("autonomy: the keepalive interval is dropped, so the armed prefix has no cadence", D,
     "      cache.set(character, request as SidecarRequest, keepalive);",
     "      cache.set(character, request as SidecarRequest, undefined);"),
    ("autonomy: the arming loses its ceiling, so every model falls back to the global", D,
     "      cache.set(character, request as SidecarRequest, keepalive);",
     "      cache.set(character, request as SidecarRequest, {\n"
     "        intervalMs: keepalive?.intervalMs,\n"
     "        maxSecs: undefined,\n      });"),

    # --- the inline compaction ------------------------------------------------

    # --- what is read live ----------------------------------------------------
    ("live: the usage config is captured at assembly, so a new budget never applies", D,
     "  const usage = (character: string) =>\n"
     "    usageConfigView(runtime.registry.effectiveConfig(character).app.usage);",
     "  const captured = usageConfigView(global().app.usage);\n"
     "  const usage = (_character: string) => captured;"),
    ("live: every character is budgeted against the global config, not its own overlay", D,
     "    usageConfigView(runtime.registry.effectiveConfig(character).app.usage);",
     "    usageConfigView(global().app.usage);"),
    ("live: the keepalive ceiling is captured at assembly and never moves again",
     D,
     "    keepaliveMaxSecs: () =>\n"
     "      Number(global().app.cache.keepalive_max.asSecs()),",
     "    keepaliveMaxSecs: (() => {\n"
     "      const secs = Number(global().app.cache.keepalive_max.asSecs());\n"
     "      return () => secs;\n    })(),"),
    ("live: the ceiling is read in milliseconds, so it never expires",
     D,
     "      Number(global().app.cache.keepalive_max.asSecs()),",
     "      Number(global().app.cache.keepalive_max.asMillisExact()),"),
    ("live: the config is read off the startup snapshot rather than the registry",
     D,
     "  const global = () => runtime.registry.globalConfig();",
     "  const global = () => runtime.config;"),

    # --- the ledger and the budget check --------------------------------------
    ("ledger: the path is the data root itself, so nothing is ever recorded",
     D,
     '  const ledgerPath = rustJoin(dataDir, "shore.db");',
     "  const ledgerPath = dataDir;"),
    ("budget: the ledger is opened on every turn, whether or not a budget exists",
     D,
     "    if (config === undefined || (config.budgets ?? []).length === 0) {\n"
     "      return Promise.resolve([]);\n    }",
     "    if (config === undefined) {\n      return Promise.resolve([]);\n    }"),
    ("budget: a configured budget is skipped, so nothing is ever warned about",
     D,
     "    if (config === undefined || (config.budgets ?? []).length === 0) {",
     "    if (true as boolean) {\n      return Promise.resolve([]);\n    }\n    if (config === undefined) {"),
    ("budget: an unopenable ledger fails the turn instead of reporting nothing",
     D,
     "    if (ledger === null) return Promise.resolve([]);",
     '    if (ledger === null) throw new Error("no ledger");'),

    # --- the command path -----------------------------------------------------
    ("config: reloads guess the path instead of re-reading the file startup read",
     D,
     "        return loadConfig(runtime.configPath, a.env === undefined ? {} : { env: a.env });",
     "        return loadConfig(undefined, a.env === undefined ? {} : { env: a.env });"),
    ("config: a file that stopped parsing fails the command that already succeeded",
     D,
     "      try {\n"
     "        return loadConfig(runtime.configPath, a.env === undefined ? {} : { env: a.env });\n"
     "      } catch (e) {",
     "      try {\n"
     "        return loadConfig(runtime.configPath, a.env === undefined ? {} : { env: a.env });\n"
     "      } catch (e) {\n"
     "        throw e;\n      }\n      // eslint-disable-next-line\n      try {\n"
     "        throw new Error();\n      } catch (e) {"),
    ("set: the runtime override never reaches the registry, so the loop reads the old one",
     D,
     "      runtime.registry.setRuntimeEffectiveConfig(character, config);",
     "      void character;\n      void config;"),
    ("set: the loop is never told, so an edited threshold waits for a restart",
     D,
     "    reloadRuntimeConfig: () => {\n"
     "      a.autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));\n    },\n\n"
     "    homeThread:",
     "    reloadRuntimeConfig: () => {},\n\n    homeThread:"),
    ("home: the heartbeat's thread is guessed rather than asked of the registry",
     D,
     "    homeThread: (character) => runtime.registry.homeThread(character),",
     '    homeThread: () => "main",'),
    ("adopt: the registry never re-scans, so a character added at runtime stays invisible",
     D,
     "  const summary = await a.runtime.registry.reloadRuntimeState(config);",
     "  const summary = {\n"
     "    characterDiscoveryChanged: false,\n"
     "    droppedEngines: 0,\n  };\n  void config;"),
    ("adopt: discovery changes are reported as engine drops and the client invalidates the wrong cache",
     D,
     "    characterDiscoveryChanged: summary.characterDiscoveryChanged,\n"
     "    droppedEngines: summary.droppedEngines,",
     "    characterDiscoveryChanged: summary.droppedEngines > 0,\n"
     "    droppedEngines: summary.droppedEngines,"),
    ("prompt: the cached body survives a prompt refresh, keeping a dead prefix warm",
     D,
     '      runtime.cache.invalidate(character, "prompt_reload");',
     "      void character;"),
    ("keepalive: the ping diagnostic is armed against a second, empty cache",
     D,
     "      lastRequest: runtime.cache,",
     "      lastRequest: { get: () => undefined, set: () => {} } as never,"),
    ("commands: the ledger is the data root, so `shore usage` reports nothing",
     D,
     '  const ledgerPath = rustJoin(runtime.config.dirs.data, "shore.db");',
     "  const ledgerPath = runtime.config.dirs.data;"),
    ("commands: payload capture is hidden from `shore log`",
     D,
     "    callStore: runtime.callStore,",
     "    callStore: undefined,"),

    # --- the handler ----------------------------------------------------------
    ("leases: one map is shared by every handler, so a lease names another daemon's session",
     D,
     "    leases: new StreamLeases(a.log),",
     "    leases: ((globalThis as Record<string, unknown>)[\"__leases\"] ??= new StreamLeases(a.log)) as StreamLeases,"),
    ("resolve: `null` is asked for as a character named that rather than as an absence",
     D,
     "        return { name: registry.resolveCharacter(selected ?? undefined) };",
     '        return { name: registry.resolveCharacter(selected ?? "") };'),
    ("resolve: the registry's sentence is replaced by one that names nothing",
     D,
     "        return { error: e instanceof CharacterError ? e.message : String(e) };",
     '        void e;\n        return { error: "no character" };'),
    ("resolve: an unexpected failure is rethrown, taking the route loop with it",
     D,
     "        return { error: e instanceof CharacterError ? e.message : String(e) };",
     "        if (!(e instanceof CharacterError)) throw e;\n        return { error: e.message };"),
    ("notify: a failed generation is filed under the wrong event's toggle",
     D,
     "    notify: (event, title, body) => {\n      notifier.notify(event, title, body);\n    },",
     "    notify: (_event, title, body) => {\n"
     '      notifier.notify("message_complete", title, body);\n    },'),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
