import { required } from "../util/required.ts";

import builtinSystemTemplate from "../../prompts/engine/builtin_system.md" with { type: "text" };
import { hostZone, naiveInZone, partsOf } from "../ledger/zoned";
import type { ContentBlock, ImageRef, Message, Role } from "./types";
import { estimateTokens, withSafetyMargin } from "./tokens.ts";
import { withDynamicBlocksLast } from "../llm/system_boundary.ts";
import { base64ImageDimensions, fileImageDimensions } from "../llm/image_dimensions.ts";
import { HIGH_RESOLUTION_IMAGE_TIER, imageTokens, sentImageTokens, type ImageTier } from "../llm/image_tokens.ts";
import { findModelCopy } from "../llm/images.ts";

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export const EARLIER_CONVERSATION_NOT_SHOWN = "[earlier conversation not shown]";

export const COMPACT_BEFORE_TRIM_FRACTION = 0.9;


const TIME_GAP_THRESHOLD_SECS = 1_800;

const HOURLY_MARKER_INTERVAL_SECS = 3_600;

const ONE_AND_HALF_HOURS_SECS = 5_400;
const EIGHTEEN_HOURS_SECS = 64_800;
const THIRTY_SIX_HOURS_SECS = 129_600;
const SECS_PER_HOUR = 3_600;
const SECS_PER_DAY = 86_400;

const BUILTIN_SYSTEM_TEMPLATE = builtinSystemTemplate.trimEnd();

export type UserTimestampMode = "never" | "always" | "auto";

interface SystemBlock {
  label: string;
  content: string;
}

export interface PromptMessage {
  role: Role;
  content: string;
  images: ImageRef[];
  content_blocks: ContentBlock[];
  provider_key?: string;
  model?: string;
}

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: PromptMessage[];
  messageBudget: number;
}

export interface PromptParams {
  character_name: string;
  display_name: string;
  system_prompt?: string | undefined;
  tools_guidance?: string | undefined;
  character_definition?: string | undefined;
  user_definition?: string | undefined;
  memory_index?: string | undefined;
  has_prior_context: boolean;
  messages: Message[];
  max_context_tokens?: number | undefined;
  max_output_tokens?: number | undefined;
  user_timestamp_mode: UserTimestampMode;
  image_tier?: ImageTier | undefined;
}

export function assemblePrompt(
  params: PromptParams,
  timeZone: string = hostZone(),
): AssembledPrompt {
  const maxContext = params.max_context_tokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const maxOutput = params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const system = buildSystemBlocks(params);
  const availableForMessages = availableMessageTokens(system, maxContext, maxOutput);

  return {
    system,
    messages: trimMessages(
      params.messages,
      availableForMessages,
      params.has_prior_context,
      params.user_timestamp_mode,
      timeZone,
      params.image_tier ?? HIGH_RESOLUTION_IMAGE_TIER,
    ),
    messageBudget: availableForMessages,
  };
}

