import { required } from "../util/required.ts";

import threadTemplate from "../../prompts/engine/thread.md" with { type: "text" };
import { hostZone, naiveInZone, partsOf } from "../ledger/zoned";
import type { ContentBlock, ImageRef, Message, MessageNote, Role } from "./types";
import { estimateTokens, withSafetyMargin } from "./tokens.ts";
import { unsentNotice } from "./embeds.ts";
import { base64ImageDimensions, fileImageDimensions } from "../llm/image_dimensions.ts";
import { HIGH_RESOLUTION_IMAGE_TIER, imageTokens, sentImageTokens, type ImageTier } from "../llm/image_tokens.ts";
import { findModelCopy } from "../llm/images.ts";
import { isToolResultOnly } from "./message_store.ts";
import { pinnedCommand } from "./threads.ts";
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "../config/model_defaults.ts";

export const EARLIER_CONVERSATION_NOT_SHOWN = "[earlier conversation not shown]";

export const THREAD_OPENED_BY_YOU = "[this conversation starts with your message]";

export const COMPACT_BEFORE_TRIM_FRACTION = 0.9;


const TIME_GAP_THRESHOLD_SECS = 1_800;

const HOURLY_MARKER_INTERVAL_SECS = 3_600;

const ONE_AND_HALF_HOURS_SECS = 5_400;
const EIGHTEEN_HOURS_SECS = 64_800;
const THIRTY_SIX_HOURS_SECS = 129_600;
const SECS_PER_HOUR = 3_600;
const SECS_PER_DAY = 86_400;

const THREAD_TEMPLATE = threadTemplate.trimEnd();

const THREAD_PINS_HEADER =
  "Files and command output pinned to this thread's prompt. Changes show up here after a long pause in this thread, or after it compacts; commands run again then.";

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

export interface PromptSource {
  msg_id: string | undefined;
  notes: MessageNote[];
}

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: PromptMessage[];
  sources: PromptSource[];
  messageBudget: number;
}

export interface ThreadPrompt {
  id: string;
  home: string;
  created_at: string;
  started_by_you: boolean;
  label?: string | undefined;
  purpose?: string | undefined;
  pins: readonly { pin: string; content: string | undefined }[];
}

export type PromptSection =
  | { label: string; text: string | undefined; template: boolean }
  | { shore: "thread" | "thread_pins" };

export interface PromptParams {
  thread?: ThreadPrompt | undefined;
  character_name: string;
  display_name: string;
  sections: readonly PromptSection[];
  has_prior_context: boolean;
  archived_last_at?: string | undefined;
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

  const system = buildSystemBlocks(params, timeZone);
  const availableForMessages = availableMessageTokens(system, maxContext, maxOutput);
  const trimmed = trimMessages(
    params.messages,
    availableForMessages,
    params.has_prior_context,
    params.archived_last_at,
    params.user_timestamp_mode,
    timeZone,
    params.image_tier ?? HIGH_RESOLUTION_IMAGE_TIER,
  );

  return {
    system,
    messages: trimmed.map(({ pm }) => pm),
    sources: trimmed.map(({ source }) => source),
    messageBudget: availableForMessages,
  };
}

function threadBlock(thread: ThreadPrompt, vars: ReadonlyMap<string, string>, timeZone: string): string {
  const created = Date.parse(thread.created_at);
  const started = Number.isNaN(created) ? thread.created_at : required(formatWallClock(created, timeZone).split(" · ")[0]);
  return renderTemplate(THREAD_TEMPLATE, new Map([
    ...vars,
    ["thread", thread.id],
    ["home", thread.home],
    ["started", started],
    ["starter", thread.started_by_you ? "you" : vars.get("user") ?? ""],
    ["label", thread.label ?? ""],
    ["purpose", thread.purpose ?? ""],
  ])).trim();
}

function pinSection(pin: string, content: string | undefined): string {
  const command = pinnedCommand(pin);
  const shown = content?.trimEnd() ?? "";
  if (command !== undefined) return `## $ ${command}\n\n${shown === "" ? "(This command hasn't run yet.)" : shown}`;
  return `## ${pin}\n\n${shown === "" ? "(This file is empty or isn't in the workspace.)" : shown}`;
}

