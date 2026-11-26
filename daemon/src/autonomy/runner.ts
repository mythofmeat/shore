import { ActivityTracker, weekdayOf, type ActivityStats } from "./activity.ts";
import { Dormancy, type DormancyConfig } from "./dormancy.ts";
import { WakeLog, type WakeEventKind } from "./wake_log.ts";
import { tickDecision, type CompactionReason, type TickInputs } from "./tick.ts";
import { saveState, toRfc3339, type AutonomyStateFile, type PersistedKeepalive } from "./state_file.ts";


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
}

export interface AutonomyActionResult {
  readonly turnCount?: number | undefined;
  readonly events: readonly { kind: WakeEventKind; detail: string; at?: number }[];
  readonly failed?: string | undefined;
  readonly deepArchiveDone?: boolean | undefined;
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
  readonly thread: string;
}

export interface WakeRun {
  readonly thread: string;
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
}

export interface AutonomyExecutor {
  homeThread(character: string): string;
  onHold?(character: string, thread: string | undefined): boolean;
  runWake(character: string, wake: WakeRun, hooks: WakeHooks): Promise<WakeResult>;
  runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult>;
  runDeepArchive(character: string): Promise<AutonomyActionResult>;
  openSeals?(character: string, now: number): Promise<OpenedSeal[]>;
}

interface RunnerState {
  dirty: boolean;
  lastActivityAt: number;
  compactionTriggered: boolean;
  deepArchiveDone: boolean;
  activeTurnCount: number;
  keepalive: PersistedKeepalive | undefined;
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
  readonly #log: WakeLog;
  readonly #activity = new ActivityTracker();
  readonly #now: () => number;
  #state: RunnerState;
  #wakeRunning: LiveWake | undefined;
  readonly #fired: TriggerFiring[] = [];
  readonly #userActiveAt = new Map<string, number>();
  readonly #events: AutonomyEvents | undefined;
  #resting: boolean;

  constructor(opts: {
    character: string;
    config: AutonomyRunnerConfig;
    executor: AutonomyExecutor;
    statePath: string;
    dormancy: Dormancy;
    log: WakeLog;
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
      keepalive: restored?.keepalive,
    };
  }

  get dormancy(): Dormancy {
    return this.#dormancy;
  }

  get log(): WakeLog {
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
    this.#state.dirty = true;
  }

  onUserActivityElsewhere(now: number): void {
    if (this.#dormancy.wakesWithoutUser > 0) {
      this.note("wake", "User active in another thread — idle counter reset", now);
    }
    this.#dormancy.onUserMessage(now);
    this.#tellWakeUserWrote(now);
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
    if (running !== undefined && this.#threadOf(firing) === running.thread && firing.from === undefined) {
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

  #threadOf(firing: TriggerFiring): string {
    return firing.thread ?? this.#executor.homeThread(this.#character);
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
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = now;
  }

  onCompactionFailed(now: number): void {
    this.#state.compactionTriggered = false;
    this.#state.lastActivityAt = now;
  }

  setConfig(config: AutonomyRunnerConfig): void {
    this.#config = config;
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

  note(kind: WakeEventKind, detail: string, now: number): void {
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
    const now = this.#now();
    const decided = tickDecision(this.inputs(now));
    const decision = foreground ? { ...decided, compaction: undefined, deepArchive: false } : decided;

    for (const opened of await this.#executor.openSeals?.(this.#character, now) ?? []) {
      this.#queue({ name: "", reason: opened.reason, at: now, thread: opened.thread, seal: true });
    }

    const resting = this.#dormancy.isDormant(now);
    if (resting && !this.#resting) this.note("dormant", `Went dormant (wakes without the user: ${String(this.#dormancy.wakesWithoutUser)})`, now);
    this.#resting = resting;
    const due = this.#fired.splice(0).filter((firing) => this.wakesMayRun && (firing.seal === true || !resting));
    try {
      for (const thread of new Set(due.map((firing) => this.#threadOf(firing)))) {
        const here = due.filter((firing) => this.#threadOf(firing) === thread);
        const started = this.#now();
        const lastActive = (): number => this.#userActiveAt.get(thread) ?? Number.NEGATIVE_INFINITY;
        const byHand = here.some((firing) => firing.byHand === true && firing.interruptedAt === undefined);
        if (!byHand && started - lastActive() < WAKE_QUIET_MS) {
          for (const firing of here) this.#queue(firing);
          continue;
        }
        this.note("tick_fired", `Woken in "${thread}" by ${firedBy(here)}`, started);
        const limitMs = Math.max(...here.map((firing) => firing.limitMs ?? DEFAULT_WAKE_LIMIT_MS));
        await this.#wake({ startedAt: started, thread, news: [], firings: [...here], userTold: false }, async (hooks) =>
          await this.#executor.runWake(this.#character, { thread, fired: here, limitMs, interrupted: () => lastActive() >= started }, hooks));
      }

      if (decision.compaction !== undefined) {
        this.#applyCompaction(
          await this.#executor.runCompaction(this.#character, decision.compaction),
        );
      }

      if (decision.deepArchive && this.#stillIdleEnoughToArchive()) {
        const result = await this.#executor.runDeepArchive(this.#character);
        this.#applyCompaction(result);
        if (result.deepArchiveDone ?? result.failed === undefined) {
          this.#state.deepArchiveDone = true;
        }
      }
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
    if (result.failed === undefined && result.turnCount !== undefined) this.onCompactionComplete(result.turnCount, now);
    else this.onCompactionFailed(now);
  }

  #stillIdleEnoughToArchive(): boolean {
    const i = this.inputs(this.#now());
    return i.archiveAfterSecs > 0 && !i.deepArchiveDone && i.idleSecs >= i.archiveAfterSecs;
  }

  snapshot(): AutonomyStateFile {
    return {
      ...this.#dormancy.snapshot(),
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
    await this.persist();
  }
}
