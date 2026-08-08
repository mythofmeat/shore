import builtinSystemTemplate from "../../prompts/engine/builtin_system.md" with { type: "text" };
import { hostZone, naiveInZone, partsOf } from "../ledger/zoned";
import type { ContentBlock, ImageRef, Message, Role } from "./types";

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const CHARS_PER_TOKEN = 4;

const TIME_GAP_THRESHOLD_SECS = 1_800;

const HOURLY_MARKER_INTERVAL_SECS = 3_600;

const ONE_AND_HALF_HOURS_SECS = 5_400;
const EIGHTEEN_HOURS_SECS = 64_800;
const THIRTY_SIX_HOURS_SECS = 129_600;
const SECS_PER_HOUR = 3_600;
const SECS_PER_DAY = 86_400;

const BUILTIN_SYSTEM_TEMPLATE = builtinSystemTemplate.trimEnd();

export type UserTimestampMode = "never" | "always" | "auto";

export interface SystemBlock {
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
    ),
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

  const system: SystemBlock[] = [
    {
      label: "system",
      content: renderTemplate(params.system_prompt ?? BUILTIN_SYSTEM_TEMPLATE, vars),
    },
  ];

  const toolsGuidance = present(params.tools_guidance);
  if (toolsGuidance !== undefined) {
    system.push({ label: "tools_guidance", content: toolsGuidance });
  }

  const charDef = present(params.character_definition);
  if (charDef !== undefined) {
    const tag = xmlTagFromName(params.character_name, "character");
    system.push({ label: "character", content: `<${tag}>\n${charDef}\n</${tag}>` });
  }

  const userDef = present(params.user_definition);
  if (userDef !== undefined) {
    const tag = xmlTagFromName(params.display_name, "user");
    system.push({ label: "user", content: `<${tag}>\n${userDef}\n</${tag}>` });
  }

  const index = present(params.memory_index);
  if (index !== undefined) {
    system.push({
      label: "memory_index",
      content:
        "<memory_index>\n" +
        "The following is your active memory from workspace/MEMORY.md — a dated, " +
        "continuously pruned scratchpad of what is live right now: current state, " +
        "still-relevant conversational throughlines, and thin pointers to where deeper " +
        "material lives. It is not long-term storage; that is the job of your memory/ " +
        "files, and it does not replace SOUL.md, USER.md, AGENTS.md, or TOOLS.md.\n\n" +
        `${index}\n` +
        "</memory_index>",
    });
  }

  return system;
}

function availableMessageTokens(
  system: SystemBlock[],
  maxContext: number,
  maxOutput: number,
): number {
  const systemTokens = estimateTokens(system.map((b) => b.content).join("\n"));
  return Math.max(0, maxContext - maxOutput - systemTokens);
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

export function xmlTagFromName(name: string, fallback: string): string {
  const tag = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return tag === "" ? fallback : tag;
}

export function stripOneTrailingNewline(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: Message): number {
  if (msg.content_blocks.length === 0) {
    return estimateTokens(msg.content);
  }
  let total = 0;
  for (const block of msg.content_blocks) {
    switch (block.type) {
      case "text":
        total += estimateTokens(block.text);
        break;
      case "thinking":
        total += estimateTokens(block.thinking);
        break;
      case "tool_use":
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
        break;
      case "redacted_thinking":
        break;
      case "tool_result":
        total += estimateTokens(
          typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        );
        break;
      default:
        break;
    }
  }
  return total;
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
  const weekday = WEEKDAYS[d.getUTCDay()]!;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${weekday} ${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)} · ${hour12}:${pad2(d.getUTCMinutes())} ${meridiem}`;
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
): PromptMessage[] {
  const selected: { pm: PromptMessage; ts: string }[] = [];
  let usedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const msgTokens = estimateMessageTokens(msg);
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
    });
  }
  selected.reverse();

  while (selected.length > 0 && isToolLoopMessage(selected[0]!.pm.role, selected[0]!.pm.content_blocks)) {
    selected.shift();
  }

  const lostContext = hasPriorContext || selected.length < messages.length;

  let prevMs: number | undefined;
  let lastMarkerMs: number | undefined;
  let firstUserPending = true;
  const result: PromptMessage[] = [];

  for (const { pm, ts } of selected) {
    const currentMs = parseRfc3339(ts);

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

  return result;
}
