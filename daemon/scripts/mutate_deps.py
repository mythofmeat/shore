#!/usr/bin/env python3
"""Mutation pass over the chat turn's assembly (#18, step 5).

Wiring fails quietly by construction: every mutant here type-checks, every one
of them runs, and none of them raises. What each changes is which of several
identically-shaped things a turn is handed.

**The two per-character backends.** `deferEdit` writes into one character's
queue and `activityStats` reads one character's tracker. Point either at the
data root and one character's self-edit is applied to another's prompt at the
next compaction; drop either and both quietly do nothing, which reads as "no
edits pending" and "no activity recorded". A chat turn's `set_next_wake` is the
same kind of wiring: bound to the wrong character it moves someone else's
heartbeat, and ignoring whether that character's heartbeat runner actually ticks
it reports a wake that never comes.

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

A mutant is KILLED if the handler assembly or runtime activity tests fail
with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_deps.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = "src/handler/deps.ts"
R = "src/runtime.ts"
CTX = "src/handler/tool_context.ts"
SVC = "src/autonomy/service.ts"

TESTS = ["tests/handler_deps.test.ts", "tests/runtime_activity.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the per-character tool backends --------------------------------------
    ("tools: deferred edits queue at the data root, so every character shares one",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      (dir, path) => queueDeferredEdit(dir, path, turn.thread),\n    ),",
     "    deferEdit: deferEditTo(runtime.config.dirs.data, queueDeferredEdit),"),
    ("tools: there is no deferred-edit queue, so a self-edit lands live",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      (dir, path) => queueDeferredEdit(dir, path, turn.thread),\n    ),",
     "    deferEdit: undefined,"),
    ("tools: the heatmap always reads the same character's tracker", R,
     "      const report = activity.activityStats(character, localWallClock(Date.now()), days);",
     '      const report = activity.activityStats("ada", localWallClock(Date.now()), days);'),
    ("tools: the heatmap discards its activity report, so every character reads as inactive", R,
     "      return report === undefined\n"
     "        ? undefined\n"
     "        : { stats: report.stats, turnCount: report.messageCount };",
     "      void report;\n      return undefined;"),
    ("tools: the heatmap ignores the window it was asked for", R,
     "      const report = activity.activityStats(character, localWallClock(Date.now()), days);",
     "      const report = activity.activityStats(character, localWallClock(Date.now()), undefined);"),
    ("tools: the turn count is dropped on the rename, so the heatmap has no total",
     R,
     "        : { stats: report.stats, turnCount: report.messageCount };",
     "        : { stats: report.stats, turnCount: 0 };"),
    ("tools: background heatmaps cannot see the character's activity tracker", R,
     "        activityStats: (character, localAt, days) => autonomy.activityStats(character, localAt, days),",
     "        activityStats: () => undefined,"),
    ("tools: a chat turn's sub-agents are handed no turn, so they cannot stream out", D,
     "    ...runtimeToolDeps(a, turn),",
     "    ...runtimeToolDeps(a),"),
    ("tools: the shared backends are dropped, so chat is offered less than a heartbeat", D,
     "    ...runtimeToolDeps(a, turn),",
     "    ...({} as Record<string, never>),"),

    # --- the autonomy surface -------------------------------------------------
    ("autonomy: the cached body is queued behind registration, leaving a live prefix unarmed", D,
     "    notifyLastRequest: (character, request, keepalive, thread) => {\n"
     "      cache.set(character, request as SidecarRequest, keepalive, true, thread);\n    },",
     "    notifyLastRequest: (character, request, keepalive, thread) => {\n"
     "      void bridge.settled(character).then(() => {\n"
     "        cache.set(character, request as SidecarRequest, keepalive, true, thread);\n"
     "      });\n    },"),
    ("autonomy: the assistant turn is reported to nobody",
     D,
     "    notifyAssistantMessage: (character, turnCount) => {\n"
     "      bridge.onAssistantMessage(character, turnCount);\n    },",
     "    notifyAssistantMessage: () => {},"),
    ("autonomy: only the model and the messages are cached, dropping the prefix's key", D,
     "      cache.set(character, request as SidecarRequest, keepalive, true, thread);",
     "      cache.set(\n"
     "        character,\n"
     "        { model: request.model, messages: request.messages } as SidecarRequest,\n"
     "        keepalive,\n        true,\n        thread,\n      );"),
    ("autonomy: the keepalive interval is dropped, so the armed prefix has no cadence", D,
     "      cache.set(character, request as SidecarRequest, keepalive, true, thread);",
     "      cache.set(character, request as SidecarRequest, undefined, true, thread);"),
    ("autonomy: the arming loses its ping count, so every model falls back to one ping", D,
     "      cache.set(character, request as SidecarRequest, keepalive, true, thread);",
     "      cache.set(character, request as SidecarRequest, {\n"
     "        intervalMs: keepalive.intervalMs,\n"
     "        pings: undefined,\n      }, true, thread);"),
    ("autonomy: the turn's thread is dropped, so a home thread moved off main arms main", D,
     "      cache.set(character, request as SidecarRequest, keepalive, true, thread);",
     "      cache.set(character, request as SidecarRequest, keepalive, true);"),

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
     "    if (ledger === null) return Promise.resolve([]);\n    return Promise.resolve(newlyCrossedBudgetWarnings(",
     '    if (ledger === null) throw new Error("no ledger");\n    return Promise.resolve(newlyCrossedBudgetWarnings('),

    # --- the command path -----------------------------------------------------
    ("config: reloads guess the path instead of re-reading the file startup read",
     D,
     "        return loadConfig(runtime.configPath, { ...(a.env === undefined ? {} : { env: a.env }), deferEnvironment: true });",
     "        return loadConfig(undefined, { ...(a.env === undefined ? {} : { env: a.env }), deferEnvironment: true });"),
    ("config: a file that stopped parsing fails the command that already succeeded",
     D,
     "      try {\n"
     "        return loadConfig(runtime.configPath, { ...(a.env === undefined ? {} : { env: a.env }), deferEnvironment: true });\n"
     "      } catch (e) {",
     "      try {\n"
     "        return loadConfig(runtime.configPath, { ...(a.env === undefined ? {} : { env: a.env }), deferEnvironment: true });\n"
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
    ("commands: every command is treated as read-only, so a disconnect aborts compaction",
     D,
     "  return changesState(descriptor, input);",
     "  return false && changesState(descriptor, input);"),
    ("commands: an unknown command is treated as read-only",
     D,
     "  if (descriptor === undefined) return true;",
     "  if (descriptor === undefined) return false;"),
    ("threads: an unset thread is not the home thread, so two clients on one conversation see different turns",
     D,
     "      return registry.homeThread(character);",
     "      return selected;"),
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
    ("wake: a chat turn's set_next_wake reaches no clock",
     D,
     "    scheduleNextWake: (character, hours, reason) =>\n"
     "      runtime.autonomy.heartbeatsRunning(character)\n"
     "        ? runtime.autonomy.scheduleNextWake(character, hours, reason)\n"
     "        : undefined,\n",
     ""),
    ("wake: a chat turn's set_next_wake moves another character's heartbeat",
     D,
     "runtime.autonomy.scheduleNextWake(character, hours, reason)",
     'runtime.autonomy.scheduleNextWake("nova", hours, reason)'),
    ("wake: a chat turn's set_next_wake reaches the clock without its reason",
     D,
     "runtime.autonomy.scheduleNextWake(character, hours, reason)",
     'runtime.autonomy.scheduleNextWake(character, hours, "")'),
    ("wake: the tool context binds the wake to a fixed character",
     CTX,
     "scheduleNextWake(charName, hours, reason)",
     'scheduleNextWake("nova", hours, reason)'),
    ("wake: with heartbeats off, a wake is still scheduled and reported",
     D,
     "runtime.autonomy.heartbeatsRunning(character)\n        ? ",
     "true\n        ? "),
    ("wake: a registered runner reads as ticking whether or not its heartbeat is on",
     SVC,
     "?.runner.heartbeatMayTick ?? false",
     " !== undefined"),
    ("notify: a failed generation is filed under the wrong event's toggle",
     D,
     "    notify: (event, title, body) => {\n      notifier.notify(event, title, body);\n    },",
     "    notify: (_event, title, body) => {\n"
     '      notifier.notify("message_complete", title, body);\n    },'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
