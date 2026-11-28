import type { TriggerFiring } from "../autonomy/runner.ts";
import type { TriggersView, TriggerView } from "../autonomy/trigger_loop.ts";
import { TRIGGERS_FILE, type TriggerWhen } from "../autonomy/triggers.ts";
import { ConfigDuration } from "../config/duration.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { asNaive, hostZone, resolveInZone } from "../ledger/zoned.ts";
import { ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function length(ms: number): string {
  return ConfigDuration.fromMillis(ms).toString();
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export interface TriggerVoice {
  wakes: (thread: string | undefined) => string;
  neverWakes: string;
  statusChanges: string;
  quietFor: (length: string) => string;
  switchedOff: string;
}

export function characterVoice(texts: Texts, userName: string): TriggerVoice {
  return {
    wakes: (thread) => texts.render("triggers_wakes", { thread }) ?? "",
    neverWakes: texts.render("triggers_never_wakes") ?? "",
    statusChanges: texts.render("triggers_status_changes", { user: userName }) ?? "",
    quietFor: (span) => texts.render("triggers_quiet_for", { user: userName, length: span }) ?? "",
    switchedOff: texts.render("triggers_switched_off", { user: userName }) ?? "",
  };
}

export function userVoice(character: string): TriggerVoice {
  return {
    wakes: (thread) => thread === undefined ? `wakes ${character}` : `wakes ${character} in "${thread}"`,
    neverWakes: `never wakes ${character}`,
    statusChanges: "when you turn a status on or off",
    quietFor: (span) => `when you have been quiet for ${span}`,
    switchedOff: "switched off by you",
  };
}

function whenPhrase(texts: Texts, when: TriggerWhen, voice: TriggerVoice, timeZone: string): string | undefined {
  if (when.kind === "every") return texts.render("triggers_every", { length: length(when.everyMs) });
  if (when.kind === "at") {
    return texts.render("triggers_at", { every_day: when.weekdays.length === DAYS.length ? "yes" : undefined, days: when.weekdays.map((day) => DAYS[day]).join(", "), time: clock(when.minute) });
  }
  if (when.kind === "once") return texts.render("triggers_once", { at: formatWallClock(resolveInZone(asNaive(when.local), timeZone), timeZone) });
  if (when.kind === "follows") return texts.render("triggers_follows", { trigger: when.trigger });
  if (when.event === "status_changed") return voice.statusChanges;
  return voice.quietFor(length(when.afterMs));
}

function checkStatus(texts: Texts, each: TriggerView, timeZone: string): (string | undefined)[] {
  if (each.trigger.check === undefined) return [];
  const at = each.checkedAt === undefined ? undefined : formatWallClock(each.checkedAt, timeZone);
  if (each.problem !== undefined) return [texts.render("triggers_check_failing", { at, problem: each.problem })];
  if (at === undefined) return [texts.render("triggers_check_not_run")];
  return each.checkedAt === each.lastFiredAt ? [] : [texts.render("triggers_checked_quiet", { at })];
}

export type DescribedTrigger = {
  name: string;
  does: string;
  status: string;
};

function joined(parts: readonly (string | undefined)[], between: string): string {
  return parts.filter((part) => part !== undefined && part !== "").join(between);
}

export function describeTrigger(texts: Texts, each: TriggerView, voice: TriggerVoice, timeZone: string): DescribedTrigger {
  const { trigger } = each;
  const parts = [
    whenPhrase(texts, trigger.when, voice, timeZone),
    trigger.check === undefined ? undefined : texts.render(trigger.wakes ? "triggers_if_prints" : "triggers_runs", { check: trigger.check }),
    trigger.wakes ? voice.wakes(trigger.thread) : voice.neverWakes,
    trigger.reason === undefined ? undefined : texts.render("triggers_reason", { reason: trigger.reason }),
    trigger.between === undefined ? undefined : texts.render("triggers_between", { from: clock(trigger.between.startMinute), to: clock(trigger.between.endMinute) }),
    trigger.limitMs === undefined ? undefined : texts.render("triggers_limit", { length: length(trigger.limitMs) }),
    trigger.cooldownMs === 0 ? undefined : texts.render("triggers_cooldown", { length: length(trigger.cooldownMs) }),
  ];
  const status = [
    each.nextAt === undefined ? undefined : texts.render("triggers_next", { at: formatWallClock(each.nextAt, timeZone) }),
    each.lastFiredAt === undefined
      ? texts.render("triggers_never_fired")
      : texts.render("triggers_fired", { count: String(each.fired), one: each.fired === 1 ? "yes" : undefined, at: formatWallClock(each.lastFiredAt, timeZone) }),
    each.off ? voice.switchedOff : undefined,
    ...checkStatus(texts, each, timeZone),
  ];
  return { name: trigger.name, does: joined(parts, ", "), status: joined(status, " · ") };
}

export type DescribedAsk = {
  thread: string;
  does: string;
  status: string;
};

export function describeAsked(texts: Texts, firing: TriggerFiring, timeZone: string): DescribedAsk {
  return {
    thread: firing.thread ?? "",
    does: texts.render("wake_asked_for", { from: firing.from ?? "", at: formatWallClock(firing.at, timeZone), reason: firing.reason }) ?? "",
    status: texts.render("triggers_starts", { at: firing.startsAt === undefined ? undefined : formatWallClock(firing.startsAt, timeZone) }) ?? "",
  };
}

export async function handleListTriggers(texts: Texts, pending: Promise<TriggersView> | undefined, userName: string, timeZone: string = hostZone()): Promise<string> {
  const view = await pending;
  if (view === undefined) throw new ToolIoError(texts.always("triggers_unavailable"));
  const voice = characterVoice(texts, userName);
  return joined([
    texts.render("triggers_heading", { file: TRIGGERS_FILE, off: view.enabled ? undefined : "yes", user: userName }),
    view.triggers.length === 0 && view.problems.length === 0 ? texts.render("triggers_none") : undefined,
    ...view.triggers.map((each) => texts.render("triggers_entry", describeTrigger(texts, each, voice, timeZone))),
    view.problems.length === 0 ? undefined : texts.render("triggers_problems", { problems: view.problems.map((problem) => `- ${problem}`).join("\n") }),
    view.asked.length === 0 ? undefined : texts.render("triggers_asked", {
      asked: joined(view.asked.map((firing) => texts.render("triggers_asked_entry", describeAsked(texts, firing, timeZone))), "\n"),
    }),
  ], "\n\n");
}
