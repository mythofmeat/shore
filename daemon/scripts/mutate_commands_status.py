#!/usr/bin/env python3
"""Mutation pass over the autonomy half of `status.rs` (#18 / #12).

`status` is what `shore status` renders and the single richest response the
daemon produces. Most of it is a projection, and a projection is exactly the
kind of code where a wrong answer is well-formed: every field is present, every
type is right, and the number is off. What the fixture has to catch:

- **The unit conversions.** Four config-derived fields are milliseconds on this
  side and whole seconds on the wire, and the Rust truncated rather than
  rounding. A sub-second bound is the only input where those differ, which is
  why `custom_bounds` has one.
- **The sign of `seconds_until_wake`.** Documented as "negative if overdue",
  and both directions truncate towards zero rather than flooring. A wake 45
  seconds in the past is the case that separates `trunc` from `floor`.
- **The saturation of `seconds_since_user`.** `Instant::duration_since` clamps
  at zero, so a `last_user_at` in the future reads as ten minutes ahead *and*
  zero seconds ago. `future_user` is the only case where those two disagree.
- **Presence versus null.** Four fields are `skip_serializing_if` and two more
  (`autonomy`, `activity`) are null-when-absent. Both are things the CLI
  branches on, and `toEqual` alone cannot tell a missing key from an
  `undefined` one — hence the explicit key-set assertions.
- **The renames.** The scheduler's vocabulary is not the CLI's:
  `max_idle_ticks` becomes `dormant_after_heartbeat_turns`,
  `default_interval_ms` becomes `effective_interval_secs`, and `character` and
  `covered_turn_count` are dropped rather than carried.
- **Two counts under four names.** `message_count`/`turn_count` appear in the
  envelope and again inside `activity`, and the two pairs are different
  numbers — the conversation's turns versus what the tracker recorded.
- **Which controls error and which do not.** `heartbeat_log` answers with an
  empty list for a character nobody registered; the three heartbeat controls
  raise `invalid_request` for the same character.

A mutant is KILLED if `bun test tests/status.test.ts` fails with it
applied.

This is **55/55**, from 50/56 on the first pass. Five of the six survivors were
fixed; the sixth was equivalent and was removed rather than chased.

**Three were sub-second effects the fixture's tolerance could not see.** The
four clock-derived fields are checked against the offset their setup arranged,
with two seconds of slack — so truncating downwards instead of towards zero
(one second) and dropping or keeping a fractional part (a millisecond) both
passed. Neither can be pinned through the fixture, because the Rust builds
those fields from `Instant::now()` and has no clock to inject. They are
asserted directly instead, in "the clock arithmetic" — values read off
`duration_secs_i64` and `SecondsFormat::AutoSi` rather than recorded from a
run, and fed through `autonomyWire` with a fabricated status and an exact
`now`. The same shape as the error-prefix assertions in
`mutate_commands_call_log.py`, for the same reason.

**One was a log too short to reach its own default.** Seven events meant
`heartbeat_log`'s limit of 20, a limit of 10 and no limit at all were the same
query. Twenty-five events make the default a boundary.

**One was a command whose reply says nothing about what it did.**
`heartbeat_set_dormant` and `heartbeat_set_active` both answer with a constant,
so swapping which state they force left the recorded response identical. The
generator now records the scheduler state *after* each control runs —
`heartbeat_state`, `ticks_without_user` and whether a wake is armed — which is
where the difference actually lives.

The removed one: `sinceSecs` flooring rather than truncating. It clamps at
zero, and the two round identically on non-negative values, so no input can
distinguish them. Documented on the helper.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_status.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/status.ts"

# (label, find, replace)
MUTANTS = [
    # --- unit conversions -----------------------------------------------------
    ("secs: milliseconds are rounded rather than truncated",
     "const asSecs = (ms: number): number => Math.floor(ms / 1000);",
     "const asSecs = (ms: number): number => Math.round(ms / 1000);"),
    ("secs: milliseconds are rounded up",
     "const asSecs = (ms: number): number => Math.floor(ms / 1000);",
     "const asSecs = (ms: number): number => Math.ceil(ms / 1000);"),
    ("secs: milliseconds pass through unconverted",
     "const asSecs = (ms: number): number => Math.floor(ms / 1000);",
     "const asSecs = (ms: number): number => ms;"),
    ("secs: the interval is reported in minutes",
     "const asSecs = (ms: number): number => Math.floor(ms / 1000);",
     "const asSecs = (ms: number): number => Math.floor(ms / 60000);"),

    # --- effective_interval_secs / the bounds ---------------------------------
    ("bounds: the effective interval reads the silence limit",
     "    effective_interval_secs: asSecs(status.default_interval_ms),",
     "    effective_interval_secs: asSecs(status.max_silent_ms),"),
    ("bounds: the effective interval reads the wake floor",
     "    effective_interval_secs: asSecs(status.default_interval_ms),",
     "    effective_interval_secs: asSecs(status.min_wake_interval_ms),"),
    ("bounds: the latency floor and the idle limit are swapped",
     "    minimum_heartbeat_latency_secs: asSecs(status.min_wake_interval_ms),\n"
     "    dormant_after_idle_time_secs: asSecs(status.max_silent_ms),",
     "    minimum_heartbeat_latency_secs: asSecs(status.max_silent_ms),\n"
     "    dormant_after_idle_time_secs: asSecs(status.min_wake_interval_ms),"),
    ("bounds: the idle-tick cap reads the tick count",
     "    dormant_after_heartbeat_turns: status.max_idle_ticks,",
     "    dormant_after_heartbeat_turns: status.ticks_without_user,"),
    ("bounds: the tick count reads the cap",
     "    ticks_without_user: status.ticks_without_user,",
     "    ticks_without_user: status.max_idle_ticks,"),

    # --- seconds_until_wake ---------------------------------------------------
    ("until: an overdue wake floors rather than truncating",
     "const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);",
     "const untilSecs = (at: number, now: number): number => Math.floor((at - now) / 1000);"),
    ("until: the sign is inverted",
     "const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);",
     "const untilSecs = (at: number, now: number): number => Math.trunc((now - at) / 1000);"),
    ("until: an overdue wake saturates at zero",
     "const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);",
     "const untilSecs = (at: number, now: number): number =>\n"
     "  Math.max(0, Math.trunc((at - now) / 1000));"),
    ("until: milliseconds are reported as seconds",
     "const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);",
     "const untilSecs = (at: number, now: number): number => at - now;"),

    # --- seconds_since_user ---------------------------------------------------
    ("since: a future stamp reports negative elapsed time",
     "const sinceSecs = (at: number, now: number): number => Math.max(0, Math.trunc((now - at) / 1000));",
     "const sinceSecs = (at: number, now: number): number => Math.trunc((now - at) / 1000);"),
    ("since: the sign is inverted",
     "const sinceSecs = (at: number, now: number): number => Math.max(0, Math.trunc((now - at) / 1000));",
     "const sinceSecs = (at: number, now: number): number => Math.max(0, Math.trunc((at - now) / 1000));"),
    # `sinceSecs` floored rather than truncated was here and is provably
    # equivalent: the clamp at zero means only non-negative results survive,
    # and the two round identically on those. Documented on the helper rather
    # than chased. The clamp itself is #14.
    ("since: the wake helper is reused for the user stamp",
     "      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),",
     "      : { last_user_at: rfc3339(user), seconds_since_user: untilSecs(user, now) }),"),

    # --- the two pairs are not interchangeable --------------------------------
    ("pairs: the wake stamp is built from the user stamp",
     "      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),",
     "      : { next_wake_at: rfc3339(user ?? wake), seconds_until_wake: untilSecs(wake, now) }),"),
    ("pairs: the user pair is emitted whenever a wake is armed",
     "    ...(user === undefined\n"
     "      ? {}\n"
     "      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),",
     "    ...(wake === undefined || user === undefined\n"
     "      ? {}\n"
     "      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),"),
    ("pairs: an absent wake is written as null rather than omitted",
     "    ...(wake === undefined\n"
     "      ? {}\n"
     "      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),",
     "    ...(wake === undefined\n"
     "      ? { next_wake_at: null, seconds_until_wake: null }\n"
     "      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),"),
    ("pairs: an absent user stamp is written as null rather than omitted",
     "    ...(user === undefined\n"
     "      ? {}\n"
     "      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),",
     "    ...(user === undefined\n"
     "      ? { last_user_at: null, seconds_since_user: null }\n"
     "      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),"),

    # --- the RFC3339 spelling -------------------------------------------------
    ("rfc3339: the offset is spelled Z",
     "  return `${iso.replace(/\\.000Z$/, \"\").replace(/Z$/, \"\")}+00:00`;",
     "  return iso;"),
    ("rfc3339: a zero fraction is kept",
     "  return `${iso.replace(/\\.000Z$/, \"\").replace(/Z$/, \"\")}+00:00`;",
     "  return `${iso.replace(/Z$/, \"\")}+00:00`;"),
    ("rfc3339: every fraction is dropped",
     "  return `${iso.replace(/\\.000Z$/, \"\").replace(/Z$/, \"\")}+00:00`;",
     "  return `${iso.replace(/\\.\\d{3}Z$/, \"\").replace(/Z$/, \"\")}+00:00`;"),

    # --- the projection's shape -----------------------------------------------
    ("shape: the scheduler's character leaks onto the wire",
     "    paused: status.paused,",
     "    character: status.character,\n    paused: status.paused,"),
    ("shape: covered_turn_count leaks onto the wire",
     "    paused: status.paused,",
     "    covered_turn_count: status.covered_turn_count,\n    paused: status.paused,"),
    ("shape: the recent events are dropped",
     "    recent_events: status.recent_events,",
     "    recent_events: [],"),
    ("shape: paused is inverted",
     "    paused: status.paused,",
     "    paused: !status.paused,"),
    ("shape: the heartbeat state is hardcoded active",
     "    heartbeat_state: status.heartbeat_state,",
     "    heartbeat_state: \"Active\","),

    # --- autonomy / activity presence -----------------------------------------
    ("presence: an unregistered character reports an absent autonomy key",
     "    autonomy: state === undefined ? null : autonomyWire(state, now),",
     "    ...(state === undefined ? {} : { autonomy: autonomyWire(state, now) }),"),
    ("presence: an unregistered character reports an absent activity key",
     "    activity: report === undefined ? null : activityWire(report.stats, report.messageCount),",
     "    ...(report === undefined\n"
     "      ? {}\n"
     "      : { activity: activityWire(report.stats, report.messageCount) }),"),

    # --- the activity projection ----------------------------------------------
    ("activity: the counts read the conversation rather than the tracker",
     "    activity: report === undefined ? null : activityWire(report.stats, report.messageCount),",
     "    activity: report === undefined ? null : activityWire(report.stats, ctx.turnCount),"),
    ("activity: message_count and turn_count are not the same number",
     "    message_count: recorded,\n    turn_count: recorded,",
     "    message_count: recorded,\n    turn_count: 0,"),
    ("activity: the histogram is reported unnormalised as classifications",
     "    hour_histogram: stats.hourHistogram,",
     "    hour_histogram: stats.hourClassifications,"),
    ("activity: the classifications are dropped",
     "    hour_classifications: stats.hourClassifications as readonly HourClassification[],",
     "    hour_classifications: [],"),
    ("activity: the heatmap sufficiency flag is inverted",
     "    has_sufficient_heatmap: stats.hasSufficientHeatmap,",
     "    has_sufficient_heatmap: !stats.hasSufficientHeatmap,"),
    ("activity: engagement and sessions-per-day are swapped",
     "    engagement_score: stats.engagementScore,\n    sessions_per_day: stats.sessionsPerDay,",
     "    engagement_score: stats.sessionsPerDay,\n    sessions_per_day: stats.engagementScore,"),

    # --- the envelope ---------------------------------------------------------
    ("envelope: the config override loses to the configured default",
     "  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model ?? null;",
     "  const effectiveModel = ctx.config.app.defaults.model ?? ctx.activeModel ?? null;"),
    ("envelope: an unset model is omitted rather than null",
     "  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model ?? null;",
     "  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model;"),
    ("envelope: the data and cache directories are swapped",
     "    data_dir: ctx.config.dirs.data,\n    cache_dir: ctx.config.dirs.cache,",
     "    data_dir: ctx.config.dirs.cache,\n    cache_dir: ctx.config.dirs.data,"),
    ("envelope: the deferred count is not the length of the list",
     "    pending_deferred_edit_count: pending.length,",
     "    pending_deferred_edit_count: 0,"),
    ("envelope: the deferred queue is read from the data root",
     "  const characterDataDir = `${ctx.config.dirs.data}/${ctx.characterName}`;",
     "  const characterDataDir = ctx.config.dirs.data;"),
    ("envelope: the session token counters are transposed",
     "      cache_read: tokens.cache_read,\n      cache_write: tokens.cache_write,",
     "      cache_read: tokens.cache_write,\n      cache_write: tokens.cache_read,"),
    ("envelope: the memory mode is something else",
     "    memory_mode: \"markdown\",",
     "    memory_mode: \"sqlite\","),

    # --- count defaulting -----------------------------------------------------
    ("count: diagnostics defaults to 20 rather than 10",
     "  return ctx.diagnostics.toJson(countArg(args, 10));",
     "  return ctx.diagnostics.toJson(countArg(args, 20));"),
    ("count: heartbeat_log defaults to 10 rather than 20",
     "  const events = ctx.autonomy.log(ctx.characterName, countArg(args, 20));",
     "  const events = ctx.autonomy.log(ctx.characterName, countArg(args, 10));"),
    ("count: a negative count is accepted",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && Number.isInteger(v) ? v : fallback;"),
    ("count: a fractional count is accepted",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && v >= 0 ? v : fallback;"),
    ("count: zero falls back to the default rather than asking for nothing",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && Number.isInteger(v) && v > 0 ? v : fallback;"),

    # --- the controls ---------------------------------------------------------
    ("controls: a dormant clock is not warned about",
     "  return {\n    status: \"scheduled\",\n    character: ctx.characterName,\n    ...(dormant",
     "  return {\n    status: \"scheduled\",\n    character: ctx.characterName,\n    ...(!dormant"),
    ("controls: an unregistered character schedules a tick anyway",
     "  if (dormant === undefined) throw noState(ctx.characterName);",
     "  if (false) throw noState(ctx.characterName);"),
    ("controls: set_dormant and set_active are swapped",
     "  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, \"dormant\")) {",
     "  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, \"active\")) {"),
    ("controls: set_active reports the dormant label",
     "  return { status: \"active\", character: ctx.characterName };",
     "  return { status: \"dormant\", character: ctx.characterName };"),
    ("controls: an unregistered character is not an error for set_active",
     "  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, \"active\")) {\n"
     "    throw noState(ctx.characterName);\n"
     "  }",
     "  ctx.autonomy.forceHeartbeatState(ctx.characterName, \"active\");"),

    # --- heartbeat_log --------------------------------------------------------
    ("log: the events are reversed",
     "    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),",
     "    events: events\n"
     "      .slice()\n"
     "      .reverse()\n"
     "      .map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),"),
    ("log: the detail is dropped",
     "    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),",
     "    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind })),"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/status.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
