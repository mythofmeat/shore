import { shoreLog } from "../log.ts";

import type { ActivityStats } from "./activity.ts";
import { HeartbeatClock, type HeartbeatClockConfig } from "./heartbeat.ts";
import { HeartbeatLog, type HeartbeatEvent } from "./heartbeat_log.ts";
import {
  type KeepaliveHalt,
  type KeepaliveService,
} from "../cache/keepalive.ts";
import {
  CharacterAutonomy,
  type AutonomyExecutor,
  type AutonomyRunnerConfig,
  type CompactionRunnerConfig,
} from "./runner.ts";
import { loadState, STATE_FILENAME, type PersistedKeepalive } from "./state_file.ts";
import type { KeepaliveSnapshot } from "../cache/schedule.ts";

const AUTONOMY_TICK_MS = 10_000;

export const HEARTBEAT_LOG_FILENAME = "heartbeat.jsonl";

export interface RegisterCharacter {
  character: string;
  data_dir: string;
  config: AutonomyRunnerConfig;
  clock: HeartbeatClockConfig;
}

export interface AutonomyStatus {
  character: string;
  heartbeat_state: import("../protocol/AutonomyHeartbeatState.ts").AutonomyHeartbeatState;
  ticks_without_user: number;
  covered_turn_count: number;
  next_wake_at?: number;
  last_user_at?: number;
  default_interval_ms: number;
  max_idle_ticks: number;
  min_interval_ms: number;
  max_interval_ms: number;
  max_silent_ms: number;
  recent_events: HeartbeatEvent[];
}

const RECENT_EVENT_LIMIT = 5;

export interface ActivityReport {
  stats: ActivityStats;
  messageCount: number;
}

export interface HeartbeatView {
  character: string;
  startedAt: number;
}

interface Entry {
  runner: CharacterAutonomy;
  inFlight: boolean;
}

function toPersisted(s: KeepaliveSnapshot | undefined): PersistedKeepalive | undefined {
  return s === undefined
    ? undefined
    : {
        model: s.model,
        ...(s.identity === undefined ? {} : { identity: s.identity }),
        intervalMs: s.interval,
        lastWarmAt: s.last_warm_at,
        lastActiveAt: s.last_active_at,
        ...(s.pings_sent === undefined ? {} : { pingsSent: s.pings_sent }),
        ...(s.max_pings === undefined ? {} : { maxPings: s.max_pings }),
      };
}

function toSnapshot(p: PersistedKeepalive): KeepaliveSnapshot {
  return {
    model: p.model,
    ...(p.identity === undefined ? {} : { identity: p.identity }),
    interval: p.intervalMs,
    last_warm_at: p.lastWarmAt,
    last_active_at: p.lastActiveAt,
    ...(p.pingsSent === undefined ? {} : { pings_sent: p.pingsSent }),
    ...(p.maxPings === undefined ? {} : { max_pings: p.maxPings }),
  };
}

export class AutonomyService {
  readonly #foreground = new Map<string, number>();
  readonly #entries = new Map<string, Entry>();
  readonly #executor: AutonomyExecutor;
  readonly #now: () => number;
  #keepalive: KeepaliveService | undefined;
  #closed = false;
  readonly #ticks = new Set<Promise<void>>();

  constructor(executor: AutonomyExecutor, now: () => number = () => Date.now()) {
    this.#executor = executor;
    this.#now = now;
  }

  attachKeepalive(keepalive: KeepaliveService): void {
    this.#keepalive = keepalive;
    keepalive.onEvent((event) => {
      this.#entries.get(event.character)?.runner.note("dormant_ping", event.detail, event.at);
    });
  }

  keepaliveHalts(character: string): KeepaliveHalt[] {
    return this.#keepalive?.haltsFor(character) ?? [];
  }

  async register(request: RegisterCharacter): Promise<void> {
    const { character, data_dir: dataDir } = request;
    const existing = this.#entries.get(character);
    if (existing !== undefined) await this.#shutdownRunner(character, existing);

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

    const persisted = restored?.keepalive;
    if (persisted !== undefined) {
      this.#keepalive?.restore(character, toSnapshot(persisted));
    }
  }

  setCompactionConfig(character: string, compaction: CompactionRunnerConfig): void {
    this.#entries.get(character)?.runner.setCompactionConfig(compaction);
  }

  setHeartbeatConfig(character: string, clock: HeartbeatClockConfig): void {
    this.#entries.get(character)?.runner.setHeartbeatConfig(clock, this.#now());
  }

  async unregister(character: string): Promise<void> {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    this.#entries.delete(character);
    await this.#shutdownRunner(character, entry);
  }