function threadPinsBlock(pins: ThreadPrompt["pins"]): string {
  return [THREAD_PINS_HEADER, ...pins.map(({ pin, content }) => pinSection(pin, content))].join("\n\n");
}

function buildSystemBlocks(params: PromptParams, timeZone: string): SystemBlock[] {
  const vars = new Map<string, string>([
    ["char", params.character_name],
    ["character_name", params.character_name],
    ["user", params.display_name],
    ["date", ""],
    ["time", ""],
  ]);

  return params.sections.flatMap((section): SystemBlock[] => {
    if (!("shore" in section)) {
      const content = section.template ? renderTemplate(section.text ?? "", vars) : section.text ?? "";
      return content.trim() === "" ? [] : [{ label: section.label, content }];
    }
    const thread = params.thread;
    if (thread === undefined) return [];
    if (section.shore === "thread") return [{ label: "thread", content: threadBlock(thread, vars, timeZone) }];
    return thread.pins.length === 0 ? [] : [{ label: "thread_pins", content: threadPinsBlock(thread.pins) }];
  });
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
    isToolResultOnly(msg) ? 0 : msg.images.reduce((total, image) => image.embed === undefined ? total + attachedImageTokens(image, tier) : total, 0),
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

function lengthPhrase(gapSecs: number): string {
  if (gapSecs < SECS_PER_HOUR) {
    const minutes = Math.max(1, Math.round(gapSecs / 60));
    return minutes === 1 ? "a minute" : `${String(minutes)} minutes`;
  }
  if (gapSecs < ONE_AND_HALF_HOURS_SECS) return "about an hour";
  if (gapSecs < EIGHTEEN_HOURS_SECS) return `${String(Math.round(gapSecs / SECS_PER_HOUR))} hours`;
  if (gapSecs < THIRTY_SIX_HOURS_SECS) return "about a day";
  return `${String(Math.round(gapSecs / SECS_PER_DAY))} days`;
}

export function agoPhrase(gapSecs: number): string {
  return `${lengthPhrase(gapSecs)} ago`;
}

function lastElsewherePhrase(elsewhere: Message["last_elsewhere"], instantMs: number): string | undefined {
  if (elsewhere === undefined) return undefined;
  const at = parseRfc3339(elsewhere.at);
  if (at === undefined) return undefined;
  return `last in ${elsewhere.thread} ${agoPhrase(Math.max(0, gapSeconds(at, instantMs)))}`;
}

function formatTimeMarker(
  gapSecs: number | undefined,
  instantMs: number,
  timeZone: string,
  lastElsewhere?: Message["last_elsewhere"],
): string {
  const timeStr = formatWallClock(instantMs, timeZone);
  if (gapSecs === undefined || gapSecs < TIME_GAP_THRESHOLD_SECS) return `[${timeStr}]`;
  const elsewhere = lastElsewherePhrase(lastElsewhere, instantMs);
  return `[${relativeGapPhrase(gapSecs)} · ${timeStr}${elsewhere === undefined ? "" : ` · ${elsewhere}`}]`;
}

export function presenceText(presence: NonNullable<Message["presence"]>, at: number, whose: string): string {
  const since = (instant: string): number => gapSeconds(Date.parse(instant), at);
  if (presence.statuses.length === 0) return `[${whose} status was cleared ${agoPhrase(since(presence.changed_at))}.]`;
  return `[${whose} status: ${presence.statuses.map((status) => `"${status.status}" for ${lengthPhrase(since(status.set_at))}`).join(", ")}]`;
}

export function wakeRunningText(running: NonNullable<Message["wake_running"]>, timeZone: string): string {
  const since = formatWallClock(Date.parse(running.started_at), timeZone);
  const where = running.thread === undefined ? "your own-time thread" : `"${running.thread}"`;
  return `[A wake of yours in ${where} has been running since ${since}. It can't see this conversation. It is only told that a message arrived.]`;
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
  archivedLastAt: string | undefined,
  mode: UserTimestampMode,
  timeZone: string,
  imageTier: ImageTier,
): { pm: PromptMessage; source: PromptSource }[] {
  const selected: { pm: PromptMessage; id: string; ts: string; wake: boolean; elsewhere: Message["last_elsewhere"]; running: Message["wake_running"]; presence: Message["presence"] }[] = [];
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
      id: msg.msg_id,
      ts: msg.timestamp,
      wake: msg.role === "assistant" && msg.origin === "autonomous",
      elsewhere: msg.last_elsewhere,
      running: msg.wake_running,
      presence: msg.presence,
    });
  }
  selected.reverse();

  while (selected.length > 0 && isToolLoopMessage(required(selected[0]).pm.role, required(selected[0]).pm.content_blocks)) {
    selected.shift();
  }

  const dropped = messages.length - selected.length;
  const lostContext = hasPriorContext || dropped > 0;

  const before = dropped > 0 ? required(messages[dropped - 1]).timestamp : archivedLastAt;
  let prevMs = before === undefined ? undefined : parseRfc3339(before);
  let lastMarkerMs: number | undefined;
  let unsent: ImageRef[] = [];
  const result: { pm: PromptMessage; source: PromptSource }[] = [];
  const noticed = (pm: PromptMessage, notes: MessageNote[]): PromptMessage => {
    const notice = unsentNotice(unsent);
    unsent = [];
    if (notice === undefined) return pm;
    pm.content = `${notice}\n\n${pm.content}`;
    pm.content_blocks = [{ type: "text", text: notice }, ...pm.content_blocks];
    notes.unshift({ place: "start", text: notice });
    return pm;
  };

  for (const { pm, id, ts, wake, elsewhere, running, presence } of selected) {
    const currentMs = parseRfc3339(ts);
    const notes: MessageNote[] = [];

    if (wake) result.push(addedTurn(noticed(syntheticUserTurn(wakeMarker(currentMs, mode, timeZone)), [])));
    const written = pm.role === "user" && !isToolLoopMessage(pm.role, pm.content_blocks);
    if (written) noticed(pm, notes);

    const first = pm.content_blocks[0];
    if (written && currentMs !== undefined && first?.type === "text") {
      const gap = prevMs === undefined ? undefined : gapSeconds(prevMs, currentMs);
      const bigGap = gap !== undefined && gap >= TIME_GAP_THRESHOLD_SECS;
      const due = bigGap || (lastMarkerMs === undefined ? lostContext : gapSeconds(lastMarkerMs, currentMs) >= HOURLY_MARKER_INTERVAL_SECS);

      if (mode === "always" || (mode === "auto" && due)) {
        const marker = formatTimeMarker(gap, currentMs, timeZone, elsewhere);
        pm.content = `${marker}\n\n${pm.content}`;
        pm.content_blocks = [
          { type: "text", text: `${marker}\n\n${first.text}` },
          ...pm.content_blocks.slice(1),
        ];
        notes.unshift({ place: "start", text: marker });
        lastMarkerMs = currentMs;
      }
    }

    if (presence !== undefined && currentMs !== undefined) {
      const text = presenceText(presence, currentMs, "Their");
      pm.content = `${text}\n\n${pm.content}`;
      pm.content_blocks = [{ type: "text", text }, ...pm.content_blocks];
      notes.unshift({ place: "start", text });
    }

    if (running !== undefined) {
      const text = wakeRunningText(running, timeZone);
      pm.content = `${text}\n\n${pm.content}`;
      pm.content_blocks = [{ type: "text", text }, ...pm.content_blocks];
      notes.unshift({ place: "start", text });
    }

    if (currentMs !== undefined) prevMs = currentMs;
    if (pm.role === "assistant") unsent.push(...pm.images);
    result.push({ pm, source: { msg_id: id, notes } });
  }

  if (result.find(({ pm }) => pm.role !== "system")?.pm.role === "assistant") {
    result.unshift(addedTurn(syntheticUserTurn(lostContext ? EARLIER_CONVERSATION_NOT_SHOWN : THREAD_OPENED_BY_YOU)));
  }

  return result;
}

function addedTurn(pm: PromptMessage): { pm: PromptMessage; source: PromptSource } {
  return { pm, source: { msg_id: undefined, notes: [] } };
}

function syntheticUserTurn(text: string): PromptMessage {
  return { role: "user", content: text, images: [], content_blocks: [{ type: "text", text }] };
}

export function wakeMarker(instantMs: number | undefined, mode: UserTimestampMode, timeZone: string): string {
  return mode === "never" || instantMs === undefined
    ? "[wake]"
    : `[wake · ${formatWallClock(instantMs, timeZone)}]`;
}
