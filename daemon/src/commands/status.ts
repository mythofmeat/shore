/**
 * The autonomy half of `commands/state/status.rs`.
 *
 * `call_log` and `transcript` are the other half and live in `call_log.ts` —
 * they read only the observability store. These six read the scheduler:
 * `status` (the whole session envelope), `diagnostics`, `heartbeat_log`, and
 * the three heartbeat controls.
 *
 * ## The wire shape is fixed by a component that is not moving
 *
 * `AutonomyService.status()` answers in epoch milliseconds, deliberately — how
 * a status *reads* is the CLI's business, and the CLI is the part of shore that
 * stayed Rust. `client/shore-cli/src/output/commands.rs` reads
 * `dormant_after_heartbeat_turns`, `effective_interval_secs`,
 * `seconds_until_wake` and `next_wake_at` by those names, so this command
 * renders into that vocabulary rather than passing the sidecar's own through.
 * {@link autonomyWire} is that conversion and the only place it happens.
 *
 * `keepalive_ping_now` is the seventh command in that Rust file and is not
 * here. It rebuilds the request from disk, pushes the keepalive prefix and
 * retries — handler-level assembly, and blocked on the same seam as `compact`.
 */

import type { AutonomyService, AutonomyStatus } from "../autonomy/service.ts";
import type { HourClassification } from "../autonomy/activity.ts";
import type { ShoreDirs } from "../config/dirs.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { SessionTokens } from "../handler/persistence.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import { invalidRequest } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

/**
 * The config these commands read, and no more.
 *
 * Narrowed the way {@link LoadedConfigView} in `config/preferences.ts` is, and
 * for the same reason: `status` reads one default and three directories, and a
 * parameter that says so cannot be handed a config it will quietly mutate.
 */
export interface StatusConfigView {
  app: { defaults: { model: string | undefined } };
  dirs: ShoreDirs;
}

/** What these commands need from the session. */
export interface StatusContext {
  characterName: string;
  /** `engine.turn_count()` — user turns, not messages. */
  turnCount: number;
  /** The runtime `/model` override, if one is set. */
  activeModel: string | undefined;
  config: StatusConfigView;
  sessionTokens: SessionTokens;
  autonomy: AutonomyService;
  diagnostics: Diagnostics;
  /**
   * Real elapsed time. Must be the same clock {@link AutonomyService} runs on:
   * `seconds_until_wake` is the difference between a wake this reads and a now
   * this supplies, and two clocks would make it a difference of nothing.
   */
  now: () => number;
  /**
   * The user's calendar, as epoch ms in UTC — the naive-local encoding the
   * activity tracker is pinned on. A separate clock from {@link now} because it
   * answers a separate question: which hour of which day, rather than how long
   * ago. The Rust read `Local::now()` inside the tracker; injecting it keeps
   * the sidecar from holding its own opinion of the machine's timezone.
   */
  localNow: () => number;
}

// ── argument readers ────────────────────────────────────────────────────────

/**
 * `count_arg`: `Value::as_u64`, or the default.
 *
 * The same reader `call_log.ts` has, and the same rule: a negative, fractional,
 * string or absent count is not a count, and serde answers `None` to all four,
 * so every one of them means "use the default" rather than "use zero". Zero
 * itself is a count and asks for nothing.
 */
