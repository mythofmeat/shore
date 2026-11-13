import { defaultDreamingConfig, parseDayWindow, type DreamingConfig } from "../config/app.ts";
import { ActivityTracker, localWallClock, weekdayOf, type ActivityStats } from "./activity.ts";
import { Dormancy, type DormancyConfig } from "./dormancy.ts";
import { HeartbeatLog, type HeartbeatEventKind } from "./heartbeat_log.ts";
import {
  dreamDue,
  dreamRetryDelayMs,
  tickDecision,
  type CompactionReason,
  type DayWindow,
  type TickInputs,
} from "./tick.ts";
import {
  NO_DREAM,
  saveState,
  toRfc3339,
  type AutonomyStateFile,
  type PersistedDream,
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

export interface DreamRunnerConfig {
  readonly enabled: boolean;
  readonly everyMs: number;
  readonly window: DayWindow | undefined;
  readonly idleAfterMs: number;
  readonly minTurns: number;
}

export function dreamRunnerConfig(dreaming: DreamingConfig): DreamRunnerConfig {
  return {
    enabled: dreaming.enabled,
    everyMs: Number(dreaming.every.asMillisExact()),
    window: dreaming.start_between === undefined ? undefined : parseDayWindow(dreaming.start_between),
    idleAfterMs: Number(dreaming.idle_after.asMillisExact()),
    minTurns: dreaming.min_turns,
  };
}

export const DREAMING_OFF: DreamRunnerConfig = dreamRunnerConfig(defaultDreamingConfig());

const DREAM_SKIP_RETRY_MS = 3_600_000;

export interface AutonomyRunnerConfig extends CompactionRunnerConfig {
  readonly autonomyEnabled: boolean;
  readonly dream?: DreamRunnerConfig;
}

export type DreamResultKind = "finished" | "cut_off" | "failed" | "skipped" | "paused" | "interrupted";

export interface DreamWindow {
  readonly since: number;
  readonly forced: boolean;
  readonly signal: AbortSignal;
}

interface RunningDream {
  readonly startedAt: number;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

export interface AutonomyActionResult {
  readonly turnCount?: number | undefined;
  readonly events: readonly { kind: HeartbeatEventKind; detail: string; at?: number }[];
  readonly failed?: string | undefined;
  readonly deepArchiveDone?: boolean | undefined;
  readonly retryAt?: number | undefined;
}

export interface DreamActionResult extends AutonomyActionResult {
  readonly dream: DreamResultKind;
}

export interface DreamStatus {
  readonly enabled: boolean;
  readonly queued: boolean;
  readonly running: boolean;
  readonly lastAt: number | undefined;
  readonly nextDueAt: number | undefined;
}

export interface TriggerFiring {
  readonly name: string;
  readonly reason: string;
  readonly at: number;
  readonly thread?: string | undefined;
  readonly limitMs?: number | undefined;
  readonly from?: string | undefined;
  readonly seal?: boolean | undefined;
  readonly byHand?: boolean | undefined;
  readonly interruptedAt?: number | undefined;
}

export interface OpenedSeal {
  readonly thread: string;
  readonly reason: string;
}

export type WakeRequest =
  | { readonly kind: "queued"; readonly replaced: TriggerFiring | undefined }
  | { readonly kind: "waiting"; readonly waiting: TriggerFiring };

export const WAKE_QUIET_MS = 10 * 60_000;

export const DEFAULT_WAKE_LIMIT_MS = 30 * 60_000;

const STARTED_BY_HAND = "It was started by hand, from Shore's command line or its settings.";

export function firedBy(firings: readonly TriggerFiring[]): string {
  const triggers = firings.filter((firing) => firing.from === undefined && firing.seal !== true && firing.byHand !== true).map((firing) => `"${firing.name}"`);
  const handed = firings.flatMap((firing) => firing.from === undefined ? [] : [`"${firing.from}"`]);
  return [
    ...(triggers.length === 0 ? [] : [`trigger ${triggers.join(", ")}`]),
    ...(firings.some((firing) => firing.byHand === true) ? ["a start by hand"] : []),
    ...(handed.length === 0 ? [] : [`a hand-off from ${handed.join(", ")}`]),
    ...(firings.some((firing) => firing.seal === true) ? ["its seal coming off"] : []),
  ].join(" and ");
}

export type WakeNews =
  | { readonly kind: "user_wrote"; readonly at: number }
  | { readonly kind: "trigger"; readonly firing: TriggerFiring };

function firingsIn(news: readonly WakeNews[]): TriggerFiring[] {
  return news.flatMap((item) => item.kind === "trigger" ? [item.firing] : []);
}

export interface WakeHooks {
  news(wrappingUp: boolean): WakeNews[];
  newsHeard(): void;
}

export interface RunningWake {
  readonly startedAt: number;
  readonly thread: string | undefined;
}

export interface WakeRun {
  readonly thread: string | undefined;
  readonly fired: readonly TriggerFiring[];
  readonly limitMs: number;
  readonly interrupted: () => boolean;
}

export interface WakeResult extends AutonomyActionResult {
  interrupted?: true;
}

interface LiveWake extends RunningWake {
  readonly news: WakeNews[];
  readonly firings: TriggerFiring[];
  userTold: boolean;
}

export interface AutonomyEvents {
  wakeDone(triggers: readonly string[]): void;
  dreamDone(): void;
}

export interface AutonomyExecutor {
  runWake(character: string, wake: WakeRun, hooks: WakeHooks): Promise<WakeResult>;
  runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult>;
  runDeepArchive(character: string, coveredTurnCount: number): Promise<AutonomyActionResult>;
  runDream?(character: string, window: DreamWindow): Promise<DreamActionResult>;
  openSeals?(character: string, now: number): Promise<OpenedSeal[]>;
}

interface RunnerState {
  dirty: boolean;
  lastActivityAt: number;
  compactionTriggered: boolean;
  deepArchiveDone: boolean;
  activeTurnCount: number;
  coveredTurnCount: number;
  keepalive: PersistedKeepalive | undefined;
  dream: { -readonly [K in keyof PersistedDream]: PersistedDream[K] };
}

export interface RestoredIdle {
  readonly turnCount: number;
  readonly lastActivityAt?: number;
}

export class CharacterAutonomy {
  readonly #character: string;
  #config: AutonomyRunnerConfig;
  readonly #executor: AutonomyExecutor;
  readonly #statePath: string;

  readonly #dormancy: Dormancy;
  readonly #log: HeartbeatLog;
  readonly #activity = new ActivityTracker();
  readonly #now: () => number;
  #state: RunnerState;
  #wakeRunning: LiveWake | undefined;
  readonly #fired: TriggerFiring[] = [];
  readonly #userActiveAt = new Map<string, number>();
  readonly #events: AutonomyEvents | undefined;
  #dream: RunningDream | undefined;
  #resting: boolean;

  constructor(opts: {
    character: string;
    config: AutonomyRunnerConfig;
    executor: AutonomyExecutor;
    statePath: string;
    dormancy: Dormancy;
    log: HeartbeatLog;
    restored?: AutonomyStateFile | undefined;
    idle?: RestoredIdle | undefined;
    events?: AutonomyEvents | undefined;
    now: () => number;
  }) {
    this.#character = opts.character;
    this.#config = opts.config;
    this.#executor = opts.executor;
    this.#statePath = opts.statePath;
    this.#dormancy = opts.dormancy;
    this.#log = opts.log;
    this.#events = opts.events;
    this.#now = opts.now;

    const restored = opts.restored;
    if (restored !== undefined) this.#dormancy.restore(restored);
    this.#resting = this.#dormancy.isDormant(opts.now());
    this.#state = {
      dirty: false,
      lastActivityAt: opts.idle?.lastActivityAt ?? opts.now(),
      compactionTriggered: false,
      deepArchiveDone: false,
      activeTurnCount: opts.idle?.turnCount ?? 0,
      coveredTurnCount: restored?.coveredTurnCount ?? 0,
      keepalive: restored?.keepalive,
      dream: { ...(restored?.dream ?? NO_DREAM) },
    };
  }

  get dormancy(): Dormancy {
    return this.#dormancy;
  }

  get log(): HeartbeatLog {
    return this.#log;
  }

  get runningWake(): RunningWake | undefined {
    return this.#wakeRunning;
  }

  get wakesMayRun(): boolean {
    return this.#config.autonomyEnabled;
  }

  onUserMessage(turnCount: number, now: number): void {
    if (this.#dormancy.wakesWithoutUser > 0) {
      this.note("wake", "User returned — idle counter reset", now);
    }
    this.#dormancy.onUserMessage(now);
    this.#tellWakeUserWrote(now);
    this.#state.activeTurnCount = turnCount;
    this.#state.lastActivityAt = now;
    this.#state.compactionTriggered = false;
    this.#state.deepArchiveDone = false;
    this.#state.dream.turnsSince += 1;
    this.#state.dirty = true;
  }

  onUserActivityElsewhere(now: number): void {
    if (this.#dormancy.wakesWithoutUser > 0) {
      this.note("wake", "User active in another thread — idle counter reset", now);
    }
    this.#dormancy.onUserMessage(now);
    this.#tellWakeUserWrote(now);
    this.#state.dream.turnsSince += 1;
    this.#state.dirty = true;
  }

  #tellWakeUserWrote(now: number): void {
    const running = this.#wakeRunning;
    if (running === undefined || running.userTold) return;
    running.userTold = true;
    running.news.push({ kind: "user_wrote", at: now });
  }

  userActiveIn(thread: string, now: number): void {
    this.#userActiveAt.set(thread, now);
  }

  wakeFor(firing: TriggerFiring): "handed" | "queued" {
    const running = this.#wakeRunning;
    if (running !== undefined && firing.thread === running.thread && firing.from === undefined) {
      running.news.push({ kind: "trigger", firing });
      running.firings.push(firing);
      return "handed";
    }
    this.#queue(firing);
    return "queued";
  }

  requestWake(firing: TriggerFiring, overwrite: boolean): WakeRequest {
    const asked = (other: TriggerFiring): boolean => other.from !== undefined && other.thread === firing.thread && other.interruptedAt === undefined;
    const waiting = this.#fired.find(asked);
    if (waiting !== undefined && !overwrite) return { kind: "waiting", waiting };
    this.#fired.splice(0, this.#fired.length, ...this.#fired.filter((other) => !asked(other)));
    this.#queue(firing);
    return { kind: "queued", replaced: waiting };
  }

  #queue(firing: TriggerFiring): void {
    const same = (other: TriggerFiring): boolean =>
      other.name === firing.name && other.thread === firing.thread && other.from === firing.from && (firing.from === undefined || other.reason === firing.reason);
    const waiting = this.#fired.find(same);
    const kept = this.#fired.filter((other) => !same(other));
    this.#fired.splice(0, this.#fired.length, ...kept, { ...firing, interruptedAt: firing.interruptedAt ?? waiting?.interruptedAt });
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
      compactionEnabled: compaction.compactionEnabled,
      minTurns: compaction.minTurns,
      maxTurns: compaction.maxTurns,
      idleTriggerSecs: compaction.idleTriggerSecs,
      archiveAfterSecs: compaction.archiveAfterSecs,
      maxContextTokens: compaction.maxContextTokens,
      ...(this.#config.dream === undefined ? {} : { dream: this.#config.dream }),
    };
  }

  setDreamConfig(dream: DreamRunnerConfig): void {
    this.#config = { ...this.#config, dream };
  }

  forceDream(): "queued" | "running" {
    if (this.#dream !== undefined) return "running";
    const dream = this.#state.dream;
    dream.forced = true;
    delete dream.retryAt;
    this.#state.dirty = true;
    return "queued";
  }

  get dreamStartedAt(): number | undefined {
    return this.#dream?.startedAt;
  }

  async dreamEnded(): Promise<void> {
    await this.#dream?.done;
  }

  async stopDream(): Promise<void> {
    const running = this.#dream;
    if (running === undefined) return;
    running.abort.abort(new Error("the dream was stopped"));
    await running.done;
  }

  dreamStatus(): DreamStatus {
    const config = this.#config.dream ?? DREAMING_OFF;
    const dream = this.#state.dream;
    const due = dream.lastAt === undefined ? undefined : dream.lastAt + config.everyMs;
    const next = due === undefined ? dream.retryAt : Math.max(due, dream.retryAt ?? due);
    return {
      enabled: config.enabled,
      queued: dream.forced,
      running: this.#dream !== undefined,
      lastAt: dream.lastAt,
      nextDueAt: config.enabled ? next : undefined,
    };
  }

  setDormancyConfig(config: DormancyConfig): void {
    this.#dormancy.setConfig(config);
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

  wakeNow(now: number): boolean {
    this.#queue({ name: "", byHand: true, reason: STARTED_BY_HAND, at: now });
    return this.#dormancy.isDormant(now);
  }

  forceDormant(): void {
    this.#dormancy.forceDormant();
    this.#state.dirty = true;
  }

  forceActive(now: number): void {
    this.#dormancy.onUserMessage(now);
    this.#state.dirty = true;
  }

  recordUserActivity(localAt: number): void {
    this.#activity.recordMessage(localAt);
  }

  backfillActivity(localTimestamps: readonly number[], latestUserAt: number | undefined): void {
    this.#activity.backfill(localTimestamps);
    if (latestUserAt !== undefined) this.#dormancy.seedLastUserAtIfUnset(latestUserAt);
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

  async tick(foreground: boolean): Promise<void> {
    if (this.#dream !== undefined) {
      await this.persist();
      return;
    }
    const now = this.#now();
    const decided = tickDecision(this.inputs(now));
    const decision = foreground ? { ...decided, compaction: undefined, deepArchive: false } : decided;

    if (decision.compaction !== undefined || decision.deepArchive) {
      this.#state.compactionTriggered = true;
      this.#state.dirty = true;
    }

    for (const opened of await this.#executor.openSeals?.(this.#character, now) ?? []) {
      this.#queue({ name: "", reason: opened.reason, at: now, thread: opened.thread, seal: true });
    }

    const resting = this.#dormancy.isDormant(now);
    if (resting && !this.#resting) this.note("dormant", `Went dormant (wakes without the user: ${String(this.#dormancy.wakesWithoutUser)})`, now);
    this.#resting = resting;
    const due = this.#fired.splice(0).filter((firing) => this.wakesMayRun && (firing.seal === true || !resting));
    let woke = false;
    try {
      for (const thread of new Set(due.map((firing) => firing.thread))) {
        const here = due.filter((firing) => firing.thread === thread);
        const started = this.#now();
        const lastActive = (): number => (thread === undefined ? undefined : this.#userActiveAt.get(thread)) ?? Number.NEGATIVE_INFINITY;
        if (started - lastActive() < WAKE_QUIET_MS) {
          for (const firing of here) this.#queue(firing);
          continue;
        }
        woke = true;
        this.note("tick_fired", `Woken${thread === undefined ? "" : ` in "${thread}"`} by ${firedBy(here)}`, started);
        const limitMs = Math.max(...here.map((firing) => firing.limitMs ?? DEFAULT_WAKE_LIMIT_MS));
        await this.#wake({ startedAt: started, thread, news: [], firings: [...here], userTold: false }, async (hooks) =>
          await this.#executor.runWake(this.#character, { thread, fired: here, limitMs, interrupted: () => lastActive() >= started }, hooks));
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
        }
        this.#state.dirty = true;
      }

      const worked = woke || decision.compaction !== undefined || decision.deepArchive;
      if (!worked && this.#dreamDue(foreground)) this.#startDream();
    } catch (err) {
      this.#state.compactionTriggered = false;
      this.#state.dirty = true;
      throw err;
    } finally {
      await this.persist();
    }
  }

  async #wake(running: LiveWake, run: (hooks: WakeHooks) => Promise<WakeResult>): Promise<void> {
    this.#wakeRunning = running;
    this.#dormancy.wakeStarted();
    this.#state.dirty = true;
    await this.persist();
    let result: WakeResult | undefined;
    const shown: TriggerFiring[] = [];
    try {
      result = await run({
        news: (wrappingUp) => {
          const held = running.news.filter((item) => wrappingUp && item.kind === "trigger");
          const told = running.news.filter((item) => !held.includes(item));
          running.news.splice(0, running.news.length, ...held);
          shown.push(...firingsIn(told));
          return told;
        },
        newsHeard: () => { shown.length = 0; },
      });
      this.#apply(result);
    } finally {
      this.#wakeRunning = undefined;
      const stoppedAt = this.#now();
      const unheard = [...shown, ...firingsIn(running.news)];
      if (result?.interrupted === true) for (const firing of running.firings) this.#queue({ ...firing, interruptedAt: stoppedAt });
      else {
        for (const firing of unheard) this.#queue(firing);
        this.#events?.wakeDone(running.firings.filter((firing) => !unheard.includes(firing)).map((firing) => firing.name));
      }
    }
  }

  #apply(result: AutonomyActionResult): void {
    const now = this.#now();
    for (const event of result.events) this.note(event.kind, event.detail, event.at ?? now);
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

  #dreamDue(foreground: boolean): boolean {
    if (this.#executor.runDream === undefined) return false;
    const now = this.#now();
    const config = this.#config.dream ?? DREAMING_OFF;
    const dream = this.#state.dream;
    const lastUserAt = this.#dormancy.lastUserAt;
    const local = localWallClock(now);
    return dreamDue({
      enabled: config.enabled,
      forced: dream.forced,
      foreground,
      now,
      localMinute: Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000),
      lastDreamAt: dream.lastAt,
      everyMs: config.everyMs,
      window: config.window,
      quietMs: lastUserAt === undefined ? Number.POSITIVE_INFINITY : now - lastUserAt,
      idleAfterMs: config.idleAfterMs,
      turnsSince: dream.turnsSince,
      minTurns: config.minTurns,
      retryAt: dream.retryAt,
    });
  }

  #startDream(): void {
    const runDream = this.#executor.runDream?.bind(this.#executor);
    if (runDream === undefined) return;
    const config = this.#config.dream ?? DREAMING_OFF;
    const dream = this.#state.dream;
    const startedAt = this.#now();
    const turnsAtStart = dream.turnsSince;
    const forced = dream.forced;
    dream.forced = false;
    this.#state.dirty = true;
    const abort = new AbortController();
    const done = (async () => {
      let kind: DreamResultKind;
      try {
        const result = await runDream(this.#character, { since: startedAt - config.everyMs, forced, signal: abort.signal });
        this.#apply(result);
        kind = result.dream;
      } catch (err) {
        kind = abort.signal.aborted ? "interrupted" : "failed";
        if (kind === "interrupted") this.note("dream_finished", "Dream stopped when Shore shut down", this.#now());
        else this.note("dream_failed", `Dream failed — ${String(err)}`, this.#now());
      }
      this.#settleDream(kind, startedAt, turnsAtStart, forced);
      this.#dream = undefined;
      await this.persist();
    })();
    this.#dream = { startedAt, abort, done };
  }

  #settleDream(kind: DreamResultKind, startedAt: number, turnsAtStart: number, forced: boolean): void {
    const config = this.#config.dream ?? DREAMING_OFF;
    const dream = this.#state.dream;
    if (kind === "finished") {
      dream.lastAt = startedAt;
      dream.turnsSince = Math.max(0, dream.turnsSince - turnsAtStart);
    } else if (kind === "cut_off") {
      dream.lastAt = startedAt;
    }
    if (kind === "finished" || kind === "cut_off") {
      delete dream.retryAt;
      dream.failures = 0;
      this.#events?.dreamDone();
    } else if (kind === "skipped" || kind === "paused") {
      dream.retryAt = this.#now() + DREAM_SKIP_RETRY_MS;
    } else if (kind === "failed") {
      dream.failures += 1;
      dream.retryAt = this.#now() + dreamRetryDelayMs(dream.failures, config.everyMs);
    }
    if (forced && (kind === "paused" || kind === "interrupted")) dream.forced = true;
    this.#state.dirty = true;
  }

  #stillIdleEnoughToArchive(): boolean {
    const i = this.inputs(this.#now());
    return i.archiveAfterSecs > 0 && !i.deepArchiveDone && i.idleSecs >= i.archiveAfterSecs;
  }

  snapshot(): AutonomyStateFile {
    return {
      ...this.#dormancy.snapshot(),
      coveredTurnCount: this.#state.coveredTurnCount,
      keepalive: this.#state.keepalive,
      dream: { ...this.#state.dream },
    };
  }

  async persist(): Promise<void> {
    if (this.#state.dirty) {
      if (await saveState(this.#statePath, this.snapshot())) this.#state.dirty = false;
    }
    await this.#log.flushIfDirty();
  }

  async shutdown(): Promise<void> {
    await this.stopDream();
    this.#state.dirty = true;
    await this.persist();
  }
}
