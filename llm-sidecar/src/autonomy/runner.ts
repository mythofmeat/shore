/**
 * One character's autonomy loop.
 *
 * Holds the state, decides what a tick should do, and asks something else to do
 * it. Everything it decides with is already ported and pinned against the Rust:
 * the {@link HeartbeatClock}, the {@link ActivityTracker}, {@link tickDecision},
 * the {@link HeartbeatLog} and `autonomy_state.json`. This assembles them into
 * the loop `character_tick_loop` runs in `crates/daemon/src/autonomy/manager.rs`.
 *
 * ## What it does not do
 *
 * Execute. Running a heartbeat's tool loop, compacting a conversation,
 * archiving it or dreaming over it all reach into the engine, the memory store,
 * the tool registry and MCP — none of which live on this side, and some of
 * which are not going to. So execution arrives as an {@link AutonomyExecutor},
 * and the four methods on it are the whole surface the daemon still has to
 * provide.
 *
 * That interface is the shape of the remaining work, deliberately. When the
 * daemon's autonomy module is deleted, what is left in Rust is an
 * implementation of these four calls and nothing else.
 *
 * ## Why the gates are checked twice
 *
 * Executing anything means awaiting, and a user message can land mid-await. The
 * decision at the top of a tick was taken before that, so the deep archive and
 * dreaming re-check their gate immediately before running — otherwise a
 * character starts archiving a conversation the user has just rejoined, or
 * dreams into an active one. The Rust does the same, for the same reason, and
 * the recheck is why {@link tickDecision} is cheap and pure enough to call
 * twice.
 */

import { HeartbeatClock, type HeartbeatAction } from "./heartbeat.ts";
import { HeartbeatLog, type HeartbeatEventKind } from "./heartbeat_log.ts";
import {
  tickDecision,
  type CompactionReason,
  type TickDecision,
  type TickInputs,
} from "./tick.ts";
import {
  saveState,
  toRfc3339,
  type AutonomyStateFile,
  type PersistedKeepalive,
} from "./state_file.ts";

/** How often each character's loop runs. */
export const TICK_INTERVAL_MS = 10_000;

/** The config a tick reads, already resolved from `config.toml`. */
export interface AutonomyRunnerConfig {
  readonly autonomyEnabled: boolean;
  readonly heartbeatEnabled: boolean;

  readonly compactionEnabled: boolean;
  readonly minTurns: number;
  readonly maxTurns: number;
  readonly idleTriggerSecs: number;
  readonly archiveAfterSecs: number;

  readonly dreamingEnabled: boolean;
  readonly minimumInactiveMs: number;
}

/**
 * What an action did, for the tick to fold back into its own state.
 *
 * The tick decides on turn counts and log lines it cannot see for itself — the
 * conversation lives on the far side — so an action that changes either has to
 * say so rather than leave this side to guess.
 */
export interface AutonomyActionResult {
  /**
   * The active conversation's turn count afterwards, when the action changed
   * it. Compaction reports one; a heartbeat does not, matching the Rust, where
   * `execute_heartbeat_tick` writes log lines and leaves `active_turn_count`
   * alone.
   */
  readonly turnCount?: number | undefined;
  /** Lines for the heartbeat log, in order. */
  readonly events: readonly { kind: HeartbeatEventKind; detail: string }[];
  /**
   * Set when the action ran and failed.
   *
   * Not a throw, because a failed action still has log lines worth keeping and
   * still has to release its latch. Failing to *reach* the far side is the
   * throw — see the note on {@link AutonomyExecutor}.
   */
  readonly failed?: string | undefined;
}

/**
 * The work a tick cannot do itself.
 *
 * Each call is expected to be slow — every one of them is at least an LLM
 * round trip — and to throw only when it could not be attempted at all: the
 * character is not loaded, the socket is gone. A throw abandons the rest of the
 * tick and the loop tries again; nothing about one failed heartbeat should
 * prevent the next one.
 *
 * An action that ran and *failed* is not that. It comes back as a result with
 * {@link AutonomyActionResult.failed} set, and the tick treats it as a
 * completed attempt: latch released, retry window restarted, log lines kept.
 * The same distinction tool calls draw across this seam.
 */
