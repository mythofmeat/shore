import { shoreLog } from "../log.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { TriggerFiring } from "./runner.ts";
import type { CheckOutcome } from "./trigger_check.ts";
import { coolingDown, inItsHours, nextFiring, parseTriggers, scheduledAt, triggerTimes, TRIGGERS_FILE, type ParsedTriggers, type Trigger } from "./triggers.ts";
import type { Texts } from "../texts/texts.ts";

const TRIGGER_STATE = "triggers.json";

export interface TriggerRecord {
  since: number;
  fired: number;
  lastFiredAt?: number;
  quietFor?: number;
  checkedAt?: number;
  problem?: string;
  pending?: true;
  statusesSeen?: string[];
}

interface TriggerState {
  records: Record<string, TriggerRecord>;
}

export interface TriggerSettings {
  enabled: boolean;
  checks: boolean;
  wakeCooldownMs: number;
  checkLimitMs: number;
  maxWakeLimitMs: number;
  off: readonly string[];
}

export interface TriggerLoopDeps {
  characterDir: string;
  timeZone: string;
  now(): number;
  settings(): TriggerSettings;
  dormant(): boolean;
  lastUserAt(): number | undefined;
  statuses(): string[];
  readFile(): Promise<string | undefined>;
  texts(): Texts;
  runCheck(trigger: Trigger, limitMs: number, statusesSeen: readonly string[] | undefined): Promise<CheckOutcome>;
  wake(firing: TriggerFiring): void;
}

export interface TriggerView {
  trigger: Trigger;
  off: boolean;
  problem: string | undefined;
  fired: number;
  lastFiredAt: number | undefined;
  checkedAt: number | undefined;
  nextAt: number | undefined;
}

export interface TriggersView {
  enabled: boolean;
  triggers: TriggerView[];
  problems: string[];
  asked: readonly TriggerFiring[];
}

function record(raw: unknown): TriggerRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { since, fired, lastFiredAt, quietFor, checkedAt, problem, pending, statusesSeen } = raw as Record<string, unknown>;
  if (typeof since !== "number" || typeof fired !== "number") return undefined;
  return {
    since,
    fired,
    ...(typeof lastFiredAt === "number" ? { lastFiredAt } : {}),
    ...(typeof quietFor === "number" ? { quietFor } : {}),
    ...(typeof checkedAt === "number" ? { checkedAt } : {}),
    ...(typeof problem === "string" ? { problem } : {}),
    ...(pending === true ? { pending } : {}),
    ...(Array.isArray(statusesSeen) ? { statusesSeen: statusesSeen.filter((name) => typeof name === "string") } : {}),
  };
}

export function wokenWithoutCheckNote(problem: string): string {
  return `Shore couldn't tell from this one-off's check whether to wake you, because the check failed: ${problem}. A one-off gets no second try, so you are woken anyway.`;
}

function eventOf(trigger: Trigger): string | undefined {
  return trigger.when.kind === "event" ? trigger.when.event : undefined;
}

function dueAt(trigger: Trigger, known: TriggerRecord | undefined, lastUserAt: number | undefined, timeZone: string): number | undefined {
  const { when } = trigger;
  if (when.kind !== "event") return known === undefined ? undefined : scheduledAt(when, known.since, timeZone);
  return when.event === "user_quiet" && lastUserAt !== undefined && known?.quietFor !== lastUserAt ? lastUserAt + when.afterMs : undefined;
}

export class CharacterTriggers {
  readonly #deps: TriggerLoopDeps;
  #parsed: ParsedTriggers = { triggers: [], problems: [] };
  #turn: Promise<void> = Promise.resolve();

  constructor(deps: TriggerLoopDeps) {
    this.#deps = deps;
  }

