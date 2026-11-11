import { shoreLog } from "../log.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import { addDiaryNote } from "./diary.ts";
import type { TriggerFiring } from "./runner.ts";
import type { CheckOutcome } from "./trigger_check.ts";
import { coolingDown, inItsHours, parseTriggers, scheduledAt, TRIGGERS_FILE, type ParsedTriggers, type Trigger } from "./triggers.ts";

const TRIGGER_STATE = "triggers.json";

export const ARRIVAL_CHECK_LIMIT_MS = 10_000;

export function arrivalCheckLimitMs(checkLimitMs: number): number {
  return Math.min(checkLimitMs, ARRIVAL_CHECK_LIMIT_MS);
}

export interface TriggerRecord {
  since: number;
  fired: number;
  lastFiredAt?: number;
  quietFor?: number;
  checkedAt?: number;
  failing?: true;
  pending?: true;
}

interface TriggerState {
  records: Record<string, TriggerRecord>;
  problems: string[];
}

export interface TriggerSettings {
  enabled: boolean;
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
  readFile(): Promise<string | undefined>;
  runCheck(trigger: Trigger, limitMs: number): Promise<CheckOutcome>;
  wake(firing: TriggerFiring): void;
}

export interface TriggerView {
  trigger: Trigger;
  off: boolean;
  failing: boolean;
  fired: number;
  lastFiredAt: number | undefined;
  checkedAt: number | undefined;
  nextAt: number | undefined;
}

export interface TriggersView {
  enabled: boolean;
  triggers: TriggerView[];
  problems: string[];
}

function record(raw: unknown): TriggerRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { since, fired, lastFiredAt, quietFor, checkedAt, failing, pending } = raw as Record<string, unknown>;
  if (typeof since !== "number" || typeof fired !== "number") return undefined;
  return {
    since,
    fired,
    ...(typeof lastFiredAt === "number" ? { lastFiredAt } : {}),
    ...(typeof quietFor === "number" ? { quietFor } : {}),
    ...(typeof checkedAt === "number" ? { checkedAt } : {}),
    ...(failing === true ? { failing } : {}),
    ...(pending === true ? { pending } : {}),
  };
}

export function checkFailedNote(trigger: string, problem: string, oneOff: boolean): string {
  const failed = `The check for your trigger \`${trigger}\` failed: ${problem}.`;
  return oneOff
    ? `${failed} It is a one-off, which gets no second try, so nothing will come of it.`
    : `${failed} It keeps being tried, and you'll be told again only once it has worked and then failed again.`;
}

export function wokenWithoutCheckNote(problem: string): string {
  return `Shore couldn't tell from this one-off's check whether to wake you, because the check failed: ${problem}. A one-off gets no second try, so you are woken anyway.`;
}

function eventOf(trigger: Trigger): string | undefined {
  return trigger.when.kind === "event" ? trigger.when.event : undefined;
}

