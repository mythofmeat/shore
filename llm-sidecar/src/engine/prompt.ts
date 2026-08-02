/**
 * Prompt assembly — the system blocks and the trimmed, time-marked message
 * list that every chat-shaped request is built from.
 *
 * Ported from `crates/daemon/src/engine/prompt.rs`. Pinned by
 * `tests/engine_fixtures/prompt_parity.json`, whose every value was produced
 * by driving the real Rust.
 *
 * Two things here are load-bearing for cache reuse and are easy to get subtly
 * wrong:
 *
 *   - **Token estimates count UTF-8 bytes**, not characters. Rust reaches
 *     `str::len()`, which is bytes; JavaScript's `.length` is UTF-16 code
 *     units and disagrees on everything non-ASCII. A history of Japanese text
 *     would be trimmed at a different point.
 *   - **Time markers render in local wall-clock**, so they depend on a
 *     timezone. The zone is an explicit parameter rather than the host's,
 *     because a marker that moves is a changed prefix, and a changed prefix is
 *     a cache miss on every turn.
 */

import { hostZone, naiveInZone, partsOf } from "../ledger/zoned";
import type { ContentBlock, ImageRef, Message, Role } from "./types";

/** Context window size when the model config does not specify one. */
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

/** Output reservation when the model config does not specify one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Bytes per token, for budget estimation only. */
const CHARS_PER_TOKEN = 4;

/**
 * Smallest gap that earns a relative phrase ("X later"). Shorter gaps can
 * still get a marker via the hourly tick or the lost-context anchor, but in
 * the absolute-only form.
 */
const TIME_GAP_THRESHOLD_SECS = 1_800;

/** How long since the last marker before a fresh one is injected. */
const HOURLY_MARKER_INTERVAL_SECS = 3_600;

const ONE_AND_HALF_HOURS_SECS = 5_400;
const EIGHTEEN_HOURS_SECS = 64_800;
const THIRTY_SIX_HOURS_SECS = 129_600;
const SECS_PER_HOUR = 3_600;
const SECS_PER_DAY = 86_400;

/**
 * The built-in system template, used when the character has no AGENTS.md.
 *
 * Held here rather than read from disk: the Rust baked it in at compile time
 * via `include_prompt!` (which strips exactly one trailing newline, hence no
 * newline at the end of this string), and the sidecar has no reason to make it
 * a runtime file read. The character/user definitions, TOOLS.md and the memory
 * index are separate system blocks, which is why this is so thin.
 */
const BUILTIN_SYSTEM_TEMPLATE =
  "You are {{char}}, in conversation with {{user}}.\n" +
  "This is a text conversation. Communicate directly rather than narrating actions or using roleplay formatting.\n" +
  "Be consistent with established details and avoid fabricating memory.";

/** How the `[behavior] user_message_timestamps` setting selects marker policy. */
export type UserTimestampMode = "never" | "always" | "auto";

/** A labelled chunk of system prompt. The label is for cache diagnostics. */
export interface SystemBlock {
  label: string;
  content: string;
}

/** A message as the prompt carries it: no ids, no alternatives, markers applied. */
export interface PromptMessage {
  role: Role;
  content: string;
  images: ImageRef[];
  content_blocks: ContentBlock[];
  /** Carried so the replay path can drop thinking data a provider cannot read. */
  provider_key?: string;
  /** Finer than `provider_key`: aggregators front many models behind one key. */
  model?: string;
}

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: PromptMessage[];
}