  async #shutdownRunner(character: string, entry: Entry): Promise<void> {
    entry.runner.setKeepaliveSchedule(toPersisted(this.#keepalive?.scheduleFor(character)));
    await entry.runner.shutdown();
  }

  beginForeground(character: string): () => void {
    this.#foreground.set(character, (this.#foreground.get(character) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#foreground.get(character) ?? 1) - 1;
      if (remaining > 0) this.#foreground.set(character, remaining);
      else {
        this.#foreground.delete(character);
        this.#entries.get(character)?.runner.deferHeartbeat(this.#now());
      }
    };
  }

  async tick(): Promise<void> {
    if (this.#closed) return;
    const work = this.#tickDue();
    this.#ticks.add(work);
    try {
      await work;
    } finally {
      this.#ticks.delete(work);
    }
  }

  async quiesce(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#ticks);
  }

  runningHeartbeats(): HeartbeatView[] {
    return [...this.#entries].flatMap(([character, { runner }]) => {
      const startedAt = runner.heartbeatStartedAt;
      return startedAt === undefined ? [] : [{ character, startedAt }];
    });
  }

  async #tickDue(): Promise<void> {
    const due: [string, Entry][] = [];
    for (const pair of this.#entries) {
      pair[1].runner.setKeepaliveSchedule(toPersisted(this.#keepalive?.scheduleFor(pair[0])));
      if (pair[1].inFlight || this.#foreground.has(pair[0])) continue;
      pair[1].inFlight = true;
      due.push(pair);
    }
    await Promise.all(
      due.map(async ([character, entry]) => {
        try {
          await entry.runner.tick();
        } catch (err) {
          shoreLog.error(`shore: autonomy tick failed for ${character}: ${String(err)}`);
        } finally {
          entry.inFlight = false;
        }
      }),
    );
  }

  onUserMessage(character: string, turnCount: number, localAt: number): void {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return;
    runner.onUserMessage(turnCount, this.#now());
    runner.recordUserActivity(localAt);
  }

  backfillActivity(
    character: string,
    localTimestamps: readonly number[],
    latestUserAt: number | undefined,
  ): void {
    this.#entries.get(character)?.runner.backfillActivity(localTimestamps, latestUserAt);
  }

  activityStats(character: string, localAt: number, days?: number): ActivityReport | undefined {
    return this.#entries.get(character)?.runner.activityStats(this.#now(), localAt, days);
  }

  onAssistantMessage(character: string, turnCount: number): void {
    this.#entries.get(character)?.runner.onAssistantMessage(turnCount, this.#now());
  }

  onCompactionComplete(character: string, turnCount: number): void {
    this.#entries.get(character)?.runner.onCompactionComplete(turnCount, this.#now());
  }

  status(character: string): AutonomyStatus | undefined {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return undefined;
    const now = this.#now();
    const snapshot = runner.snapshot();
    const bounds = runner.clock.config;
    const status: AutonomyStatus = {
      character,
      heartbeat_state: runner.clock.stateAt(now),
      ticks_without_user: snapshot.ticksWithoutUser,
      covered_turn_count: snapshot.coveredTurnCount,
      default_interval_ms: bounds.defaultIntervalMs,
      max_idle_ticks: bounds.maxIdleTicks,
      min_interval_ms: bounds.minIntervalMs,
      max_interval_ms: bounds.maxIntervalMs,
      max_silent_ms: bounds.maxSilentMs,
      recent_events: runner.log.recent(RECENT_EVENT_LIMIT),
    };
    if (snapshot.nextWakeAt !== undefined) status.next_wake_at = snapshot.nextWakeAt;
    if (snapshot.lastUserAt !== undefined) status.last_user_at = snapshot.lastUserAt;
    return status;
  }

  heartbeatsRunning(character: string): boolean {
    return this.#entries.get(character)?.runner.heartbeatMayTick ?? false;
  }

  scheduleNextWake(character: string, hoursFromNow: number, reason: string): number | undefined {
    return this.#entries
      .get(character)
      ?.runner.scheduleNextWake(hoursFromNow, reason, this.#now());
  }

  onCompactionFailed(character: string, retryAt?: number): void {
    this.#entries.get(character)?.runner.onCompactionFailed(this.#now(), retryAt);
  }

  shouldCompactNow(
    character: string,
    turnCount: number,
    contextTokens: number,
    crowded = false,
  ): boolean | undefined {
    return this.#entries.get(character)?.runner.shouldCompactNow(turnCount, contextTokens, crowded);
  }

  forceHeartbeatNow(character: string): boolean | undefined {
    return this.#entries.get(character)?.runner.forceHeartbeatNow(this.#now());
  }

  forceHeartbeatState(character: string, state: "dormant" | "active"): boolean {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return false;
    if (state === "dormant") runner.forceDormant();
    else runner.forceActive(this.#now());
    return true;
  }

  log(character: string, limit: number): HeartbeatEvent[] {
    return this.#entries.get(character)?.runner.log.recent(limit) ?? [];
  }

  runnerFor(character: string): CharacterAutonomy | undefined {
    return this.#entries.get(character)?.runner;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#entries].map(([character, entry]) => this.#shutdownRunner(character, entry)));
  }
}

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
