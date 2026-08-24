import heartbeatTemplateRaw from "../../prompts/autonomy/heartbeat.md" with { type: "text" };

import { renderTemplate } from "../engine/prompt.ts";
import type { ContentBlock } from "../engine/types.ts";

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

export type BudgetAction =
  | "continue"
  | "nudge"
  | "break";

export function budgetDecision(
  deadlineReached: boolean,
  normalCapReached: boolean,
  wrapUpGrace: number,
  wrapUpNudged: boolean,
): BudgetAction {
  if ((deadlineReached || normalCapReached) && !wrapUpNudged) {
    return wrapUpGrace === 0 ? "break" : "nudge";
  }
  if (deadlineReached && wrapUpNudged) return "break";
  return "continue";
}

export const WRAP_UP_NUDGE_TEXT =
  "[System nudge: heartbeat tool-use budget reached. Wrap up now — " +
  "if you have unfinished work, note it in MEMORY.md with today's date so future-you can pick it up " +
  "where you left off. Then either send a final <sendMessage> or respond HEARTBEAT_OK and stop.]";

export function appendWrapUpNudge(messages: WireMessageLike[]): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "user") {
    last.content.push({ type: "text", text: WRAP_UP_NUDGE_TEXT });
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text: WRAP_UP_NUDGE_TEXT }] });
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
  thinking: readonly ContentBlock[] = [],
): AutonomousMessageShape {
  const contentBlocks: ContentBlock[] = [...thinking];
  if (text.length > 0) contentBlocks.push({ type: "text", text });
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

export const DEFAULT_HEARTBEAT_TEMPLATE = heartbeatTemplateRaw.trimEnd();

export function renderHeartbeatPrompt(
  template: string,
  now: string,
  userName: string,
  defaultInterval: string,
): string {
  return renderTemplate(
    template,
    new Map([
      ["now", now],
      ["user", userName],
      ["default_interval", defaultInterval],
    ]),
  );
}

export function buildHeartbeatPrompt(
  now: string,
  userName: string,
  defaultInterval: string,
): string {
  return renderHeartbeatPrompt(DEFAULT_HEARTBEAT_TEMPLATE, now, userName, defaultInterval);
}
