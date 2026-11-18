import { isToolResultOnly } from "../engine/message_store.ts";
import { isWakeOpener } from "../engine/threads.ts";
import type { Message } from "../engine/types.ts";
import { required } from "../util/required.ts";
import { cutLastWords } from "./wake_record.ts";

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

function callCount(calls: readonly string[]): string {
  return calls.length === 1 ? "1 tool call" : `${String(calls.length)} tool calls`;
}

function workingNote(working: readonly Message[], where = "isn't shown here"): string {
  const calls = working.flatMap(toolCalls);
  const count = callCount(calls);
  const final = working.at(-1);
  if (final?.role === "assistant" && toolCalls(final).length === 0) return `[Your working in this wake ${where}: ${count}.]`;
  const lastCall = calls.at(-1);
  const lastWords = working.filter((message) => message.role === "assistant").map(words).findLast((text) => text !== "");
  return `[Your working in this wake ${where}: ${count}${lastCall === undefined ? "" : `, ending with \`${lastCall}\``}. ` +
    `It ended before you had finished.${lastWords === undefined ? "" : ` The last thing you wrote in it: "${cutLastWords(lastWords)}"`}]`;
}

function standIn(working: readonly Message[]): Message[] {
  const last = working.at(-1);
  if (last === undefined) return [];
  const text = workingNote(working);
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

function seenLater(message: Message): Message {
  const text = message.shown_later;
  return text === undefined ? message : { ...message, content: text, content_blocks: [{ type: "text", text }] };
}

function wakeSeenLater(wake: readonly Message[]): Message[] {
  const first = wake.findIndex(isRound);
  const last = wake.findLastIndex(isRound);
  if (last === -1) return [required(wake[0]), ...wake.slice(1).map(seenLater)];
  return [
    seenLater(required(wake[0])),
    ...wake.slice(1, first),
    ...standIn(wake.slice(first, last + 1)),
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

export function keptWorkingSummary(working: readonly Message[], kept: KeptWorking, at: Pick<Message, "msg_id" | "timestamp">): Message | undefined {
  if (!working.some((message) => message.role === "assistant")) return undefined;
  const later = workingNote(working, `is in your thread "${kept.id}", not here`);
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
  };
}
