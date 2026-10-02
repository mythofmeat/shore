#!/usr/bin/env python3
"""Mutation pass over the turn/autonomy seam (#18, step 5).

Two halves, and both fail quietly.

**Reading the config.** Eight runner settings and four clock bounds, each a
plain field read. Swapping two of the same type changes nothing visible — a
wake interval used as a dormancy bound just makes a character go quiet, and a
`min_turns` read as `max_turns` compacts at the wrong length forever. Nothing
throws, and the only symptom is behaviour nobody ordered.

**Bridging the clocks.** A turn is synchronous and registration is not, so the
first turn for a character arrives before the loop knows it exists. Three
things follow, and each is a mutant:

- `ensureState` returns true *exactly once*. It is the only cue the caller gets
  to seed the activity tracker: twice double-seeds a heatmap, never leaves it
  blank until the character has talked for a fortnight.
- Deferred updates run in the order the turn made them. A user message landing
  after the compaction that followed it restarts an idle clock the compaction
  had just reset.
- `shouldCompactNow` answers immediately, and before registration it answers
  *no*. Yes takes a single-flight latch on a runner that does not exist, and
  nothing ever releases it. Once registered, it passes on whether the prompt is
  nearly full: dropped there, a crowded prompt waits for `max_turns` while
  messages fall out of it unarchived.

A mutant is KILLED if `bun test tests/autonomy_registration.test.ts` fails with
it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_registration.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
R = "src/autonomy/registration.ts"

TESTS = ["tests/autonomy_registration.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- reading the config ---------------------------------------------------
    ("config: the heartbeat switch is read as the loop's own",
     R,
     "    autonomyEnabled: autonomy.enabled,",
     "    autonomyEnabled: autonomy.heartbeat.enabled,"),
    ('config: the heartbeat is always disabled',
     R,
     '    heartbeatEnabled: autonomy.enabled,',
     '    heartbeatEnabled: false,'),
    ("config: min and max turns are swapped, so compaction fires at the wrong length",
     R,
     "    minTurns: compaction.min_turns,\n    maxTurns: compaction.max_turns,",
     "    minTurns: compaction.max_turns,\n    maxTurns: compaction.min_turns,"),
    ("config: the idle trigger and the archive window are swapped",
     R,
     "    idleTriggerSecs: Number(compaction.idle_trigger.asSecs()),\n"
     "    archiveAfterSecs: Number(compaction.archive_after.asSecs()),",
     "    idleTriggerSecs: Number(compaction.archive_after.asSecs()),\n"
     "    archiveAfterSecs: Number(compaction.idle_trigger.asSecs()),"),
    ("config: the idle trigger is read as milliseconds, firing 1000x too late",
     R,
     "    idleTriggerSecs: Number(compaction.idle_trigger.asSecs()),",
     "    idleTriggerSecs: Number(compaction.idle_trigger.asMillisExact()),"),
    ("config: the context ceiling is dropped, so a turn never compacts on size",
     R,
     "    maxContextTokens: compaction.max_context_tokens,",
     "    maxContextTokens: 0,"),

    # --- the clock ------------------------------------------------------------
    ("clock: the fallback interval is read in seconds, so a wake fires at once",
     R,
     "    defaultIntervalMs: Number(heartbeat.default_interval.asMillisExact()),",
     "    defaultIntervalMs: Number(heartbeat.default_interval.asSecs()),"),
    ("clock: the silence bound and the wake floor are swapped",
     R,
     "    maxSilentMs: Number(heartbeat.dormant_after_idle_time.asMillisExact()),\n"
     "    minIntervalMs: Number(heartbeat.min_interval.asMillisExact()),",
     "    maxSilentMs: Number(heartbeat.min_interval.asMillisExact()),\n"
     "    minIntervalMs: Number(heartbeat.dormant_after_idle_time.asMillisExact()),"),
    ("clock: the floor and the ceiling are swapped",
     R,
     "    minIntervalMs: Number(heartbeat.min_interval.asMillisExact()),\n"
     "    maxIntervalMs: Number(heartbeat.max_interval.asMillisExact()),",
     "    minIntervalMs: Number(heartbeat.max_interval.asMillisExact()),\n"
     "    maxIntervalMs: Number(heartbeat.min_interval.asMillisExact()),"),
    ("clock: the dormancy tick count comes from the wrong knob",
     R,
     "    maxIdleTicks: heartbeat.dormant_after_heartbeat_turns,",
     "    maxIdleTicks: heartbeat.wrap_up_grace_rounds,"),
    ("state: every character shares one state file at the data root",
     R,
     "    data_dir: `${config.dirs.data}/${character}`,",
     "    data_dir: config.dirs.data,"),

    # --- taking up a character ------------------------------------------------
    ("ensure: says yes every turn, re-seeding the activity tracker each time",
     R,
     "    if (this.#registered.has(character)) return false;",
     "    if (false as boolean) return false;"),
    ("ensure: says no the first time, so nothing is ever seeded",
     R,
     "    this.#registered.set(character, pending);\n    return true;",
     "    this.#registered.set(character, pending);\n    return false;"),
    ("ensure: the character is recorded only after registering, so a second turn starts another",
     R,
     "    const pending = this.#service.register(registrationFor(character, config)).catch((e: unknown) => {",
     "    const pending = (async () => {\n"
     "      await Promise.resolve();\n"
     "      return this.#service.register(registrationFor(character, config));\n"
     "    })().catch((e: unknown) => {"),
    ("ensure: a failed registration throws, taking the turn with it",
     R,
     "      shoreLog.warn(`shore: autonomy registration failed for ${character}: ${String(e)}`);\n    });",
     "      throw e;\n    });"),

    # --- the deferred updates -------------------------------------------------
    ("defer: updates run immediately, against a character the loop has not created",
     R,
     "    this.#registered.set(\n      character,\n      pending.then(fn).catch((e: unknown) => {",
     "    fn();\n    this.#registered.set(\n      character,\n      pending.catch((e: unknown) => {"),
    ("defer: each update races the registration instead of queueing (EQUIVALENT — every deferred fn is "
     "synchronous, and callbacks on one promise run in the order they were attached, so the two spellings "
     "agree; the chain is what keeps the order the day an update becomes async)",
     R,
     "    this.#registered.set(\n      character,\n      pending.then(fn)",
     "    ((_character: string, _chain: Promise<void>) => {})(\n      character,\n      pending.then(fn)"),
    ("defer: an update for an unregistered character is raised rather than dropped",
     R,
     "    if (pending === undefined) {",
     "    if (false as boolean) {"),
    ("assistant: the character's own turn is never reported, so the heartbeat thinks it is silent",
     R,
     "  onAssistantMessage(character: string, turnCount: number): void {\n"
     "    this.#after(character, () => {\n"
     "      this.#service.onAssistantMessage(character, turnCount);\n    });",
     "  onAssistantMessage(character: string, turnCount: number): void {\n"
     "    void this.#after;\n    void turnCount;\n    void character;"),
    # --- the reload -----------------------------------------------------------
    ("reload: one character's config is pushed to all of them, as the Rust's shared copy was",
     R,
     "        const config = effectiveConfig(character);",
     '        const config = effectiveConfig("ada");'),
    ("reload: heartbeat bounds still wait for a restart",
     R,
     "        this.#service.setHeartbeatConfig(character, clockConfigFor(config));",
     "        void clockConfigFor(config);"),
    ("reload: nobody is told, so an edited threshold waits for a restart",
     R,
     "    for (const character of Array.from(this.#registered.keys())) {",
     "    for (const character of [] as string[]) {"),
    ("reload: the push runs before the registration it belongs to",
     R,
     "      this.#after(character, () => {\n"
     "        const config = effectiveConfig(character);",
     "      ((fn: () => void) => fn())(() => {\n"
     "        const config = effectiveConfig(character);"),
    ("user: the timestamp is taken when the queue drains, not when the user spoke",
     R,
     "    const localAt = localWallClock(this.#now(), this.#zone);\n    this.#after(character, () => {\n"
     "      this.#service.onUserMessage(character, turnCount, localAt);\n    });",
     "    this.#after(character, () => {\n"
     "      this.#service.onUserMessage(character, turnCount, localWallClock(this.#now(), this.#zone));\n    });"),

    # --- the backfill ---------------------------------------------------------
    ("backfill: the latest user turn is the last in the list, which is the oldest",
     R,
     "    const latestUserAt = instants.length === 0 ? undefined : Math.max(...instants);",
     "    const latestUserAt = instants[instants.length - 1];"),
    ("backfill: an empty selection seeds the silence clock at -Infinity",
     R,
     "    const latestUserAt = instants.length === 0 ? undefined : Math.max(...instants);",
     "    const latestUserAt = Math.max(...instants);"),
    ("backfill: the histogram is sent without the latest turn, leaving the silence clock unseeded",
     R,
     "      this.#service.backfillActivity(character, localStamps, latestUserAt);",
     "      this.#service.backfillActivity(character, localStamps, undefined);"),

    # --- the question that cannot wait ----------------------------------------
    ("compact: an unregistered character is told to compact, taking a latch nothing releases",
     R,
     "    return this.#service.shouldCompactNow(character, turnCount, contextTokens, crowded) ?? false;",
     "    return this.#service.shouldCompactNow(character, turnCount, contextTokens, crowded) ?? true;"),
    ("compact: the service's yes is discarded, so nothing ever compacts inline",
     R,
     "    return this.#service.shouldCompactNow(character, turnCount, contextTokens, crowded) ?? false;",
     "    return false;"),
    ("compact: a crowded prompt is not passed on, so it waits for the usual triggers",
     R,
     "    return this.#service.shouldCompactNow(character, turnCount, contextTokens, crowded) ?? false;",
     "    return this.#service.shouldCompactNow(character, turnCount, contextTokens) ?? false;"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
