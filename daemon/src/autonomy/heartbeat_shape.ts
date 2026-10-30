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

export function timeLeftPhrase(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "about a minute" : `about ${String(minutes)} minutes`;
}

export function wrapUpNudgeText(msLeft: number, rounds: number, offersWake: boolean): string {
  const stop = rounds === 1 ? "after this round" : `after ${String(rounds)} more rounds, counting this one`;
  return `[System nudge: this heartbeat stops in ${timeLeftPhrase(msLeft)} or ${stop}, whichever comes first. ` +
    "Wrap up now: note any unfinished work in HEARTBEAT.md so future-you can pick it up, " +
    (offersWake ? "call set_next_wake if you haven't yet, " : "") +
    "then either send your message in <sendMessage> tags or reply HEARTBEAT_OK.]";
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

export const DEFAULT_HEARTBEAT_TEMPLATE = heartbeatTemplateRaw.trimEnd();

export interface HeartbeatPromptVars {
  now: string;
  userName: string;
  defaultInterval: string;
  timeLimit: string;
  wrapUpAfter: string;
  maxRounds: number | undefined;
}

export function renderHeartbeatPrompt(template: string, vars: HeartbeatPromptVars): string {
  return renderTemplate(
    template,
    new Map([
      ["now", vars.now],
      ["user", vars.userName],
      ["default_interval", vars.defaultInterval],
      ["time_limit", vars.timeLimit],
      ["wrap_up_after", vars.wrapUpAfter],
      ["max_rounds", vars.maxRounds === undefined ? "" : String(vars.maxRounds)],
    ]),
  );
}
