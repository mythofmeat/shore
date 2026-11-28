import { formatWallClock } from "../engine/prompt.ts";
import type { TriggerFiring, WakeNews } from "./runner.ts";
import { Texts, type TextValues } from "../texts/texts.ts";

export type WireRole = "user" | "assistant" | "system";

export interface WireMessageLike {
  role: WireRole;
  content: { type: string; [key: string]: unknown }[];
}

export type ToolUse = readonly [string, string, unknown];

export function timeLeftText(texts: Texts, ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return texts.render("time_left", { minutes: minutes < 1 ? undefined : String(minutes), one: minutes === 1 ? "yes" : undefined }) ?? "";
}

export function timeLeftPhrase(ms: number): string {
  return timeLeftText(new Texts(), ms);
}

export function userWroteNote(texts: Texts, at: number, userName: string, timeZone: string): string | undefined {
  return texts.render("user_wrote", { user: userName, at: formatWallClock(texts, at, timeZone) });
}

function exactValues(secs: number): TextValues {
  const counted = (unit: string, count: number): TextValues => ({ seconds: undefined, minutes: undefined, hours: undefined, [unit]: String(count), one: count === 1 ? "yes" : undefined });
  if (secs < 60) return counted("seconds", secs);
  return secs % 3600 === 0 ? counted("hours", secs / 3600) : counted("minutes", Math.trunc(secs / 60));
}

export function spanPhrase(texts: Texts, ms: number): string {
  return texts.render("exact_length", exactValues(Math.trunc(ms / 1000))) ?? "";
}

export function triggerFiredNote(texts: Texts, firing: TriggerFiring, timeZone: string): string | undefined {
  const at = formatWallClock(texts, firing.at, timeZone);
  if (firing.byHand === true) return texts.render("fired_by_hand", { at });
  if (firing.seal === true) return texts.render("fired_seal", { at, reason: firing.reason });
  return firing.from === undefined
    ? texts.render("fired_trigger", { trigger: firing.name, at, reason: firing.reason })
    : texts.render("fired_asked", { from: firing.from, at, reason: firing.reason });
}

export function wakeNewsNote(texts: Texts, news: readonly WakeNews[], userName: string, timeZone: string): string | undefined {
  const notes = news.flatMap((item) => (item.kind === "trigger" ? triggerFiredNote(texts, item.firing, timeZone) : userWroteNote(texts, item.at, userName, timeZone)) ?? []);
  return notes.length === 0 ? undefined : notes.join("\n\n");
}

export function appendWrapUpNudge(messages: WireMessageLike[], text: string): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "user") {
    last.content.push({ type: "text", text });
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text }] });
}