export interface AutonomyExecutor {
  /** Run a heartbeat: a private turn with tools, which may send a message. */
  runHeartbeatTick(character: string): Promise<AutonomyActionResult>;
  /** Compact the active conversation. */
  runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult>;
  /** Archive what is left of a conversation nobody has returned to. */
  runDeepArchive(character: string): Promise<AutonomyActionResult>;
  /** Sweep memory while the character is idle. */
  runDream(character: string): Promise<AutonomyActionResult>;
}

/** What one tick did, for the caller to log or assert on. */
export interface TickOutcome {
  readonly heartbeat: HeartbeatAction;
  readonly compaction: CompactionReason | undefined;
  readonly deepArchive: boolean;
  readonly dream: boolean;
  /** Gates that passed at decision time and failed the recheck before running. */
  readonly abandoned: readonly ("deep_archive" | "dream")[];
}

/** Mutable state that is not the heartbeat clock's or the log's. */
interface RunnerState {
  paused: boolean;
  dirty: boolean;
  /** Epoch ms of the last message activity, for the compaction triggers. */
  lastActivityAt: number;
  compactionTriggered: boolean;
  deepArchiveDone: boolean;
  activeTurnCount: number;
  coveredTurnCount: number;
  keepalive: PersistedKeepalive | undefined;
}

export class CharacterAutonomy {
  readonly #character: string;
  readonly #config: AutonomyRunnerConfig;
  readonly #executor: AutonomyExecutor;
  readonly #statePath: string;

  readonly #clock: HeartbeatClock;
  readonly #log: HeartbeatLog;
  /** Reads the wall clock. Injected because a tick reads it more than once —
   *  see the note on rechecking above — and a test has to control both reads. */
  readonly #now: () => number;
  #state: RunnerState;