function present(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function buildSystemBlocks(params: PromptParams): SystemBlock[] {
  const vars = new Map<string, string>([
    ["char", params.character_name],
    ["character_name", params.character_name],
    ["user", params.display_name],
    ["date", ""],
    ["time", ""],
  ]);

  const system: SystemBlock[] = [];

  const systemPrompt = params.system_prompt ?? BUILTIN_SYSTEM_TEMPLATE;
  if (systemPrompt.trim() !== "") {
    system.push({ label: "system", content: renderTemplate(systemPrompt, vars) });
  }

  const toolsGuidance = present(params.tools_guidance);
  if (toolsGuidance !== undefined) {
    system.push({ label: "tools_guidance", content: toolsGuidance });
  }

  const charDef = present(params.character_definition);
  if (charDef !== undefined) {
    system.push({ label: "character", content: charDef });
  }

  const userDef = present(params.user_definition);
  if (userDef !== undefined) {
    system.push({ label: "user", content: userDef });
  }

  const index = present(params.memory_index);
  if (index !== undefined) {
    system.push({ label: "memory_index", content: index });
  }

  return withDynamicBlocksLast(system);
}

function availableMessageTokens(
  system: SystemBlock[],
  maxContext: number,
  maxOutput: number,
): number {
  const systemTokens = estimateTokens(system.map((b) => b.content).join("\n"));
  return withSafetyMargin(Math.max(0, maxContext - maxOutput - systemTokens));
}

export function renderTemplate(template: string, vars: Map<string, string>): string {
  let result = template;

  for (;;) {
    const ifStart = result.indexOf("{{#if ");
    if (ifStart === -1) break;

    const nameStart = ifStart + "{{#if ".length;
    const nameEnd = result.indexOf("}}", nameStart);
    if (nameEnd === -1) break;

    const name = result.slice(nameStart, nameEnd).trim();
    const openTagEnd = nameEnd + 2;

    const closePos = result.indexOf("{{/if}}", openTagEnd);
    if (closePos === -1) break;

    const blockContent = result.slice(openTagEnd, closePos);
    const after = result.slice(closePos + "{{/if}}".length);

    const value = vars.get(name);
    result =
      value !== undefined && value !== ""
        ? result.slice(0, ifStart) + blockContent.split(`{{${name}}}`).join(value) + after
        : result.slice(0, ifStart) + after;
  }

  return result.replace(/\{\{([^{}]*)\}\}/g, (tag, name: string) => vars.get(name) ?? tag);
}

export function stripOneTrailingNewline(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function estimateBlockTokens(block: ContentBlock, tier: ImageTier): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "thinking":
      return estimateTokens(block.thinking);
    case "tool_use":
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
    case "redacted_thinking":
      return 0;
    case "tool_result":
      return typeof block.content === "string"
        ? estimateTokens(block.content)
        : block.content.reduce((total, inner) => total + estimateBlockTokens(inner, tier), 0);
    case "image":
      return sentImageTokens(base64ImageDimensions(block.source.data), tier);
  }
}

function attachedImageTokens(image: ImageRef, tier: ImageTier): number {
  const copy = findModelCopy(image.path);
  if (copy !== undefined) return sentImageTokens(fileImageDimensions(copy.path), tier);
  const dimensions = image.data !== undefined && image.data.length > 0
    ? base64ImageDimensions(image.data)
    : fileImageDimensions(image.path);
  return imageTokens(dimensions, tier);
}

export function estimateMessageTokens(
  msg: Message,
  tier: ImageTier = HIGH_RESOLUTION_IMAGE_TIER,
): number {
  return msg.content_blocks.reduce(
    (total, block) => total + estimateBlockTokens(block, tier),
    msg.images.reduce((total, image) => total + attachedImageTokens(image, tier), 0),
  );
}

export function nearMessageBudget(
  messages: readonly Message[],
  messageBudget: number,
  tier: ImageTier = HIGH_RESOLUTION_IMAGE_TIER,
): boolean {
  const threshold = messageBudget * COMPACT_BEFORE_TRIM_FRACTION;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    used += estimateMessageTokens(required(messages[i]), tier);
    if (used >= threshold) return true;
  }
  return false;
}

export function estimateHistoryTokens(
  messages: readonly Message[],
  tier: ImageTier = HIGH_RESOLUTION_IMAGE_TIER,
): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message, tier), 0);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

function relativeGapPhrase(gapSecs: number): string {
  if (gapSecs < ONE_AND_HALF_HOURS_SECS) return "about an hour later";
  if (gapSecs < EIGHTEEN_HOURS_SECS) {
    return `${Math.round(gapSecs / SECS_PER_HOUR)} hours later`;
  }
  if (gapSecs < THIRTY_SIX_HOURS_SECS) return "about a day later";
  return `${Math.round(gapSecs / SECS_PER_DAY)} days later`;
}

function formatTimeMarker(
  gapSecs: number | undefined,
  instantMs: number,
  timeZone: string,
): string {
  const timeStr = formatWallClock(instantMs, timeZone);

  return gapSecs !== undefined && gapSecs >= TIME_GAP_THRESHOLD_SECS
    ? `[${relativeGapPhrase(gapSecs)} · ${timeStr}]`
    : `[${timeStr}]`;
}