  async tick(): Promise<void> {
    await this.#inTurn(async () => {
      const settings = this.#deps.settings();
      if (!settings.enabled) return;
      const resting = this.#deps.dormant();
      await this.#load(settings);
      const state = this.#state();
      const running = new Set(this.#parsed.triggers.map((trigger) => trigger.name));
      state.records = Object.fromEntries(Object.entries(state.records).filter(([name]) => running.has(name)));
      for (const trigger of this.#parsed.triggers) {
        if (settings.off.includes(trigger.name)) continue;
        const now = this.#deps.now();
        const watching = eventOf(trigger) === "status_changed";
        const found = state.records[trigger.name] ?? { since: now, fired: 0 };
        const known = watching && found.statusesSeen === undefined ? { ...found, statusesSeen: this.#deps.statuses() } : found;
        state.records[trigger.name] = known;
        if (!this.#due(trigger, known, now) || coolingDown(trigger.cooldownMs, known.lastFiredAt, now)) continue;
        const last = this.#deps.lastUserAt();
        const { pending: _was, quietFor: _before, statusesSeen, ...kept } = known;
        const next: TriggerRecord = { ...kept, since: now, ...(last === undefined ? {} : { quietFor: last }), ...(watching ? { statusesSeen: this.#deps.statuses() } : {}) };
        state.records[trigger.name] = next;
        if (!resting && inItsHours(trigger.between, now, this.#deps.timeZone)) await this.#run(trigger, next, settings, state, statusesSeen);
      }
      this.#save(state);
    });
  }

  async finished(names: readonly string[]): Promise<void> {
    await this.#happened((trigger) => trigger.when.kind === "follows" && names.includes(trigger.when.trigger));
  }

  async statusChanged(): Promise<void> {
    await this.#happened((trigger) => eventOf(trigger) === "status_changed");
  }

  async #happened(follows: (trigger: Trigger) => boolean): Promise<void> {
    await this.#inTurn(async () => {
      const settings = this.#deps.settings();
      if (!settings.enabled) return;
      await this.#load(settings);
      const state = this.#state();
      this.#letFollow(state, follows);
      this.#save(state);
    });
  }

  async view(): Promise<Omit<TriggersView, "asked">> {
    const settings = this.#deps.settings();
    await this.#load(settings);
    const state = this.#state();
    const lastUserAt = this.#deps.lastUserAt();
    return {
      enabled: settings.enabled,
      problems: this.#parsed.problems,
      triggers: this.#parsed.triggers.map((trigger) => {
        const known = state.records[trigger.name];
        const due = dueAt(trigger, known, lastUserAt, this.#deps.timeZone);
        const cooled = known?.lastFiredAt === undefined ? undefined : known.lastFiredAt + trigger.cooldownMs;
        return {
          trigger,
          off: settings.off.includes(trigger.name),
          problem: known?.problem,
          fired: known?.fired ?? 0,
          lastFiredAt: known?.lastFiredAt,
          checkedAt: known?.checkedAt,
          nextAt: due === undefined ? undefined : nextFiring(trigger, Math.max(due, cooled ?? due), this.#deps.timeZone),
        };
      }),
    };
  }

  async times(): Promise<ReadonlyMap<string, string> | undefined> {
    try {
      return triggerTimes(await this.#deps.readFile() ?? "");
    } catch (error) {
      shoreLog.warn(`shore: could not read ${TRIGGERS_FILE} at ${this.#deps.characterDir}: ${String(error)}`);
      return undefined;
    }
  }

  async #inTurn(work: () => Promise<void>): Promise<void> {
    const turn = this.#turn.then(work);
    this.#turn = turn.catch((error: unknown) => {
      shoreLog.error(`shore: triggers at ${this.#deps.characterDir} failed: ${String(error)}`);
    });
    await this.#turn;
  }

  async #load(settings: TriggerSettings): Promise<void> {
    let content: string | undefined;
    try {
      content = await this.#deps.readFile();
    } catch (error) {
      shoreLog.warn(`shore: could not read ${TRIGGERS_FILE} at ${this.#deps.characterDir}: ${String(error)}`);
      return;
    }
    this.#parsed = parseTriggers(this.#deps.texts(), content ?? "", settings.wakeCooldownMs, settings.checks);
  }

  #state(): TriggerState {
    try {
      const parsed = JSON.parse(readCharacterState(this.#deps.characterDir, TRIGGER_STATE) ?? "{}") as Record<string, unknown>;
      const records = Object.entries((parsed["records"] ?? {}) as Record<string, unknown>).flatMap(([name, raw]) => {
        const known = record(raw);
        return known === undefined ? [] : [[name, known] as const];
      });
      return { records: Object.fromEntries(records) };
    } catch (error) {
      shoreLog.error(`shore: could not read trigger state at ${this.#deps.characterDir}: ${String(error)}`);
      return { records: {} };
    }
  }

  #save(state: TriggerState): void {
    writeCharacterState(this.#deps.characterDir, TRIGGER_STATE, JSON.stringify(state));
  }

  #due(trigger: Trigger, known: TriggerRecord, now: number): boolean {
    if (trigger.when.kind === "event" && trigger.when.event === "user_quiet") {
      const last = this.#deps.lastUserAt();
      return last !== undefined && now - last >= trigger.when.afterMs && known.quietFor !== last;
    }
    const at = scheduledAt(trigger.when, known.since, this.#deps.timeZone);
    return at === undefined ? known.pending === true : now >= at;
  }

  async #run(trigger: Trigger, known: TriggerRecord, settings: TriggerSettings, state: TriggerState, statusesSeen: readonly string[] | undefined): Promise<void> {
    const outcome: CheckOutcome = trigger.check === undefined ? { kind: "fired", output: "" } : await this.#deps.runCheck(trigger, settings.checkLimitMs, statusesSeen);
    const now = this.#deps.now();
    const { problem: _before, ...before } = known;
    const sound: TriggerRecord = trigger.check === undefined ? before : { ...before, checkedAt: now };
    const oneOff = trigger.when.kind === "once";
    if (outcome.kind === "failed" && !(oneOff && trigger.wakes)) {
      state.records[trigger.name] = { ...sound, problem: outcome.problem };
      return;
    }
    state.records[trigger.name] = sound;
    if (outcome.kind === "quiet") return;
    const said = outcome.kind === "failed" ? wokenWithoutCheckNote(outcome.problem) : outcome.output;
    const reason = [trigger.reason ?? "", said].filter((part) => part !== "").join("\n");
    state.records[trigger.name] = { ...sound, ...(outcome.kind === "failed" ? { problem: outcome.problem } : {}), fired: sound.fired + 1, lastFiredAt: now };
    if (trigger.wakes) {
      this.#deps.wake({
        name: trigger.name, reason, at: now,
        ...(trigger.thread === undefined ? {} : { thread: trigger.thread }),
        ...(trigger.limitMs === undefined ? {} : { limitMs: Math.min(trigger.limitMs, settings.maxWakeLimitMs) }),
      });
      return;
    }
    this.#letFollow(state, (follower) => follower.when.kind === "follows" && follower.when.trigger === trigger.name);
  }

  #letFollow(state: TriggerState, follows: (trigger: Trigger) => boolean): void {
    const now = this.#deps.now();
    for (const follower of this.#parsed.triggers.filter(follows)) {
      state.records[follower.name] = { ...(state.records[follower.name] ?? { since: now, fired: 0 }), pending: true };
    }
  }
}