  constructor(opts: {
    character: string;
    config: AutonomyRunnerConfig;
    executor: AutonomyExecutor;
    statePath: string;
    clock: HeartbeatClock;
    log: HeartbeatLog;
    /** A previously persisted state, if there was one to trust. */
    restored?: AutonomyStateFile | undefined;
    now: () => number;
  }) {
    this.#character = opts.character;
    this.#config = opts.config;
    this.#executor = opts.executor;
    this.#statePath = opts.statePath;
    this.#clock = opts.clock;
    this.#log = opts.log;
    this.#now = opts.now;

    const restored = opts.restored;
    if (restored !== undefined) {
      this.#clock.restore({
        ticks_without_user: restored.ticksWithoutUser,
        next_wake_at: restored.nextWakeAt,
        last_user_at: restored.lastUserAt,
      });
    }
    this.#state = {
      paused: false,
      dirty: false,
      lastActivityAt: opts.now(),
      compactionTriggered: false,
      deepArchiveDone: false,
      activeTurnCount: 0,
      coveredTurnCount: restored?.coveredTurnCount ?? 0,
      keepalive: restored?.keepalive,
    };
  }

  get paused(): boolean {
    return this.#state.paused;
  }

  get clock(): HeartbeatClock {
    return this.#clock;
  }

  get log(): HeartbeatLog {
    return this.#log;
  }

  pause(): void {
    this.#state.paused = true;
    this.#state.dirty = true;
  }

  resume(): void {
    this.#state.paused = false;
    this.#state.dirty = true;
  }

  /**
   * A user said something.
   *
   * Three things at once, and they are separate on purpose: the heartbeat's
   * silence anchor moves, the compaction clock restarts, and both single-flight
   * latches release. A character the user has come back to is not mid-idle-period
   * any more, so triggers that had already fired for it must be able to fire again.
   */
  onUserMessage(turnCount: number, now: number): void {
    this.#clock.onUserMessage(now);
    this.#state.activeTurnCount = turnCount;
    this.#state.lastActivityAt = now;
    this.#state.compactionTriggered = false;
    this.#state.deepArchiveDone = false;
    this.#state.dirty = true;
  }

  /**
   * The character said something. Activity, but not the user's.
   *
   * The compaction clock restarts — a conversation that just grew is not idle —
   * but neither latch releases. Only a user coming back does that: a character
   * talking to itself through a heartbeat has not ended the idle period, and
   * treating it as though it had would let the deep archive re-run every time
   * the character spoke into the silence.
   */
  onAssistantMessage(turnCount: number, now: number): void {
    this.#state.activeTurnCount = turnCount;
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  /**
   * A compaction finished.
   *
   * The latch releases so a later trigger can fire, and every retained turn is
   * now covered by memory — the compaction pass reads the whole conversation,
   * and the keep-N split only decides what stays on disk.
   *
   * `deepArchiveDone` deliberately does *not* release. It tracks the idle
   * period rather than the latch, and a compaction is not the user coming
   * back; clearing it here would let the archive run a second time over a
   * conversation that has already been archived once.
   */
  onCompactionComplete(newTurnCount: number, now: number): void {
    this.#state.activeTurnCount = newTurnCount;
    this.#state.coveredTurnCount = newTurnCount;
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  /**
   * Record something for `shore log --heartbeat`.
   *
   * UTC, where the Rust wrote the machine's local offset. The CLI parses
   * RFC3339 and converts with `with_timezone(&Local)` before printing, so the
   * two display identically — and a log that says what time it means beats one
   * whose reading depends on where the daemon was running.
   */
  note(kind: HeartbeatEventKind, detail: string, now: number): void {
    this.#log.push(kind, detail, toRfc3339(now));
  }

  /** The inputs this tick's decision is taken from. */
  inputs(now: number): TickInputs {
    const c = this.#config;
    const s = this.#state;
    const lastUserAt = this.#clock.lastUserAt;
    return {
      autonomyEnabled: c.autonomyEnabled,
      paused: s.paused,
      heartbeatEnabled: c.heartbeatEnabled,

      compactionEnabled: c.compactionEnabled,
      compactionTriggered: s.compactionTriggered,
      deepArchiveDone: s.deepArchiveDone,
      activeTurnCount: s.activeTurnCount,
      minTurns: c.minTurns,
      maxTurns: c.maxTurns,
      idleSecs: Math.trunc(Math.max(now - s.lastActivityAt, 0) / 1000),
      idleTriggerSecs: c.idleTriggerSecs,
      archiveAfterSecs: c.archiveAfterSecs,

      dreamingEnabled: c.dreamingEnabled,
      // Retry backoff is the executor's business: a failed dream throws, and
      // the next tick's gate is unchanged. Nothing here to back off from.
      dreamBackoffElapsed: true,
      msSinceUser: lastUserAt === undefined ? undefined : Math.max(now - lastUserAt, 0),
      minimumInactiveMs: c.minimumInactiveMs,
    };
  }

  /**
   * One tick: decide, execute, persist.
   *
   * The persist is in a `finally` because an executor that cannot be reached
   * throws, and everything decided before it — the clock's advance, the
   * `tick_fired` line, the latch — is worth keeping. Losing it would mean a
   * heartbeat deadline that survives the throw only in memory, and a restart
   * during an unreachable daemon would forget it entirely.
   */
  async tick(): Promise<TickOutcome> {
    const now = this.#now();
    const decision = tickDecision(this.inputs(now));
    const abandoned: ("deep_archive" | "dream")[] = [];

    // Both triggers share one latch, and taking it is what stops the next tick
    // firing the same work while this one is still awaiting it.
    if (decision.compaction !== undefined || decision.deepArchive) {
      this.#state.compactionTriggered = true;
      this.#state.dirty = true;
    }

    const heartbeat = this.#runClock(decision, now);
    try {
      if (heartbeat === "run_tick") {
        this.note("tick_fired", "Heartbeat tick fired", now);
        this.#apply(await this.#executor.runHeartbeatTick(this.#character));
      }

      if (decision.compaction !== undefined) {
        this.#applyCompaction(
          await this.#executor.runCompaction(this.#character, decision.compaction),
        );
      }

      if (decision.deepArchive) {
        if (this.#stillIdleEnoughToArchive()) {
          const result = await this.#executor.runDeepArchive(this.#character);
          this.#applyCompaction(result);
          // A failed archive must be able to run again, so the "already done
          // for this idle period" flag is only set by one that worked.
          if (result.failed === undefined) this.#state.deepArchiveDone = true;
        } else {
          // Release the latch so the next tick is not wedged behind a trigger
          // that no longer applies.
          this.#state.compactionTriggered = false;
          abandoned.push("deep_archive");
        }
        this.#state.dirty = true;
      }

      if (decision.dream) {
        if (this.#stillQuietEnoughToDream()) {
          this.#apply(await this.#executor.runDream(this.#character));
        } else {
          abandoned.push("dream");
        }
      }
    } catch (err) {
      // Nothing ran, so the single-flight latch this tick took has nothing left
      // to protect. Leaving it set would stop compaction and the deep archive
      // until the user came back — one unreachable moment costing a character
      // hours of housekeeping, at exactly the time it needs it most.
      //
      // No Rust to mirror here: this case only exists because executing moved
      // across a seam that can fail on its own.
      this.#state.compactionTriggered = false;
      this.#state.dirty = true;
      throw err;
    } finally {
      await this.persist();
    }

    return {
      heartbeat,
      compaction: decision.compaction,
      deepArchive: decision.deepArchive && !abandoned.includes("deep_archive"),
      dream: decision.dream && !abandoned.includes("dream"),
      abandoned,
    };
  }

  /** Fold an action's log lines back in. */
  #apply(result: AutonomyActionResult): void {
    const now = this.#now();
    for (const event of result.events) this.note(event.kind, event.detail, now);
  }

  /**
   * Fold back an action that rewrote the conversation.
   *
   * Compaction and the deep archive land the same way whether they worked or
   * not: the latch releases so a later trigger can fire, and the activity clock
   * moves to now so a failure waits a full window instead of retrying every ten
   * seconds. Only the turn counts are conditional on it having worked. Mirrors
   * `execute_idle_compaction` and `notify_compaction_failed`.
   */
  #applyCompaction(result: AutonomyActionResult): void {
    this.#apply(result);
    const now = this.#now();
    if (result.failed === undefined && result.turnCount !== undefined) {
      this.onCompactionComplete(result.turnCount, now);
      return;
    }
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  /**
   * Has the conversation stayed idle long enough to still be worth archiving?
   *
   * Deliberately narrower than {@link tickDecision}: it asks only what could
   * have changed while this tick was awaiting. Re-running the whole decision
   * would read the single-flight latch *this tick just took* and refuse every
   * time — the recheck would never pass, and the archive would never run. The
   * Rust's `execute_deep_archive_if_still_idle` checks these same three things
   * for the same reason.
   */
  #stillIdleEnoughToArchive(): boolean {
    const i = this.inputs(this.#now());
    return i.archiveAfterSecs > 0 && !i.deepArchiveDone && i.idleSecs >= i.archiveAfterSecs;
  }

  /**
   * Has the user stayed away long enough that a sweep will not disturb them?
   *
   * Narrower than the decision for the same reason as above, though here it is
   * only the silence window that can have moved. Mirrors
   * `dream_inactivity_satisfied`.
   */
  #stillQuietEnoughToDream(): boolean {
    const i = this.inputs(this.#now());
    return i.msSinceUser === undefined || i.msSinceUser >= i.minimumInactiveMs;
  }

  /**
   * Run the heartbeat clock, and say so in the log when the guard trips.
   *
   * A trip is: it had a deadline, the tick declined to fire, and the deadline
   * is gone afterwards. That is the only way to tell dormancy from an ordinary
   * "not yet" — both return `none`.
   */
  #runClock(decision: TickDecision, now: number): HeartbeatAction {
    if (!decision.heartbeatMayTick) return "none";

    const hadDeadline = this.#clock.nextWakeAt !== undefined;
    const action = this.#clock.tick(now);
    if (action !== "none") this.#state.dirty = true;

    if (hadDeadline && action === "none" && this.#clock.nextWakeAt === undefined) {
      this.note(
        "dormant",
        `Abandonment guard tripped (ticks without user: ${this.#clock.ticksWithoutUser})`,
        now,
      );
      // The keepalive is deliberately not stopped here. It has its own idle
      // ceiling, and the guard governs heartbeat ticks rather than cache
      // warming — a dormant character's cache is exactly the one whose next
      // message would otherwise pay a cold write.
    }
    return action;
  }

  /** The state as it would be written. */
  snapshot(): AutonomyStateFile {
    const clock = this.#clock.snapshot();
    return {
      ticksWithoutUser: clock.ticks_without_user,
      nextWakeAt: clock.next_wake_at,
      lastUserAt: clock.last_user_at,
      coveredTurnCount: this.#state.coveredTurnCount,
      keepalive: this.#state.keepalive,
    };
  }

  /**
   * Write the state and flush the log, if either has anything to say.
   *
   * A failed write leaves the dirty flag set, so the next tick tries again
   * rather than believing a save that never happened.
   */
  async persist(): Promise<void> {
    if (this.#state.dirty) {
      if (await saveState(this.#statePath, this.snapshot())) this.#state.dirty = false;
    }
    await this.#log.flushIfDirty();
  }

  /** Mark the state dirty and persist unconditionally, for shutdown. */
  async shutdown(): Promise<void> {
    this.#state.dirty = true;
    await this.persist();
  }
}