export function formatWallClock(instantMs: number, timeZone: string): string {
  const naive = naiveInZone(instantMs, timeZone);
  const { year, month, day, hour } = partsOf(naive);
  const d = new Date(naive);
  const weekday = required(WEEKDAYS[d.getUTCDay()]);
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${weekday} ${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)} · ${hour12}:${pad2(d.getUTCMinutes())} ${meridiem}`;
}

export function wallClockMarker(
  previousTimestamp: string | undefined,
  timestamp: string,
  timeZone: string,
): string | undefined {
  const currentMs = parseRfc3339(timestamp);
  if (currentMs === undefined) return undefined;
  const prevMs = previousTimestamp === undefined ? undefined : parseRfc3339(previousTimestamp);
  if (prevMs === undefined) return formatTimeMarker(undefined, currentMs, timeZone);
  const gap = gapSeconds(prevMs, currentMs);
  return gap < TIME_GAP_THRESHOLD_SECS ? undefined : formatTimeMarker(gap, currentMs, timeZone);
}

function gapSeconds(fromMs: number, toMs: number): number {
  return Math.trunc((toMs - fromMs) / 1000);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseRfc3339(ts: string): number | undefined {
  if (!RFC3339.test(ts)) return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

function isToolLoopMessage(role: Role, blocks: ContentBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (role === "user") return blocks.every((b) => b.type === "tool_result");
  if (role === "assistant") {
    const hasText = blocks.some((b) => b.type === "text" && b.text !== "");
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    return !hasText && hasToolUse;
  }
  return false;
}

function trimMessages(
  messages: Message[],
  tokenBudget: number,
  hasPriorContext: boolean,
  mode: UserTimestampMode,
  timeZone: string,
  imageTier: ImageTier,
): PromptMessage[] {
  const selected: { pm: PromptMessage; ts: string; heartbeat: boolean }[] = [];
  let usedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = required(messages[i]);
    const msgTokens = estimateMessageTokens(msg, imageTier);
    if (usedTokens + msgTokens > tokenBudget && selected.length > 0) break;
    usedTokens += msgTokens;
    selected.push({
      pm: {
        role: msg.role,
        content: msg.content,
        images: [...msg.images],
        content_blocks: [...msg.content_blocks],
        ...(msg.provider_key !== undefined ? { provider_key: msg.provider_key } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
      },
      ts: msg.timestamp,
      heartbeat: msg.role === "assistant" && msg.origin === "autonomous",
    });
  }
  selected.reverse();

  while (selected.length > 0 && isToolLoopMessage(required(selected[0]).pm.role, required(selected[0]).pm.content_blocks)) {
    selected.shift();
  }

  const lostContext = hasPriorContext || selected.length < messages.length;

  let prevMs: number | undefined;
  let lastMarkerMs: number | undefined;
  let firstUserPending = true;
  const result: PromptMessage[] = [];

  for (const { pm, ts, heartbeat } of selected) {
    const currentMs = parseRfc3339(ts);

    if (heartbeat) result.push(syntheticUserTurn(heartbeatMarker(currentMs, mode, timeZone)));

    if (pm.role === "user" && currentMs !== undefined) {
      const gap = prevMs === undefined ? undefined : gapSeconds(prevMs, currentMs);

      let inject: boolean;
      if (mode === "never") {
        inject = false;
      } else if (mode === "always") {
        inject = true;
      } else {
        const bigGap = gap !== undefined && gap >= TIME_GAP_THRESHOLD_SECS;
        const hourlyTick =
          lastMarkerMs !== undefined &&
          gapSeconds(lastMarkerMs, currentMs) >= HOURLY_MARKER_INTERVAL_SECS;
        inject = bigGap || hourlyTick || (firstUserPending && lostContext);
      }

      if (inject) {
        const marker = formatTimeMarker(gap, currentMs, timeZone);
        pm.content = `${marker}\n\n${pm.content}`;
        const first = pm.content_blocks[0];
        if (first !== undefined && first.type === "text") {
          pm.content_blocks = [
            { type: "text", text: `${marker}\n\n${first.text}` },
            ...pm.content_blocks.slice(1),
          ];
        }
        lastMarkerMs = currentMs;
      }
      firstUserPending = false;
    }

    if (currentMs !== undefined) prevMs = currentMs;
    result.push(pm);
  }

  if (result.find((m) => m.role !== "system")?.role === "assistant") {
    result.unshift(syntheticUserTurn(EARLIER_CONVERSATION_NOT_SHOWN));
  }

  return result;
}

function syntheticUserTurn(text: string): PromptMessage {
  return { role: "user", content: text, images: [], content_blocks: [{ type: "text", text }] };
}

function heartbeatMarker(instantMs: number | undefined, mode: UserTimestampMode, timeZone: string): string {
  return mode === "never" || instantMs === undefined
    ? "[heartbeat]"
    : `[heartbeat · ${formatWallClock(instantMs, timeZone)}]`;
}