function countArg(args: Args, fallback: number): number {
  const v = args["count"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

// ── the autonomy projection ─────────────────────────────────────────────────

/** Milliseconds to whole seconds, the way `Duration::as_secs` truncates. */
const asSecs = (ms: number): number => Math.floor(ms / 1000);

/**
 * The RFC3339 spelling `DateTime<Utc>::to_rfc3339` produces.
 *
 * `+00:00` rather than `Z`, and the fraction omitted when it is zero: chrono's
 * `AutoSi` picks 0, 3, 6 or 9 digits and a `Date` only ever has 3. The Rust's
 * came from `Instant::now()` and so carried nanoseconds; this carries
 * milliseconds, which is a precision difference and not a format one — the CLI
 * parses both with `parse_from_rfc3339`.
 */
function rfc3339(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.replace(/\.000Z$/, "").replace(/Z$/, "")}+00:00`;
}

/**
 * Seconds from now until `at`, negative when it has already passed.
 *
 * The Rust branched on the sign and negated the magnitude, so both directions
 * truncate *towards zero* rather than flooring. `Math.trunc` is that, exactly.
 */
const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);

/**
 * Seconds since `at`, floored at zero.
 *
 * `Instant::duration_since` saturates rather than going negative, and a stamp
 * in the future is reachable: `last_user_at` is restored from
 * `autonomy_state.json` as a wall-clock time, so a backwards clock adjustment
 * leaves one there. Reporting a negative age would read as a message from the
 * future; reporting zero reads as "just now", which is the nearer truth.
 *
 * The clamp is the whole of it, and it makes `trunc` and `floor` here the same
 * function: they differ only on negative fractions, and every negative result
 * is on its way to zero. `trunc` is written because it mirrors
 * {@link untilSecs} and `duration_secs_i64`, not because anything can tell.
 */
const sinceSecs = (at: number, now: number): number => Math.max(0, Math.trunc((now - at) / 1000));

/**
 * The scheduler's state in the vocabulary the Rust CLI parses.
 *
 * Two of the sidecar's fields are dropped rather than renamed: `character`,
 * which the envelope already carries one level up, and `covered_turn_count`,
 * which is how much of the conversation the deep archive has been over — a
 * detail of the tick loop that was never on this wire.
 *
 * The four clock-derived fields are omitted when there is nothing to derive
 * them from, matching `skip_serializing_if = "Option::is_none"`. Absent means
 * "no wake is armed" / "no user message on record", which a null would blur.
 */
export function autonomyWire(status: AutonomyStatus, now: number): Json {
  const wake = status.next_wake_at;
  const user = status.last_user_at;
  return {
    paused: status.paused,
    heartbeat_state: status.heartbeat_state,
    ticks_without_user: status.ticks_without_user,
    dormant_after_heartbeat_turns: status.max_idle_ticks,
    effective_interval_secs: asSecs(status.default_interval_ms),
    ...(wake === undefined
      ? {}
      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),
    ...(user === undefined
      ? {}
      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),
    minimum_heartbeat_latency_secs: asSecs(status.min_wake_interval_ms),
    dormant_after_idle_time_secs: asSecs(status.max_silent_ms),
    recent_events: status.recent_events,
  };
}

/**
 * The activity statistics, as the status envelope reports them.
 *
 * Five of the tracker's fields and the message count twice. `message_count` and
 * `turn_count` are the same number under two names — the field was renamed and
 * the old spelling kept so an older client keeps reading — and both are the
 * *activity* count, which is what the tracker has recorded rather than what the
 * conversation holds.
 */
function activityWire(stats: ActivitySource, recorded: number): Json {
  return {
    hour_histogram: stats.hourHistogram,
    hour_classifications: stats.hourClassifications as readonly HourClassification[],
    has_sufficient_heatmap: stats.hasSufficientHeatmap,
    engagement_score: stats.engagementScore,
    sessions_per_day: stats.sessionsPerDay,
    message_count: recorded,
    turn_count: recorded,
  };
}

/** Just the statistics the envelope copies. */
interface ActivitySource {
  hourHistogram: readonly number[];
  hourClassifications: readonly HourClassification[];
  hasSufficientHeatmap: boolean;
  engagementScore: number;
  sessionsPerDay: number;
}

// ── status ──────────────────────────────────────────────────────────────────

/** Return system status: character, turn count, model, token counts. */
export async function status(ctx: StatusContext): Promise<Json> {
  const now = ctx.now();
  const report = ctx.autonomy.activityStats(ctx.characterName, ctx.localNow());
  const state = ctx.autonomy.status(ctx.characterName);

  // The runtime override first, then the configured default. Both absent is
  // null rather than an omission — the field always answers, even if the answer
  // is that nothing has been chosen.
  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model ?? null;

  // The data directory joined with the character's name as written, which is
  // the raw join the Rust did rather than the sanitizing `character_data_dir`.
  const characterDataDir = `${ctx.config.dirs.data}/${ctx.characterName}`;
  const pending = await pendingDeferredEditPaths(characterDataDir).catch(() => []);

  const tokens = ctx.sessionTokens;
  return {
    character: ctx.characterName,
    // The same count twice, as above: `message_count` is the old spelling.
    message_count: ctx.turnCount,
    turn_count: ctx.turnCount,
    active_model: effectiveModel,
    config_dir: ctx.config.dirs.config,
    data_dir: ctx.config.dirs.data,
    cache_dir: ctx.config.dirs.cache,
    memory_mode: "markdown",
    pending_deferred_edit_count: pending.length,
    pending_deferred_edits: pending,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
    },
    // Null, not omitted, for a character the scheduler has never taken up —
    // which is a real state a client has to render, not an absence.
    autonomy: state === undefined ? null : autonomyWire(state, now),
    activity: report === undefined ? null : activityWire(report.stats, report.messageCount),
  };
}

// ── diagnostics ─────────────────────────────────────────────────────────────

/** Return recent diagnostics from the in-memory ring buffers. */
export function diagnostics(ctx: StatusContext, args: Args): Json {
  return ctx.diagnostics.toJson(countArg(args, 10));
}

// ── heartbeat ───────────────────────────────────────────────────────────────

/**
 * Return the heartbeat event log for the active character.
 *
 * Re-projected field by field rather than passed through. The three fields
 * happen to be the whole event today, but this is the wire and the log is a
 * file format; letting a new field on one become a new field on the other by
 * accident is how the two stop being separable.
 */
export function heartbeatLog(ctx: StatusContext, args: Args): Json {
  const events = ctx.autonomy.log(ctx.characterName, countArg(args, 20));
  return {
    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),
  };
}

/** The message the three controls answer with when nobody is scheduling. */
const noState = (character: string): Error =>
  invalidRequest(`No autonomy state for character '${character}'`);

/**
 * Schedule an immediate heartbeat tick.
 *
 * A dormant clock still takes the request, and still says so: the tick is armed
 * but the abandonment guard will swallow it, and the warning names the command
 * that clears the guard. Answering with a plain "scheduled" would be true and
 * useless.
 */
export function heartbeatTickNow(ctx: StatusContext): Json {
  const dormant = ctx.autonomy.forceHeartbeatNow(ctx.characterName);
  if (dormant === undefined) throw noState(ctx.characterName);
  return {
    status: "scheduled",
    character: ctx.characterName,
    ...(dormant
      ? {
          warning:
            "Heartbeat is dormant. The scheduled tick will be suppressed " +
            "by the abandonment guard. Run `shore debug heartbeat_status_active` " +
            "first to wake the clock.",
        }
      : {}),
  };
}

/** Force the abandonment guard on. */
export function heartbeatSetDormant(ctx: StatusContext): Json {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "dormant")) {
    throw noState(ctx.characterName);
  }
  return { status: "dormant", character: ctx.characterName };
}

/** Force the abandonment guard off, and tick immediately. */
export function heartbeatSetActive(ctx: StatusContext): Json {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "active")) {
    throw noState(ctx.characterName);
  }
  return { status: "active", character: ctx.characterName };
}
