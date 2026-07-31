/**
 * Every loaded character's autonomy, and the clock that runs it.
 *
 * `runner.ts` is one character's loop — what a tick decides and what it folds
 * back in. This is the part around it with effects: it holds one loop per
 * character, reads their state and logs off disk when they load, runs a timer,
 * and makes sure a slow tick is never overlapped by the next one.
 *
 * The same division `keepalive.ts` has from `cache_keepalive.ts`, and the same
 * reason: the decisions are pure and pinned against the Rust, the effects are
 * not and cannot be.
 *
 * ## The daemon says which characters exist
 *
 * It does not scan a directory. `character_data_dir` sanitizes a name into a
 * path and lives on the far side, and reimplementing it here would give two
 * answers to "where does this character's state live" — which is the kind of
 * disagreement that silently writes a second state file. So registration
 * carries the directory, the way the keepalive's prefix carries the body rather
 * than rebuilding it.
 *
 * ## A tick that overruns is skipped, not queued
 *
 * Every action a tick takes is an LLM round trip, so a tick can outlast the ten
 * seconds until the next one. Starting a second would compact a conversation
 * the first is still compacting. So a character with a tick in flight is passed
 * over, exactly as {@link KeepaliveService} passes over a ping in flight — and
 * the daemon refuses a concurrent action anyway, which makes this the polite
 * half of a guard that exists on both sides.
 */

import type { ActivityStats } from "./activity.ts";
import { HeartbeatClock, type HeartbeatClockConfig } from "./heartbeat.ts";
import { HeartbeatLog, type HeartbeatEvent } from "./heartbeat_log.ts";
import { CharacterAutonomy, type AutonomyExecutor, type AutonomyRunnerConfig } from "./runner.ts";
import { loadState, STATE_FILENAME } from "./state_file.ts";

/** How often every character's loop runs. Matches the Rust's `TICK_INTERVAL`. */
export const AUTONOMY_TICK_MS = 10_000;

export const HEARTBEAT_LOG_FILENAME = "heartbeat.jsonl";

/**
 * `POST /v1/autonomy/register` — a character is loaded, start ticking it.
 *
 * Everything a tick reads, resolved from `config.toml` by the daemon. Sending
 * resolved numbers rather than the config file keeps model resolution, per-
 * character overrides and defaulting on the side that already does them.
 */
export interface RegisterCharacter {
  character: string;
  /** Where `autonomy_state.json` and `heartbeat.jsonl` live for this character. */
  data_dir: string;
  config: AutonomyRunnerConfig;
  clock: HeartbeatClockConfig;
}

/**
 * What `shore status` reads back.
 *
 * Times are epoch ms and durations are ms, both raw. The daemon renders them —
 * RFC3339 stamps, "in 40 minutes", whole seconds — because how a status reads
 * is the CLI's business and the CLI is the one that stayed Rust.
 *
 * The four bounds are echoed back rather than filled in by the daemon from its
 * own config. They say what the loop *is* running on, which is the only version
 * of the number worth putting in a diagnostic: a reload that never reached this
 * side is exactly what a status should be able to show.
 */
export interface AutonomyStatus {
  character: string;
  paused: boolean;
  /** `"Active"` or `"Dormant"` — whether the abandonment guard has tripped. */
  heartbeat_state: string;
  ticks_without_user: number;
  covered_turn_count: number;
  /** Epoch ms of the next scheduled heartbeat, absent when none is armed. */
  next_wake_at?: number;
  /** Epoch ms of the last user message, absent when none is on record. */
  last_user_at?: number;
  default_interval_ms: number;
  max_idle_ticks: number;
  min_wake_interval_ms: number;
  max_silent_ms: number;
  recent_events: HeartbeatEvent[];
}

/** How many log lines `shore status` shows inline. */
const RECENT_EVENT_LIMIT = 5;

/** What `/v1/autonomy/activity` answers: the statistics and what they are from. */
export interface ActivityReport {
  stats: ActivityStats;
  messageCount: number;
}

