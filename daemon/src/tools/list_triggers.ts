import type { TriggerFiring } from "../autonomy/runner.ts";
import type { TriggersView, TriggerView } from "../autonomy/trigger_loop.ts";
import { TRIGGERS_FILE, type TriggerWhen } from "../autonomy/triggers.ts";
import { ConfigDuration } from "../config/duration.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { asNaive, hostZone, resolveInZone } from "../ledger/zoned.ts";
import { ToolIoError } from "./errors.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function length(ms: number): string {
  return ConfigDuration.fromMillis(ms).toString();
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export interface TriggerVoice {
  wakes: string;
  neverWakes: string;
  statusChanges: string;
  quietFor: string;
  switchedOff: string;
}

export function characterVoice(userName: string): TriggerVoice {
  return {
    wakes: "wakes you",
    neverWakes: "never wakes you",
    statusChanges: `when ${userName} turns a status on or off`,
    quietFor: `when ${userName} has been quiet for`,
    switchedOff: `switched off by ${userName}`,
  };
}

export function userVoice(character: string): TriggerVoice {
  return {
    wakes: `wakes ${character}`,
    neverWakes: `never wakes ${character}`,
    statusChanges: "when you turn a status on or off",
    quietFor: "when you have been quiet for",
    switchedOff: "switched off by you",
  };
}

function whenPhrase(when: TriggerWhen, voice: TriggerVoice, timeZone: string): string {
  if (when.kind === "every") return `every ${length(when.everyMs)}`;
  if (when.kind === "at") {
    const days = when.weekdays.length === DAYS.length ? "every day" : when.weekdays.map((day) => DAYS[day]).join(", ");
    return `${days} at ${clock(when.minute)}`;
  }
  if (when.kind === "once") return `once, ${formatWallClock(resolveInZone(asNaive(when.local), timeZone), timeZone)}`;
  if (when.kind === "follows") return `after \`${when.trigger}\``;
  if (when.event === "status_changed") return voice.statusChanges;
  return `${voice.quietFor} ${length(when.afterMs)}`;
}

function checkStatus(each: TriggerView, timeZone: string): string[] {
  if (each.trigger.check === undefined) return [];
  const at = each.checkedAt === undefined ? undefined : formatWallClock(each.checkedAt, timeZone);
  if (each.problem !== undefined) return [at === undefined ? `its check is failing: ${each.problem}` : `its check failed when last tried, ${at}: ${each.problem}`];
  if (at === undefined) return ["its check hasn't run yet"];
  return each.checkedAt === each.lastFiredAt ? [] : [`last checked ${at}, printed nothing`];
}

export interface DescribedTrigger {
  name: string;
  does: string;
  status: string;
}

export function describeTrigger(each: TriggerView, voice: TriggerVoice, timeZone: string): DescribedTrigger {
  const { trigger } = each;
  const where = trigger.thread === undefined ? voice.wakes : `${voice.wakes} in "${trigger.thread}"`;
  const parts = [
    whenPhrase(trigger.when, voice, timeZone),
    ...(trigger.check === undefined ? [] : [trigger.wakes ? `if \`${trigger.check}\` prints` : `runs \`${trigger.check}\``]),
    trigger.wakes ? where : voice.neverWakes,
    ...(trigger.reason === undefined ? [] : [`"${trigger.reason}"`]),
    ...(trigger.between === undefined ? [] : [`only ${clock(trigger.between.startMinute)}-${clock(trigger.between.endMinute)}`]),
    ...(trigger.limitMs === undefined ? [] : [`for up to ${length(trigger.limitMs)}`]),
    ...(trigger.cooldownMs === 0 ? [] : [`at most every ${length(trigger.cooldownMs)}`]),
  ];
  const status = [
    ...(each.nextAt === undefined ? [] : [`next ${formatWallClock(each.nextAt, timeZone)}`]),
    each.lastFiredAt === undefined ? "never fired" : `fired ${String(each.fired)} ${each.fired === 1 ? "time" : "times"}, last ${formatWallClock(each.lastFiredAt, timeZone)}`,
    ...(each.off ? [voice.switchedOff] : []),
    ...checkStatus(each, timeZone),
  ];
  return { name: trigger.name, does: parts.join(", "), status: status.join(" · ") };
}

export interface DescribedAsk {
  thread: string;
  does: string;
  status: string;
}

export function describeAsked(firing: TriggerFiring, timeZone: string): DescribedAsk {
  return {
    thread: firing.thread ?? "",
    does: `asked for from "${firing.from ?? ""}" at ${formatWallClock(firing.at, timeZone)}: ${firing.reason}`,
    status: firing.startsAt === undefined ? "starts as soon as it can" : `starts ${formatWallClock(firing.startsAt, timeZone)}`,
  };
}

export async function handleListTriggers(pending: Promise<TriggersView> | undefined, userName: string, timeZone: string = hostZone()): Promise<string> {
  const view = await pending;
  if (view === undefined) throw new ToolIoError("triggers are not available in this context");
  const where = `Your triggers, from ${TRIGGERS_FILE} in your workspace root.`;
  const voice = characterVoice(userName);
  return [
    view.enabled ? where : `${where} ${userName} has your triggers switched off, so nothing fires.`,
    ...(view.triggers.length === 0 && view.problems.length === 0 ? ["You have none there yet, so no trigger wakes you."] : []),
    ...view.triggers.map((each) => {
      const { name, does, status } = describeTrigger(each, voice, timeZone);
      return `${name}: ${does}\n  ${status}`;
    }),
    ...(view.problems.length === 0 ? [] : [`Not running:\n${view.problems.map((problem) => `- ${problem}`).join("\n")}`]),
    ...(view.asked.length === 0 ? [] : [`Wakes you asked for with \`wake_in_thread\` that haven't started:\n${view.asked.map((firing) => {
      const { thread, does, status } = describeAsked(firing, timeZone);
      return `"${thread}": ${does}\n  ${status}`;
    }).join("\n")}`]),
  ].join("\n\n");
}
