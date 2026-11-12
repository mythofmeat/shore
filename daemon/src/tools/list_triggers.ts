import { HEARTBEAT_TRIGGER } from "../autonomy/own_time.ts";
import type { OwnTriggers, TriggersView, TriggerView } from "../autonomy/trigger_loop.ts";
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

function whenPhrase(when: TriggerWhen, userName: string, timeZone: string): string {
  if (when.kind === "every") return `every ${length(when.everyMs)}`;
  if (when.kind === "at") {
    const days = when.weekdays.length === DAYS.length ? "every day" : when.weekdays.map((day) => DAYS[day]).join(", ");
    return `${days} at ${clock(when.minute)}`;
  }
  if (when.kind === "once") return `once, ${formatWallClock(resolveInZone(asNaive(when.local), timeZone), timeZone)}`;
  if (when.kind === "follows") return `after \`${when.trigger}\``;
  if (when.event === "dream_done") return "after a dream";
  if (when.event === "status_changed") return `when ${userName} changes their status`;
  return when.event === "user_back"
    ? `when ${userName} comes back after ${length(when.afterMs)} away`
    : `when ${userName} has been quiet for ${length(when.afterMs)}`;
}

function checkStatus(each: TriggerView, timeZone: string): string[] {
  if (each.trigger.check === undefined) return [];
  const at = each.checkedAt === undefined ? undefined : formatWallClock(each.checkedAt, timeZone);
  if (each.failing) return [at === undefined ? "its check is failing" : `its check failed when last tried, ${at}`];
  if (at === undefined) return ["its check hasn't run yet"];
  return each.checkedAt === each.lastFiredAt ? [] : [`last checked ${at}, printed nothing`];
}

function described(each: TriggerView, userName: string, timeZone: string): string {
  const { trigger } = each;
  const arrives = trigger.when.kind === "event" && trigger.when.event === "user_back";
  const where = trigger.thread === undefined ? "wakes you" : `wakes you in "${trigger.thread}"`;
  const does = arrives ? `arrives with ${userName}'s message` : trigger.wakes ? where : "leaves a diary entry";
  const parts = [
    whenPhrase(trigger.when, userName, timeZone),
    ...(trigger.check === undefined ? [] : [`if \`${trigger.check}\` prints`]),
    does,
    ...(trigger.reason === undefined ? [] : [`"${trigger.reason}"`]),
    ...(trigger.between === undefined ? [] : [`only ${clock(trigger.between.startMinute)}-${clock(trigger.between.endMinute)}`]),
    ...(trigger.limitMs === undefined ? [] : [`for up to ${length(trigger.limitMs)}`]),
    ...(trigger.cooldownMs === 0 ? [] : [`at most every ${length(trigger.cooldownMs)}`]),
  ];
  const status = [
    ...(each.nextAt === undefined ? [] : [`next ${formatWallClock(each.nextAt, timeZone)}`]),
    each.lastFiredAt === undefined ? "never fired" : `fired ${String(each.fired)} ${each.fired === 1 ? "time" : "times"}, last ${formatWallClock(each.lastFiredAt, timeZone)}`,
    ...(each.off ? [`switched off by ${userName}`] : []),
    ...checkStatus(each, timeZone),
  ];
  return `${trigger.name}: ${parts.join(", ")}\n  ${status.join(" · ")}`;
}

function ownTriggers(own: OwnTriggers, userName: string, timeZone: string): string[] {
  const next = own.nextAt === undefined ? [] : [`\n  next ${formatWallClock(own.nextAt, timeZone)}`];
  const waits = own.asked === undefined ? next : ["\n  waiting behind the heartbeat you asked for"];
  const status = own.off ? [`\n  switched off by ${userName}`] : waits;
  const does = `${HEARTBEAT_TRIGGER}: ${length(own.everyMs)} after your last heartbeat, unless you have asked for one, wakes you`;
  const asked = own.asked === undefined ? [] : [`The heartbeat you asked for: ${own.asked.reason === "" ? "no reason given" : `"${own.asked.reason}"`}${next.join("")}`];
  return [`Shore's own trigger, which isn't in your file:\n${does}${status.join("")}`, ...asked];
}

export function handleListTriggers(view: TriggersView | undefined, userName: string, timeZone: string = hostZone()): string {
  if (view === undefined) throw new ToolIoError("triggers are not available in this context");
  const where = `Your triggers, from ${TRIGGERS_FILE} in your workspace root.`;
  return [
    view.enabled ? where : `${where} ${userName} has your own time switched off, so nothing fires.`,
    ...(view.triggers.length === 0 && view.problems.length === 0 ? ["You have none there yet."] : []),
    ...view.triggers.map((each) => described(each, userName, timeZone)),
    ...(view.problems.length === 0 ? [] : [`Not running:\n${view.problems.map((problem) => `- ${problem}`).join("\n")}`]),
    ...(view.own === undefined || !view.enabled ? [] : ownTriggers(view.own, userName, timeZone)),
  ].join("\n\n");
}
