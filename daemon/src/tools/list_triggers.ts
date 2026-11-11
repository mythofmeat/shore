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

function described(each: TriggerView, userName: string, timeZone: string): string {
  const { trigger } = each;
  const arrives = trigger.when.kind === "event" && trigger.when.event === "user_back";
  const does = arrives ? `arrives with ${userName}'s message` : trigger.wakes ? "wakes you" : "leaves a diary entry";
  const parts = [
    whenPhrase(trigger.when, userName, timeZone),
    ...(trigger.check === undefined ? [] : [`if \`${trigger.check}\` prints`]),
    does,
    ...(trigger.reason === undefined ? [] : [`"${trigger.reason}"`]),
    ...(trigger.between === undefined ? [] : [`only ${clock(trigger.between.startMinute)}-${clock(trigger.between.endMinute)}`]),
    ...(trigger.cooldownMs === 0 ? [] : [`at most every ${length(trigger.cooldownMs)}`]),
  ];
  const status = [
    ...(each.nextAt === undefined ? [] : [`next ${formatWallClock(each.nextAt, timeZone)}`]),
    each.lastFiredAt === undefined ? "never fired" : `fired ${String(each.fired)} ${each.fired === 1 ? "time" : "times"}, last ${formatWallClock(each.lastFiredAt, timeZone)}`,
    ...(each.off ? [`switched off by ${userName}`] : []),
    ...(each.failing ? ["its check is failing"] : []),
  ];
  return `${trigger.name}: ${parts.join(", ")}\n  ${status.join(" · ")}`;
}

export function handleListTriggers(view: TriggersView | undefined, userName: string, timeZone: string = hostZone()): string {
  if (view === undefined) throw new ToolIoError("triggers are not available in this context");
  const where = `Your triggers, from ${TRIGGERS_FILE} in your workspace root.`;
  return [
    view.enabled ? where : `${where} ${userName} hasn't turned triggers on, so none of them run.`,
    ...(view.triggers.length === 0 && view.problems.length === 0 ? ["You have none yet."] : []),
    ...view.triggers.map((each) => described(each, userName, timeZone)),
    ...(view.problems.length === 0 ? [] : [`Not running:\n${view.problems.map((problem) => `- ${problem}`).join("\n")}`]),
  ].join("\n\n");
}