export interface PromptParams {
  character_name: string;
  display_name: string;
  // These are `| undefined` rather than bare optional because the repo runs
  // `exactOptionalPropertyTypes`, and every caller reads them off a config or a
  // file load that legitimately yields undefined — an absent AGENTS.md is not
  // the same shape of thing as an omitted argument.
  /** Active AGENTS.md, or undefined for the built-in template. */
  system_prompt?: string | undefined;
  tools_guidance?: string | undefined;
  character_definition?: string | undefined;
  user_definition?: string | undefined;
  memory_index?: string | undefined;
  /**
   * True when history the model can no longer see was archived by compaction.
   * Earns the first user message an absolute-time anchor across the cut.
   */
  has_prior_context: boolean;
  messages: Message[];
  max_context_tokens?: number | undefined;
  max_output_tokens?: number | undefined;
  user_timestamp_mode: UserTimestampMode;
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * Build the system blocks and the trimmed message list.
 *
 * `timeZone` is what time markers render in; it defaults to the host's, which
 * is what `chrono::Local` resolved to in the Rust.
 */
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

/** Non-empty or absent — an empty string suppresses its block entirely. */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function buildSystemBlocks(params: PromptParams): SystemBlock[] {
  const vars = new Map<string, string>([
    ["char", params.character_name],
    ["character_name", params.character_name],
    ["user", params.display_name],
    // Blank on purpose: a date that ticks would change the cache prefix daily.
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

/**
 * What is left for messages after the system blocks and the output
 * reservation. Saturates at zero rather than going negative — a system prompt
 * larger than the context window is a misconfiguration, but it must not
 * produce a nonsense budget.
 */
function availableMessageTokens(
  system: SystemBlock[],
  maxContext: number,
  maxOutput: number,
): number {
  const systemTokens = estimateTokens(system.map((b) => b.content).join("\n"));
  return Math.max(0, maxContext - maxOutput - systemTokens);
}

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Mustache-ish rendering: `{{key}}` substitution and `{{#if key}}…{{/if}}`
 * blocks, where "truthy" means present in `vars` and non-empty.
 *
 * A tag whose key is **not** in `vars` is left verbatim, not blanked. The
 * Rust's doc comment claimed otherwise ("or empty string if key not found")
 * and so did the name of the test covering it; both were wrong about the code
 * beneath them, which only ever replaced keys it had. The fixture records what
 * actually happens.
 *
 * Nested conditionals do not work, and that behaviour is reproduced rather
 * than fixed: the close-tag search takes the *first* `{{/if}}`, which for a
 * nested block is the inner one, so the outer block ends early and a stray
 * `{{/if}}` survives into the output. No shipped template nests, and inventing
 * a different answer here would be a silent divergence in the one place a
 * divergence costs a cache prefix.
 *
 * **One deliberate divergence.** The Rust substituted variables by iterating a
 * `HashMap`, whose order is unspecified and reseeded per map — and it replaced
 * into the accumulating result, so a value containing another key's tag was
 * re-scanned or not depending on that order. Given `{a: "{{b}}", b: "B"}`,
 * `"{{a}}"` rendered as `"B"` or `"{{b}}"` at random; driven through
 * `assemble_prompt`, a character named `{{user}}` produced two different system
 * prompts across runs. A nondeterministic system prompt is a nondeterministic
 * cache prefix. This does a single pass and never re-scans what it
 * substituted, which is deterministic, and agrees with the Rust in every case
 * where the Rust agreed with itself.
 */
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A free-form name as an XML tag: lowercased, non-alphanumerics collapsed to
 * single underscores, edges stripped, `fallback` if nothing survives.
 *
 * Note `is_ascii_alphanumeric` in the Rust — a character name in a non-Latin
 * script sanitises away entirely and lands on the fallback.
 */
export function xmlTagFromName(name: string, fallback: string): string {
  const tag = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return tag === "" ? fallback : tag;
}

/**
 * Drop one trailing newline, and only one.
 *
 * `include_prompt!` does this at compile time so a prompt file can end the way
 * text files are supposed to without the newline riding into the prompt — and
 * into the cache key, which hashes the exact bytes. A file ending in two
 * newlines keeps one.
 *
 * Lives here rather than beside any one caller: every `.md` imported with
 * `{ type: "text" }` needs it, and they are no longer all compaction's.
 */
export function stripOneTrailingNewline(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** UTF-8 byte length. See the note at the top of this file. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / CHARS_PER_TOKEN);
}

/**
 * A message's token cost. Content blocks win when present; `content` is only
 * consulted for messages that predate them.
 *
 * `redacted_thinking` counts as zero — it is opaque bytes the model does not
 * read as text.
 */
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
        // `JSON.stringify` matches `serde_json::Value::to_string` byte for
        // byte here, key order included: the workspace enables serde_json's
        // `preserve_order`, so both emit source order with no spacing.
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

/**
 * The relative half of a marker.
 *
 * The rounding is `f64::round`, half away from zero, and the boundaries are
 * exclusive on the way in, which produces two readings worth knowing:
 * exactly 1.5 hours is "2 hours later", and exactly 36 hours is "2 days
 * later". "1 days later" cannot be produced at all — the days arm only sees
 * gaps of 36 hours or more, which round to 2 or higher.
 */
function relativeGapPhrase(gapSecs: number): string {
  if (gapSecs < ONE_AND_HALF_HOURS_SECS) return "about an hour later";
  if (gapSecs < EIGHTEEN_HOURS_SECS) {
    return `${Math.round(gapSecs / SECS_PER_HOUR)} hours later`;
  }
  if (gapSecs < THIRTY_SIX_HOURS_SECS) return "about a day later";
  return `${Math.round(gapSecs / SECS_PER_DAY)} days later`;
}

/**
 * `[6 hours later · Saturday 2026-04-04 · 9:14 PM]`, or the absolute-only
 * form when there is no gap to render.
 *
 * Built from arithmetic on the zone's wall-clock reading rather than handed to
 * `Intl`, for the reason `zoned.ts` gives: locale data owns casing and
 * spacing, and has changed the space before AM/PM to U+202F in recent ICU. The
 * separator is U+00B7, and the hour is unpadded (chrono's `%-I`) while the
 * minute is padded.
 */
function formatTimeMarker(
  gapSecs: number | undefined,
  instantMs: number,
  timeZone: string,
): string {
  const naive = naiveInZone(instantMs, timeZone);
  const { year, month, day, hour } = partsOf(naive);
  const d = new Date(naive);
  const weekday = WEEKDAYS[d.getUTCDay()]!;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  const timeStr = `${weekday} ${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)} · ${hour12}:${pad2(d.getUTCMinutes())} ${meridiem}`;

  return gapSecs !== undefined && gapSecs >= TIME_GAP_THRESHOLD_SECS
    ? `[${relativeGapPhrase(gapSecs)} · ${timeStr}]`
    : `[${timeStr}]`;
}

/** Whole seconds between two instants, truncated toward zero as chrono does. */
function gapSeconds(fromMs: number, toMs: number): number {
  return Math.trunc((toMs - fromMs) / 1000);
}

/**
 * RFC 3339 shape, required before `Date.parse` is trusted.
 *
 * `Date.parse` is much more permissive than chrono's
 * `DateTime::parse_from_rfc3339`: it takes `"2026-04-04"` and
 * `"2026-04-04T12:00:00"` (reading the latter as *host-local*, which would
 * silently move a marker), where chrono rejects both for want of an offset.
 * Guarding the shape keeps "unparseable" meaning the same thing on both sides.
 */
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

/**
 * Keep the newest messages that fit, drop orphaned tool-loop heads, then
 * inject time markers.
 *
 * The newest message is always kept even when it alone blows the budget —
 * sending nothing is worse than sending too much.
 */
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

  // Either compaction archived earlier turns or this pass dropped some — both
  // mean the model is missing context and wants a date anchor. Note the orphan
  // drop above counts: shedding a leading tool_result alone earns an anchor.
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
        // Only a leading *text* block takes the marker. When the first block
        // is anything else the marker lands on `content` alone and never
        // reaches the wire, which is the Rust's behaviour, not an improvement
        // on it — see the fixture case that pins it.
        const first = pm.content_blocks[0];
        if (first !== undefined && first.type === "text") {
          pm.content_blocks = [
            { type: "text", text: `${marker}\n\n${first.text}` },
            ...pm.content_blocks.slice(1),
          ];
        }
        lastMarkerMs = currentMs;
      }
      // An unparseable timestamp leaves the anchor pending, so the next user
      // message with a readable one still gets it.
      firstUserPending = false;
    }

    if (currentMs !== undefined) prevMs = currentMs;
    result.push(pm);
  }

  return result;
}
