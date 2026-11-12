import { shoreLog } from "../log.ts";

import type { ActivityStats } from "./activity.ts";
import { Dormancy, type DormancyConfig } from "./dormancy.ts";
import { HeartbeatLog, type HeartbeatEvent } from "./heartbeat_log.ts";
import {
  type KeepaliveHalt,
  type KeepaliveService,
} from "../cache/keepalive.ts";
import {
  CharacterAutonomy,
  type AutonomyEvents,
  type AutonomyExecutor,
  type AutonomyRunnerConfig,
  type CompactionRunnerConfig,
  type DreamRunnerConfig,
  type DreamStatus,
  type RestoredIdle,
  type RunningWake,
  type TriggerFiring,
  type WakeRequest,
} from "./runner.ts";
import { loadState, STATE_FILENAME, type PersistedKeepalive } from "./state_file.ts";
import type { KeepaliveSnapshot } from "../cache/schedule.ts";
import { required } from "../util/required.ts";

const AUTONOMY_TICK_MS = 10_000;

export const HEARTBEAT_LOG_FILENAME = "heartbeat.jsonl";

export interface RegisterCharacter {
  character: string;
  data_dir: string;
  config: AutonomyRunnerConfig;
  dormancy: DormancyConfig;
  restoreIdle?: () => Promise<RestoredIdle | undefined>;
}

export interface AutonomyStatus {
  character: string;
  state: import("../protocol/AutonomyState.ts").AutonomyState;
  wakes_without_user: number;
  covered_turn_count: number;
  last_user_at?: number;
  max_idle_wakes: number;
  max_silent_ms: number;
  recent_events: HeartbeatEvent[];
}

const RECENT_EVENT_LIMIT = 5;

export interface ActivityReport {
  stats: ActivityStats;
  messageCount: number;
}

export interface RunningView {
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
  #listener: ((character: string) => AutonomyEvents) | undefined;
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

  onEvents(listener: (character: string) => AutonomyEvents): void {
    this.#listener = listener;
  }

  characters(): string[] {
    return [...this.#entries.keys()];
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
    const idle = await request.restoreIdle?.();
    const runner = new CharacterAutonomy({
      character,
      config: request.config,
      executor: this.#executor,
      statePath,
      dormancy: new Dormancy(request.dormancy),
      log: await HeartbeatLog.load(`${dataDir}/${HEARTBEAT_LOG_FILENAME}`),
      restored,
      idle,
      events: {
        wakeDone: (triggers) => { this.#listener?.(character).wakeDone(triggers); },
        dreamDone: () => { this.#listener?.(character).dreamDone(); },
      },
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

  setDormancyConfig(character: string, config: DormancyConfig): void {
    this.#entries.get(character)?.runner.setDormancyConfig(config);
  }

  setDreamConfig(character: string, dream: DreamRunnerConfig): void {
    this.#entries.get(character)?.runner.setDreamConfig(dream);
  }

  forceDreamNow(character: string): "queued" | "running" | undefined {
    return this.#entries.get(character)?.runner.forceDream();
  }

  runningDreams(): RunningView[] {
    return [...this.#entries].flatMap(([character, { runner }]) => {
      const startedAt = runner.dreamStartedAt;
      return startedAt === undefined ? [] : [{ character, startedAt }];
    });
  }

  async dreamsEnded(): Promise<void> {
    await Promise.all([...this.#entries.values()].map(async ({ runner }) => { await runner.dreamEnded(); }));
  }

  dreamStatus(character: string): DreamStatus | undefined {
    return this.#entries.get(character)?.runner.dreamStatus();
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
      else this.#foreground.delete(character);
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
    const stopDreams = async () => {
      await Promise.allSettled([...this.#entries.values()].map(async ({ runner }) => { await runner.stopDream(); }));
    };
    await Promise.allSettled([...this.#ticks, stopDreams()]);
    await stopDreams();
  }

  runningWakes(): RunningView[] {
    return [...this.#entries].flatMap(([character, { runner }]) => {
      const startedAt = runner.runningWake?.startedAt;
      return startedAt === undefined ? [] : [{ character, startedAt }];
    });
  }

  wakeFor(character: string, firing: TriggerFiring): "handed" | "queued" | undefined {
    return this.#entries.get(character)?.runner.wakeFor(firing);
  }

  requestWake(character: string, firing: TriggerFiring, overwrite: boolean): WakeRequest {
    return required(this.#entries.get(character)).runner.requestWake(firing, overwrite);
  }

  userActiveIn(character: string, thread: string): void {
    this.#entries.get(character)?.runner.userActiveIn(thread, this.#now());
  }

  runningWake(character: string): RunningWake | undefined {
    return this.#entries.get(character)?.runner.runningWake;
  }

  async #tickDue(): Promise<void> {
    const due: [string, Entry][] = [];
    for (const pair of this.#entries) {
      pair[1].runner.setKeepaliveSchedule(toPersisted(this.#keepalive?.scheduleFor(pair[0])));
      if (pair[1].inFlight) continue;
      pair[1].inFlight = true;
      due.push(pair);
    }
    await Promise.all(
      due.map(async ([character, entry]) => {
        try {
          await entry.runner.tick(this.#foreground.has(character));
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

  onUserActivityElsewhere(character: string, localAt: number): void {
    const runner = this.#entries.get(character)?.runner;
    if (runner === undefined) return;
    runner.onUserActivityElsewhere(this.#now());
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
    const bounds = runner.dormancy.config;
    const status: AutonomyStatus = {
      character,
      state: runner.dormancy.isDormant(now) ? "Dormant" : "Active",
      wakes_without_user: snapshot.wakesWithoutUser,
      covered_turn_count: snapshot.coveredTurnCount,
      max_idle_wakes: bounds.maxIdleWakes,
      max_silent_ms: bounds.maxSilentMs,
      recent_events: runner.log.recent(RECENT_EVENT_LIMIT),
    };
    if (snapshot.lastUserAt !== undefined) status.last_user_at = snapshot.lastUserAt;
    return status;
  }

  wakesMayRun(character: string): boolean {
    return this.#entries.get(character)?.runner.wakesMayRun ?? false;
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

  wakeNow(character: string): boolean | undefined {
    return this.#entries.get(character)?.runner.wakeNow(this.#now());
  }

  forceDormancy(character: string, state: "dormant" | "active"): boolean {
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