interface Entry {
  runner: CharacterAutonomy;
  /** Guards against a slow tick overlapping the next one. */
  inFlight: boolean;
}

export class AutonomyService {
  readonly #entries = new Map<string, Entry>();
  readonly #executor: AutonomyExecutor;
  readonly #now: () => number;

  constructor(executor: AutonomyExecutor, now: () => number = () => Date.now()) {
    this.#executor = executor;
    this.#now = now;
  }

  /**
   * Take up a character, restoring whatever it left behind.
   *
   * Re-registering one replaces it, which is what a config reload does. The
   * outgoing runner is persisted first: its in-memory state is the current one,
   * and dropping it would lose the heartbeat deadline back to whatever was last
   * written.
   */
  async register(request: RegisterCharacter): Promise<void> {
    const { character, data_dir: dataDir } = request;
    const existing = this.#entries.get(character);
    if (existing !== undefined) await existing.runner.shutdown();

    const statePath = `${dataDir}/${STATE_FILENAME}`;
    const restored = await loadState(statePath);
    const runner = new CharacterAutonomy({
      character,
      config: request.config,
      executor: this.#executor,
      statePath,
      clock: new HeartbeatClock(request.clock, this.#now()),
      log: await HeartbeatLog.load(`${dataDir}/${HEARTBEAT_LOG_FILENAME}`),
      restored,
      now: this.#now,
    });
    this.#entries.set(character, { runner, inFlight: false });
  }

  /** Let a character go, writing down where it got to. */
  async unregister(character: string): Promise<void> {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    this.#entries.delete(character);
    await entry.runner.shutdown();
  }

  /**
   * Tick everything that is not already ticking.
   *
   * A tick that throws — an unreachable daemon — is logged and dropped rather
   * than allowed to stop the other characters. It has already persisted what it
   * decided; see {@link CharacterAutonomy.tick}.
   */
  async tick(): Promise<void> {
    const due: [string, Entry][] = [];
    for (const pair of this.#entries) {
      if (pair[1].inFlight) continue;
      pair[1].inFlight = true;
      due.push(pair);
    }
    await Promise.all(
      due.map(async ([character, entry]) => {
        try {
          await entry.runner.tick();
        } catch (err) {
          console.error(`shore: autonomy tick failed for ${character}: ${String(err)}`);
        } finally {
          entry.inFlight = false;
        }
      }),
    );
  }

  /**
   * A user said something.
   *
   * `localAt` is that same moment as the user's calendar reads it, which is what
   * the activity tracker records against — see
   * {@link CharacterAutonomy.backfillActivity}.
   */
  onUserMessage(character: string, turnCount: number, localAt: number): void {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return;
    runner.onUserMessage(turnCount, this.#now());
    runner.recordUserActivity(localAt);
  }

  /** Seed a freshly registered character's activity tracker from its history. */
  backfillActivity(
    character: string,
    localTimestamps: readonly number[],
    latestUserAt: number | undefined,
  ): void {
    this.#entries.get(character)?.runner.backfillActivity(localTimestamps, latestUserAt);
  }

  /** What the `activity` tool and `shore status` read. */
  activityStats(character: string, localAt: number): ActivityReport | undefined {
    return this.#entries.get(character)?.runner.activityStats(this.#now(), localAt);
  }

  /** The character said something, in the foreground. */
  onAssistantMessage(character: string, turnCount: number): void {
    this.#entries.get(character)?.runner.onAssistantMessage(turnCount, this.#now());
  }

  /**
   * A compaction the daemon ran finished.
   *
   * Distinct from one a tick asked for, which folds its own result in. This is
   * the handler's post-turn path, which this side does not drive and would
   * otherwise never hear about — leaving the turn count wrong until the user's
   * next message.
   */
  onCompactionComplete(character: string, turnCount: number): void {
    this.#entries.get(character)?.runner.onCompactionComplete(turnCount, this.#now());
  }

  /** Stop or restart the heartbeat. Returns the new state, or `undefined` if
   *  there is no such character. */
  setPaused(character: string, paused: boolean): boolean | undefined {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return undefined;
    if (paused) runner.pause();
    else runner.resume();
    return runner.paused;
  }

  /** What `shore status` shows. */
  status(character: string): AutonomyStatus | undefined {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return undefined;
    const now = this.#now();
    const snapshot = runner.snapshot();
    const bounds = runner.clock.config;
    const status: AutonomyStatus = {
      character,
      paused: runner.paused,
      heartbeat_state: runner.clock.stateAt(now),
      ticks_without_user: snapshot.ticksWithoutUser,
      covered_turn_count: snapshot.coveredTurnCount,
      default_interval_ms: bounds.defaultIntervalMs,
      max_idle_ticks: bounds.maxIdleTicks,
      min_wake_interval_ms: bounds.minWakeIntervalMs,
      max_silent_ms: bounds.maxSilentMs,
      recent_events: runner.log.recent(RECENT_EVENT_LIMIT),
    };
    // Omitted rather than sent as null, matching the rest of this seam: absent
    // unambiguously means "no wake is armed" / "no user message on record".
    if (snapshot.nextWakeAt !== undefined) status.next_wake_at = snapshot.nextWakeAt;
    if (snapshot.lastUserAt !== undefined) status.last_user_at = snapshot.lastUserAt;
    return status;
  }

  /**
   * The character scheduled its own next moment, mid-heartbeat.
   *
   * Answers with the hours actually used, which is what the tool tells the
   * character. `undefined` for one nobody registered — the daemon then says so
   * rather than reporting a wake that was never armed.
   */
  scheduleNextWake(character: string, hoursFromNow: number, reason: string): number | undefined {
    return this.#entries
      .get(character)
      ?.runner.scheduleNextWake(hoursFromNow, reason, this.#now());
  }

  /** A compaction the daemon ran failed; let a later trigger retry it. */
  onCompactionFailed(character: string): void {
    this.#entries.get(character)?.runner.onCompactionFailed(this.#now());
  }

  /**
   * Should the handler compact after the turn it has just persisted?
   *
   * `undefined` for a character nobody registered, which the daemon reads as
   * "no" — the same answer the Rust's `with_state` miss gave.
   */
  shouldCompactNow(
    character: string,
    turnCount: number,
    contextTokens: number,
  ): boolean | undefined {
    return this.#entries.get(character)?.runner.shouldCompactNow(turnCount, contextTokens);
  }

  /** `shore debug heartbeat_tick_now`. Answers whether the clock is dormant, in
   *  which case the forced wake will be suppressed anyway. */
  forceHeartbeatNow(character: string): boolean | undefined {
    return this.#entries.get(character)?.runner.forceHeartbeatNow(this.#now());
  }

  /** `shore debug status_dormant` / `status_active`. False when not loaded. */
  forceHeartbeatState(character: string, state: "dormant" | "active"): boolean {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return false;
    if (state === "dormant") runner.forceDormant();
    else runner.forceActive(this.#now());
    return true;
  }

  /** What `shore log --heartbeat` shows. */
  log(character: string, limit: number): HeartbeatEvent[] {
    return this.#entries.get(character)?.runner.log.recent(limit) ?? [];
  }

  /** Test seam: the live runner for a character. */
  runnerFor(character: string): CharacterAutonomy | undefined {
    return this.#entries.get(character)?.runner;
  }

  /**
   * Write everything down, for daemon shutdown.
   *
   * Does not wait for ticks in flight. One holds a provider call that will
   * outlive the process either way, and what it would have persisted is a
   * decision taken from the same state this is writing now.
   */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.runner.shutdown()));
  }
}

/**
 * Run `tick` on a timer until the returned handle is stopped.
 *
 * `unref` so a pending tick never holds the process open — the sidecar's
 * lifetime is the daemon's to decide, and an autonomy timer is not a reason to
 * linger.
 */
export function startAutonomyTimer(
  service: AutonomyService,
  everyMs: number = AUTONOMY_TICK_MS,
): { stop: () => void } {
  const timer = setInterval(() => {
    void service.tick();
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
