import { formatWallClock } from "../engine/prompt.ts";
import type { ContentBlock } from "../engine/types.ts";
import type { TriggerFiring, WakeNews } from "./runner.ts";

export type WireRole = "user" | "assistant" | "system";

export interface WireMessageLike {
  role: WireRole;
  content: { type: string; [key: string]: unknown }[];
}

function extractTag(content: string, startTag: string, endTag: string): string | undefined {
  let result: string | undefined;
  let searchFrom = 0;
  for (;;) {
    const startPos = content.indexOf(startTag, searchFrom);
    if (startPos === -1) break;
    const absStart = startPos + startTag.length;
    const endPos = content.indexOf(endTag, absStart);
    if (endPos === -1) break;
    const inner = content.slice(absStart, endPos).trim();
    if (inner.length > 0) result = inner;
    searchFrom = endPos + endTag.length;
  }
  return result;
}

export function extractSendMessage(content: string): string | undefined {
  return extractTag(content, "<sendMessage>", "</sendMessage>");
}

export function isSendMessageTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "sendmessage" || lower === "send_message";
}

export function extractToolSendMessage(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null) {
    for (const key of ["message", "text", "content", "body"] as const) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export type ToolUse = readonly [string, string, unknown];

export function captureToolSendMessage(toolUses: readonly ToolUse[]): string | undefined {
  let found: string | undefined;
  for (const [, name, input] of toolUses) {
    if (!isSendMessageTool(name)) continue;
    const text = extractToolSendMessage(input);
    if (text !== undefined) found = text;
  }
  return found;
}

export function sendMessageIn(blocks: readonly ContentBlock[]): string | undefined {
  const uses = blocks.flatMap((block): ToolUse[] => block.type === "tool_use" ? [[block.id, block.name, block.input]] : []);
  return captureToolSendMessage(uses) ?? extractSendMessage(deriveContentFromBlocks(blocks));
}

export function timeLeftPhrase(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "about a minute" : `about ${String(minutes)} minutes`;
}

export function userWroteNote(at: number, userName: string, timeZone: string): string {
  return `[${userName} has just written to you, at ${formatWallClock(at, timeZone)}, while this wake is running. ` +
    "Another turn of you is answering them, and it knows this wake is running.]";
}

export function spanPhrase(ms: number): string {
  const secs = Math.trunc(ms / 1000);
  const counted = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? "" : "s"}`;
  if (secs < 60) return counted(secs, "second");
  return secs % 3600 === 0 ? counted(secs / 3600, "hour") : counted(Math.trunc(secs / 60), "minute");
}

export function triggerFiredNote(firing: TriggerFiring, timeZone: string): string {
  const when = formatWallClock(firing.at, timeZone);
  if (firing.byHand === true) return `[This wake was started by hand at ${when}, from Shore's command line or its settings.]`;
  if (firing.seal === true) return `[The seal on this thread came off at ${when}. ${firing.reason}]`;
  return firing.from === undefined
    ? `[Your trigger "${firing.name}" fired at ${when}: ${firing.reason}]`
    : `[You asked for this wake from "${firing.from}" at ${when}: ${firing.reason}]`;
}

export function wakeNewsNote(news: readonly WakeNews[], userName: string, timeZone: string): string | undefined {
  const notes = news.map((item) => item.kind === "trigger" ? triggerFiredNote(item.firing, timeZone) : userWroteNote(item.at, userName, timeZone));
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

export interface ImageRef {
  path: string;
  caption?: string | undefined;
  data?: string | undefined;
}

export function generatedImageRef(value: unknown): ImageRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string") return undefined;
  const caption = record["caption"];
  return {
    path,
    caption: typeof caption === "string" ? caption : undefined,
    data: undefined,
  };
}

export interface AutonomousMessageShape {
  role: "assistant";
  origin: "autonomous";
  content: string;
  contentBlocks: ContentBlock[];
  images: ImageRef[];
  providerKey: string | undefined;
  model: string | undefined;
}

export function buildAutonomousMessage(
  text: string,
  images: ImageRef[],
  providerKey: string | undefined,
  model: string | undefined,
): AutonomousMessageShape {
  const contentBlocks: ContentBlock[] = text.length > 0 ? [{ type: "text", text }] : [];
  return {
    role: "assistant",
    origin: "autonomous",
    content: deriveContentFromBlocks(contentBlocks),
    contentBlocks,
    images,
    providerKey,
    model,
  };
}

function deriveContentFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}
