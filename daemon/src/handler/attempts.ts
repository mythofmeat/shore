import regenerateTemplate from "../../prompts/engine/regenerate.md" with { type: "text" };

import { mergeToolLoopMessages } from "../engine/merge.ts";
import { marksOf, newAttemptId, replyOf, setMark, type AttemptAsked, type AttemptScope, type Mark } from "../engine/marks.ts";
import { renderTemplate } from "../engine/prompt.ts";
import type { Message } from "../engine/types.ts";
import type { WireMessage } from "../llm/types.ts";
import { required } from "../util/required.ts";
import type { RegenChoice } from "./router.ts";
import { CommandError } from "../commands/errors.ts";

export interface AttemptEngine {
  messagesAfterLastUserTurn(): readonly Message[];
  attemptOf(msgId: string, index: number): Promise<string>;
}

export interface AttemptPlan {
  attempt: string;
  asked: AttemptAsked;
  replaces?: string;
  note?: string;
}

export interface AttemptSettings {
  tags: readonly string[];
  user: string;
  now: string;
}

export class NothingToReplaceError extends CommandError {
  constructor() {
    super("invalid_request", "There's no reply here to give a reason about. Regenerate without one, or write to the character instead.");
  }
}

export class UnknownTagError extends CommandError {
  constructor(tag: string, tags: readonly string[]) {
    super("invalid_request", `${JSON.stringify(tag)} isn't one of your tags: ${tags.length === 0 ? "marks.tags in your config is empty" : `yours are ${tags.join(", ")}`}. Add it to marks.tags to use it.`);
  }
}

export function checkTags(tags: readonly string[], configured: readonly string[]): string[] {
  const unknown = tags.find((tag) => !configured.includes(tag));
  if (unknown !== undefined) throw new UnknownTagError(unknown, configured);
  return [...new Set(tags)];
}

export async function planAttempt(
  engine: AttemptEngine,
  scope: AttemptScope,
  choice: RegenChoice | undefined,
  settings: AttemptSettings,
): Promise<AttemptPlan> {
  const attempt = newAttemptId();
  const tail = mergeToolLoopMessages([...engine.messagesAfterLastUserTurn()]).findLast((message) => message.role === "assistant");
  if (choice?.kind === "with_reason" && tail === undefined) throw new NothingToReplaceError();
  if (choice === undefined || tail === undefined) return { attempt, asked: "first" };
  const reply = replyOf(tail);
  const shown = required(reply.attempts.find((candidate) => candidate.shown));
  const tags = choice.kind === "with_reason" ? checkTags(choice.tags, settings.tags) : [];
  const replaces = await engine.attemptOf(reply.msgId, shown.index);
  if (choice.kind === "reroll") return { attempt, asked: "reroll", replaces };
  if (choice.kind === "with_reason") setMark(scope, replaces, { kind: "dislike", reason: choice.reason, tags }, settings.now);
  const ids = reply.attempts.map((candidate) => candidate.shown ? replaces : candidate.attempt);
  const marks = marksOf(scope, ids.flatMap((id) => id ?? []));
  const attempts = reply.attempts.flatMap((candidate, index) => {
    if (candidate.text === "") return [];
    const id = ids[index];
    return [attemptBlock(candidate.index + 1, candidate.shown, candidate.text, id === undefined ? [] : marks.get(id) ?? [], settings.user)];
  });
  const why = choice.kind === "with_reason" ? reasonText(tags, choice.reason ?? null) : "";
  const texts = { reason: why, attempts: attempts.join("\n\n") };
  const note = renderTemplate(regenerateTemplate, new Map([
    ["user", settings.user],
    ["take", choice.kind === "another_take" ? "yes" : ""],
    ["reason", why === "" ? "" : "\uE000reason\uE000"],
    ["attempts", "\uE000attempts\uE000"],
  ])).trim().replace(/\uE000(reason|attempts)\uE000/g, (_marker, name: keyof typeof texts) => texts[name]);
  return { attempt, asked: choice.kind, replaces, note };
}

function attemptBlock(position: number, shown: boolean, text: string, marks: readonly Mark[], user: string): string {
  const head = `Attempt ${String(position)}${shown ? `, the one ${user} was looking at` : ""}:`;
  return [head, quoted(text), ...marks.map((mark) => markLine(mark, user))].join("\n");
}

function quoted(text: string): string {
  return text.split("\n").map((line) => line === "" ? ">" : `> ${line}`).join("\n");
}

function markLine(mark: Mark, user: string): string {
  const verb = mark.kind === "like" ? "liked" : "disliked";
  const what = mark.phrase === null ? "this attempt" : `the words "${mark.phrase}"`;
  const why = reasonText(mark.tags, mark.reason);
  return `${user} ${verb} ${what}${why === "" ? "." : `, because: ${why}`}`;
}

function reasonText(tags: readonly string[], reason: string | null): string {
  return [...tags, ...(reason === null ? [] : [reason])].join("; ");
}

export function withAttemptNote(messages: readonly WireMessage[], note: string | undefined): WireMessage[] {
  if (note === undefined) return [...messages];
  return [...messages, { role: "system", content: [{ type: "text", text: note }], attempt_only: true }];
}
