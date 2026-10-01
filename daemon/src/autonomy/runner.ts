import { ActivityTracker, weekdayOf, type ActivityStats } from "./activity.ts";
import { HeartbeatClock, type HeartbeatAction, type HeartbeatClockConfig } from "./heartbeat.ts";
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


export interface CompactionRunnerConfig {
  readonly compactionEnabled: boolean;
  readonly minTurns: number;
  readonly maxTurns: number;
  readonly idleTriggerSecs: number;
  readonly archiveAfterSecs: number;
  readonly maxContextTokens: number;
}

export interface AutonomyRunnerConfig extends CompactionRunnerConfig {
  readonly autonomyEnabled: boolean;
  readonly heartbeatEnabled: boolean;
}

export interface AutonomyActionResult {
  readonly turnCount?: number | undefined;
  readonly events: readonly { kind: HeartbeatEventKind; detail: string }[];
  readonly failed?: string | undefined;
  readonly deepArchiveDone?: boolean | undefined;
  readonly retryAt?: number | undefined;
}

export interface TickHooks {
  scheduleNextWake(hoursFromNow: number, reason: string): number;
}

export interface AutonomyExecutor {
  runHeartbeatTick(character: string, hooks: TickHooks): Promise<AutonomyActionResult>;
  runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult>;
  runDeepArchive(character: string, coveredTurnCount: number): Promise<AutonomyActionResult>;
}

export interface TickOutcome {
  readonly heartbeat: HeartbeatAction;
  readonly compaction: CompactionReason | undefined;
  readonly deepArchive: boolean;
  readonly abandoned: readonly "deep_archive"[];
}

interface RunnerState {
  dirty: boolean;
  lastActivityAt: number;
  compactionTriggered: boolean;
  deepArchiveDone: boolean;
  activeTurnCount: number;
  coveredTurnCount: number;
  keepalive: PersistedKeepalive | undefined;
}

export class CharacterAutonomy {
  readonly #character: string;
  #config: AutonomyRunnerConfig;
  readonly #executor: AutonomyExecutor;
  readonly #statePath: string;

  readonly #clock: HeartbeatClock;
  readonly #log: HeartbeatLog;
  readonly #activity = new ActivityTracker();
  readonly #now: () => number;
  #state: RunnerState;

