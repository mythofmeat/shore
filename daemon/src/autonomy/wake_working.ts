import { isToolResultOnly } from "../engine/message_store.ts";
import { isWakeOpener } from "../engine/threads.ts";
import type { Message } from "../engine/types.ts";
import { required } from "../util/required.ts";
import { DIARY_NOTE_CHARS } from "./diary.ts";

function startsTurn(message: Message): boolean {
  return message.role === "user" && !isToolResultOnly(message);
}

function isRound(message: Message): boolean {
  return message.role === "assistant" ? message.origin !== "autonomous" : isToolResultOnly(message);
}

function toolCalls(message: Message): string[] {
  return message.content_blocks.flatMap((block) => block.type === "tool_use" ? [block.name] : []);
}

function words(message: Message): string {
  return message.content_blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
}

function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length > DIARY_NOTE_CHARS ? `${chars.slice(0, DIARY_NOTE_CHARS).join("")}… [cut]` : text;
}

function callCount(calls: readonly string[]): string {
  return calls.length === 1 ? "1 tool call" : `${String(calls.length)} tool calls`;
}

function workingNote(working: readonly Message[], closed: boolean, where = "isn't shown here"): string {
  const calls = working.flatMap(toolCalls);
  const count = callCount(calls);
  if (closed) return `[Your working in this wake ${where}: ${count}. Your note from the end of it follows.]`;
  const lastCall = calls.at(-1);
  const lastWords = working.filter((message) => message.role === "assistant").map(words).findLast((text) => text !== "");
  return `[Your working in this wake ${where}: ${count}${lastCall === undefined ? "" : `, ending with \`${lastCall}\``}. ` +
    `It ended without a note from you.${lastWords === undefined ? "" : ` The last thing you wrote in it: "${cut(lastWords)}"`}]`;
}

function standIn(working: readonly Message[], closed: boolean): Message[] {
  const last = working.at(-1);
  if (last === undefined) return [];
  const text = workingNote(working, closed);
  return [{
    msg_id: last.msg_id,
    role: "system",
    origin: "autonomous",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: last.timestamp,
  }];
}

function wordsOnly(note: Message): Message {
  return { ...note, content_blocks: note.content_blocks.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking") };
}

function seenLater(message: Message): Message {
  const text = message.shown_later;
  return text === undefined ? message : { ...message, content: text, content_blocks: [{ type: "text", text }] };
}

function keptElsewhere(message: Message): Message[] {
  const note = message.wake_note;
  if (note === undefined) return [seenLater(message)];
  return [seenLater(message), { msg_id: message.msg_id, role: "assistant", content: note, images: [], content_blocks: [{ type: "text", text: note }], timestamp: message.timestamp }];
}

function wakeSeenLater(wake: readonly Message[]): Message[] {
  const first = wake.findIndex(isRound);
  const last = wake.findLastIndex(isRound);
  const final = wake[last];
  if (final === undefined) return [required(wake[0]), ...wake.slice(1).flatMap(keptElsewhere)];
  const closing = final.role === "assistant" && toolCalls(final).length === 0 ? final : undefined;
  const working = wake.slice(first, closing === undefined ? last + 1 : last);
  return [
    seenLater(required(wake[0])),
    ...wake.slice(1, first),
    ...standIn(working, closing !== undefined && words(closing) !== ""),
    ...(closing === undefined ? [] : [wordsOnly(closing)]),
    ...wake.slice(last + 1),
  ];
}

export function withoutWakeWorking(messages: readonly Message[]): Message[] {
  const turns: Message[][] = [];
  for (const message of messages) {
    const turn = turns.at(-1);
    if (turn === undefined || startsTurn(message)) turns.push([message]);
    else turn.push(message);
  }
  return turns.flatMap((turn) => isWakeOpener(required(turn[0])) ? wakeSeenLater(turn) : turn);
}

export interface KeptWorking {
  id: string;
  label: string;
}

export function keptWorkingSummary(working: readonly Message[], kept: KeptWorking, note: string | undefined, at: Pick<Message, "msg_id" | "timestamp">): Message | undefined {
  if (!working.some((message) => message.role === "assistant")) return undefined;
  const later = workingNote(working, note !== undefined, `is in your thread "${kept.id}", not here`);
  const shown = `This wake's working is in "${kept.label}": ${callCount(working.flatMap(toolCalls))}.`;
  return {
    msg_id: at.msg_id,
    role: "system",
    origin: "autonomous",
    content: shown,
    images: [],
    content_blocks: [{ type: "text", text: shown }],
    timestamp: at.timestamp,
    shown_later: later,
    ...(note === undefined ? {} : { wake_note: note }),
  };
}