function arrives(trigger: Trigger): boolean {
  return eventOf(trigger) === "user_back";
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
      this.#reportProblems(state);
      const running = new Set(this.#parsed.triggers.map((trigger) => trigger.name));
      state.records = Object.fromEntries(Object.entries(state.records).filter(([name]) => running.has(name)));
      for (const trigger of this.#parsed.triggers) {
        if (settings.off.includes(trigger.name) || arrives(trigger)) continue;
        const now = this.#deps.now();
        const known = state.records[trigger.name] ?? { since: now, fired: 0 };
        state.records[trigger.name] = known;
        if (!this.#due(trigger, known, now) || coolingDown(trigger.cooldownMs, known.lastFiredAt, now)) continue;
        const last = this.#deps.lastUserAt();
        const { pending: _was, quietFor: _before, ...kept } = known;
        const next: TriggerRecord = { ...kept, since: now, ...(last === undefined ? {} : { quietFor: last }) };
        state.records[trigger.name] = next;
        if (!resting && inItsHours(trigger.between, now, this.#deps.timeZone)) await this.#run(trigger, next, settings, settings.checkLimitMs, state);
      }
      this.#save(state);
    });
  }

  async userBack(awayMs: number): Promise<void> {
    await this.#inTurn(async () => {
      const settings = this.#deps.settings();
      if (!settings.enabled) return;
      await this.#load(settings);
      const state = this.#state();
      for (const trigger of this.#parsed.triggers) {
        if (settings.off.includes(trigger.name) || !arrives(trigger)) continue;
        const now = this.#deps.now();
        const known = state.records[trigger.name] ?? { since: now, fired: 0 };
        if (trigger.when.kind !== "event" || awayMs < trigger.when.afterMs) continue;
        if (coolingDown(trigger.cooldownMs, known.lastFiredAt, now) || !inItsHours(trigger.between, now, this.#deps.timeZone)) continue;
        await this.#run(trigger, known, settings, arrivalCheckLimitMs(settings.checkLimitMs), state);
      }
      this.#save(state);
    });
  }

  async finished(names: readonly string[]): Promise<void> {
    await this.#happened((trigger) => trigger.when.kind === "follows" && names.includes(trigger.when.trigger));
  }

  async dreamDone(): Promise<void> {
    await this.#happened((trigger) => eventOf(trigger) === "dream_done");
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

  view(): TriggersView {
    const settings = this.#deps.settings();
    const state = this.#state();
    return {
      enabled: settings.enabled,
      problems: this.#parsed.problems,
      triggers: this.#parsed.triggers.map((trigger) => {
        const known = state.records[trigger.name];
        const scheduled = known === undefined ? undefined : scheduledAt(trigger.when, known.since, this.#deps.timeZone);
        const cooled = known?.lastFiredAt === undefined ? undefined : known.lastFiredAt + trigger.cooldownMs;
        return {
          trigger,
          off: settings.off.includes(trigger.name),
          failing: known?.failing === true,
          fired: known?.fired ?? 0,
          lastFiredAt: known?.lastFiredAt,
          checkedAt: known?.checkedAt,
          nextAt: scheduled === undefined ? undefined : Math.max(scheduled, cooled ?? scheduled),
        };
      }),
    };
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
    this.#parsed = parseTriggers(content ?? "", settings.wakeCooldownMs);
  }

  #state(): TriggerState {
    try {
      const parsed = JSON.parse(readCharacterState(this.#deps.characterDir, TRIGGER_STATE) ?? "{}") as Record<string, unknown>;
      const records = Object.entries((parsed["records"] ?? {}) as Record<string, unknown>).flatMap(([name, raw]) => {
        const known = record(raw);
        return known === undefined ? [] : [[name, known] as const];
      });
      const problems = Array.isArray(parsed["problems"]) ? parsed["problems"].filter((problem): problem is string => typeof problem === "string") : [];
      return { records: Object.fromEntries(records), problems };
    } catch (error) {
      shoreLog.error(`shore: could not read trigger state at ${this.#deps.characterDir}: ${String(error)}`);
      return { records: {}, problems: [] };
    }
  }

  #save(state: TriggerState): void {
    writeCharacterState(this.#deps.characterDir, TRIGGER_STATE, JSON.stringify(state));
  }

  #reportProblems(state: TriggerState): void {
    const problems = this.#parsed.problems;
    if (problems.join("\n") === state.problems.join("\n")) return;
    state.problems = [...problems];
    if (problems.length === 0) return;
    this.#tell(`These triggers in ${TRIGGERS_FILE} aren't running:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }

  #due(trigger: Trigger, known: TriggerRecord, now: number): boolean {
    if (trigger.when.kind === "event" && trigger.when.event === "user_quiet") {
      const last = this.#deps.lastUserAt();
      return last !== undefined && now - last >= trigger.when.afterMs && known.quietFor !== last;
    }
    const at = scheduledAt(trigger.when, known.since, this.#deps.timeZone);
    return at === undefined ? known.pending === true : now >= at;
  }

  async #run(trigger: Trigger, known: TriggerRecord, settings: TriggerSettings, limitMs: number, state: TriggerState): Promise<void> {
    const outcome: CheckOutcome = trigger.check === undefined ? { kind: "fired", output: "" } : await this.#deps.runCheck(trigger, limitMs);
    const now = this.#deps.now();
    const { failing: wasFailing, ...before } = known;
    const sound: TriggerRecord = trigger.check === undefined ? before : { ...before, checkedAt: now };
    const oneOff = trigger.when.kind === "once";
    if (outcome.kind === "failed" && !(oneOff && trigger.wakes)) {
      state.records[trigger.name] = { ...sound, failing: true };
      if (wasFailing !== true) this.#tell(checkFailedNote(trigger.name, outcome.problem, oneOff));
      return;
    }
    state.records[trigger.name] = sound;
    if (outcome.kind === "quiet") return;
    const said = outcome.kind === "failed" ? wokenWithoutCheckNote(outcome.problem) : outcome.output;
    const reason = [trigger.reason ?? "", said].filter((part) => part !== "").join("\n");
    state.records[trigger.name] = { ...sound, ...(outcome.kind === "failed" ? { failing: true as const } : {}), fired: sound.fired + 1, lastFiredAt: now };
    if (trigger.wakes) {
      this.#deps.wake({
        name: trigger.name, reason, at: now,
        ...(trigger.thread === undefined ? {} : { thread: trigger.thread }),
        ...(trigger.limitMs === undefined ? {} : { limitMs: Math.min(trigger.limitMs, settings.maxWakeLimitMs) }),
      });
      return;
    }
    addDiaryNote(this.#deps.characterDir, { at: now, thread: "", source: "trigger", trigger: trigger.name, text: reason });
    this.#letFollow(state, (follower) => follower.when.kind === "follows" && follower.when.trigger === trigger.name);
  }

  #letFollow(state: TriggerState, follows: (trigger: Trigger) => boolean): void {
    const now = this.#deps.now();
    for (const follower of this.#parsed.triggers.filter(follows)) {
      state.records[follower.name] = { ...(state.records[follower.name] ?? { since: now, fired: 0 }), pending: true };
    }
  }

  #tell(text: string): void {
    addDiaryNote(this.#deps.characterDir, { at: this.#deps.now(), thread: "", source: "shore", text });
  }
}