  constructor(opts: {
    character: string;
    config: AutonomyRunnerConfig;
    executor: AutonomyExecutor;
    statePath: string;
    clock: HeartbeatClock;
    log: HeartbeatLog;
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
        ...(restored.forcedDormant === true ? { forced_dormant: true } : {}),
        ...(restored.defaultWake === true ? { default_wake: true } : {}),
        ...(restored.wakeAnchorAt === undefined ? {} : { wake_anchor_at: restored.wakeAnchorAt }),
      });
      this.#clock.boundWake(opts.now());
    }
    this.#state = {
      dirty: false,
      lastActivityAt: opts.now(),
      compactionTriggered: false,
      deepArchiveDone: false,
      activeTurnCount: 0,
      coveredTurnCount: restored?.coveredTurnCount ?? 0,
      keepalive: restored?.keepalive,
    };
  }

  get clock(): HeartbeatClock {
    return this.#clock;
  }

  get log(): HeartbeatLog {
    return this.#log;
  }

  get heartbeatMayTick(): boolean {
    return this.#config.autonomyEnabled && this.#config.heartbeatEnabled;
  }

  onUserMessage(turnCount: number, now: number): void {
    if (this.#clock.ticksWithoutUser > 0) {
      this.note("wake", "User returned — idle counter reset", now);
    }
    this.#clock.onUserMessage(now);
    this.#state.activeTurnCount = turnCount;
    this.#state.lastActivityAt = now;
    this.#state.compactionTriggered = false;
    this.#state.deepArchiveDone = false;
    this.#state.dirty = true;
  }

  deferHeartbeat(now: number): void {
    this.#clock.boundWake(now, true);
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  onAssistantMessage(turnCount: number, now: number): void {
    this.#state.activeTurnCount = turnCount;
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  onCompactionComplete(newTurnCount: number, now: number): void {
    this.#state.activeTurnCount = newTurnCount;
    this.#state.coveredTurnCount = newTurnCount;
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = now;
    this.#state.dirty = true;
  }

  onCompactionFailed(now: number, retryAt?: number): void {
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = retryAt === undefined
      ? now
      : retryAt - this.#config.idleTriggerSecs * 1000;
    this.#state.dirty = true;
  }

  setCompactionConfig(compaction: CompactionRunnerConfig): void {
    this.#config = {
      autonomyEnabled: this.#config.autonomyEnabled,
      heartbeatEnabled: this.#config.heartbeatEnabled,
      compactionEnabled: compaction.compactionEnabled,
      minTurns: compaction.minTurns,
      maxTurns: compaction.maxTurns,
      idleTriggerSecs: compaction.idleTriggerSecs,
      archiveAfterSecs: compaction.archiveAfterSecs,
      maxContextTokens: compaction.maxContextTokens,
    };
  }

  setHeartbeatConfig(clock: HeartbeatClockConfig, now: number): void {
    const before = this.#clock.nextWakeAt;
    this.#clock.setConfig(clock, now);
    if (this.#clock.nextWakeAt !== before) this.#state.dirty = true;
  }

  shouldCompactNow(turnCount: number, contextTokens: number, crowded = false): boolean {
    const c = this.#config;
    if (!c.compactionEnabled) return false;
    if (!crowded) {
      if (turnCount < c.minTurns) return false;
      const overTurns = c.maxTurns > 0 && turnCount >= c.maxTurns;
      const overTokens = c.maxContextTokens > 0 && contextTokens >= c.maxContextTokens;
      if (!overTurns && !overTokens) return false;
    }

    this.#state.compactionTriggered = true;
    this.#state.dirty = true;
    return true;
  }

  scheduleNextWake(hoursFromNow: number, reason: string, now: number): number {
    const hours = this.#clock.schedule(now + hoursFromNow * 3_600_000, now) / 3_600_000;
    this.note("tool_use", `set_next_wake: ${hours.toFixed(1)}h - ${reason}`, now);
    this.#state.dirty = true;
    return hours;
  }

  forceHeartbeatNow(now: number): boolean {
    const dormant = this.#clock.isDormant(now);
    this.#clock.forceWake(now);
    this.#state.dirty = true;
    return dormant;
  }

  forceDormant(): void {
    this.#clock.forceDormant();
    this.#state.dirty = true;
  }

  forceActive(now: number): void {
    this.#clock.forceActive(now);
    this.#state.dirty = true;
  }

  recordUserActivity(localAt: number): void {
    this.#activity.recordMessage(localAt);
  }

  backfillActivity(localTimestamps: readonly number[], latestUserAt: number | undefined): void {
    this.#activity.backfill(localTimestamps);
    if (latestUserAt !== undefined) this.#clock.seedLastUserAtIfUnset(latestUserAt);
  }

  activityStats(
    now: number,
    localAt: number,
    days?: number,
  ): { stats: ActivityStats; messageCount: number } {
    const window = days === undefined ? undefined : { localNow: localAt, days };
    return {
      stats: this.#activity.stats(now, weekdayOf(localAt), window),
      messageCount: this.#activity.messageCount,
    };
  }

  note(kind: HeartbeatEventKind, detail: string, now: number): void {
    this.#log.push(kind, detail, toRfc3339(now));
  }

  setKeepaliveSchedule(schedule: PersistedKeepalive | undefined): void {
    const current = this.#state.keepalive;
    const same =
      current === schedule ||
      (current !== undefined &&
        schedule !== undefined &&
        current.model === schedule.model &&
        current.identity === schedule.identity &&
        current.intervalMs === schedule.intervalMs &&
        current.lastWarmAt === schedule.lastWarmAt &&
        current.lastActiveAt === schedule.lastActiveAt &&
        current.pingsSent === schedule.pingsSent &&
        current.maxPings === schedule.maxPings);
    if (same) return;
    this.#state.keepalive = schedule;
    this.#state.dirty = true;
  }

  inputs(now: number): TickInputs {
    const c = this.#config;
    const s = this.#state;
    return {
      autonomyEnabled: c.autonomyEnabled,
      heartbeatEnabled: c.heartbeatEnabled,

      compactionEnabled: c.compactionEnabled,
      compactionTriggered: s.compactionTriggered,
      deepArchiveDone: s.deepArchiveDone,
      activeTurnCount: s.activeTurnCount,
      minTurns: c.minTurns,
      idleSecs: Math.trunc(Math.max(now - s.lastActivityAt, 0) / 1000),
      idleTriggerSecs: c.idleTriggerSecs,
      archiveAfterSecs: c.archiveAfterSecs,
    };
  }

  async tick(): Promise<TickOutcome> {
    const now = this.#now();
    const decision = tickDecision(this.inputs(now));
    const abandoned: "deep_archive"[] = [];

    if (decision.compaction !== undefined || decision.deepArchive) {
      this.#state.compactionTriggered = true;
      this.#state.dirty = true;
    }

    const heartbeat = this.#runClock(decision, now);
    try {
      if (heartbeat === "run_tick") {
        this.note("tick_fired", "Heartbeat tick fired", now);
        this.#apply(
          await this.#executor.runHeartbeatTick(this.#character, {
            scheduleNextWake: (hours, reason) =>
              this.scheduleNextWake(hours, reason, this.#now()),
          }),
        );
      }

      if (decision.compaction !== undefined) {
        this.#applyCompaction(
          await this.#executor.runCompaction(this.#character, decision.compaction),
        );
      }

      if (decision.deepArchive) {
        if (this.#stillIdleEnoughToArchive()) {
          const result = await this.#executor.runDeepArchive(
            this.#character,
            this.#state.coveredTurnCount,
          );
          this.#applyCompaction(result);
          if (result.deepArchiveDone ?? result.failed === undefined) {
            this.#state.deepArchiveDone = true;
          }
        } else {
          this.#state.compactionTriggered = false;
          abandoned.push("deep_archive");
        }
        this.#state.dirty = true;
      }
    } catch (err) {
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
      abandoned,
    };
  }

  #apply(result: AutonomyActionResult): void {
    const now = this.#now();
    for (const event of result.events) this.note(event.kind, event.detail, now);
  }

  #applyCompaction(result: AutonomyActionResult): void {
    this.#apply(result);
    const now = this.#now();
    if (result.failed === undefined && result.turnCount !== undefined) {
      this.onCompactionComplete(result.turnCount, now);
      return;
    }
    this.onCompactionFailed(now, result.retryAt);
  }

  #stillIdleEnoughToArchive(): boolean {
    const i = this.inputs(this.#now());
    return i.archiveAfterSecs > 0 && !i.deepArchiveDone && i.idleSecs >= i.archiveAfterSecs;
  }

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
    }
    return action;
  }

  snapshot(): AutonomyStateFile {
    const clock = this.#clock.snapshot();
    return {
      ticksWithoutUser: clock.ticks_without_user,
      nextWakeAt: clock.next_wake_at,
      lastUserAt: clock.last_user_at,
      ...(clock.forced_dormant === true ? { forcedDormant: true } : {}),
      ...(clock.default_wake === true ? { defaultWake: true } : {}),
      ...(clock.wake_anchor_at === undefined ? {} : { wakeAnchorAt: clock.wake_anchor_at }),
      coveredTurnCount: this.#state.coveredTurnCount,
      keepalive: this.#state.keepalive,
    };
  }

  async persist(): Promise<void> {
    if (this.#state.dirty) {
      if (await saveState(this.#statePath, this.snapshot())) this.#state.dirty = false;
    }
    await this.#log.flushIfDirty();
  }

  async shutdown(): Promise<void> {
    this.#state.dirty = true;
    await this.persist();
  }
}
