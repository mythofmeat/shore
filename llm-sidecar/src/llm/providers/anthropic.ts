/**
 * Anthropic SDK adapter (sidecar contract shape).
 *
 * Consumes a `SidecarRequest` and emits the `StreamEvent` NDJSON vocabulary.
 * Owns the Anthropic wire behavior for the daemon's canonical request shape.
 * The pieces the SDK doesn't do natively (and we therefore keep):
 *
 *   1. cache_control breakpoint placement — default schedule only (last stable
 *      system block + last-stable-assistant + last message). The
 *      `cache_depth_turns`/`cache_pinned_position`
 *      override + env vars are intentionally NOT ported (advanced tuning,
 *      unused in practice; default placement is the parity baseline).
 *   2. per-model thinking-mode selection (`thinking_caps`) — adaptive vs
 *      enabled+budget; wrong mode is a hard 400.
 *   3. inline `role:"system"` → `<system_instruction>` user wrap (the API
 *      rejects role:system in messages[]). Always-wrap today, behind a
 *      `systemMessageStrategy` seam; opus-4.8 native system messages are a
 *      tracked post-parity follow-up.
 *   4. trivial plumbing: strip `_label`, pass `provider_options.openrouter_provider`
 *      into `body.provider`, strip a trailing `/v1` from base_url.
 *
 * The SDK handles everything else: SSE, thinking/signature verbatim round-trip,
 * tool_use accumulation, retries, errors. Cache-forensics stays Rust-side.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParams,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import { claudeThinkingCaps, effortBudget } from "../capabilities.ts";
import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { resolveImage } from "../images.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  Usage,
  WireMessage,
} from "../types.ts";
import { streamErrorEvent } from "../types.ts";

export class AnthropicProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params } = buildAnthropicCall(req);
    const stream = (await client.messages.create(
      { ...params, stream: true } as MessageCreateParamsStreaming,
      signal ? { signal } : undefined,
    )) as AsyncIterable<RawMessageStreamEvent>;
    yield* anthropicStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, params } = buildAnthropicCall(req);
    const message = (await client.messages.create(
      params as Parameters<typeof client.messages.create>[0],
      signal ? { signal } : undefined,
    )) as Message;

    const content_blocks: ContentBlock[] = [];
    let textAccum = "";
    for (const block of message.content) {
      if (block.type === "text") {
        textAccum += block.text;
        content_blocks.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        content_blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.type === "redacted_thinking") {
        content_blocks.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "tool_use") {
        content_blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }

    const total = Date.now() - startedAt;
    return {
      content: textAccum,
      content_blocks,
      finish_reason: message.stop_reason ?? "end_turn",
      usage: anthropicUsage(message.usage),
      timing: { total_ms: total, time_to_first_token_ms: total },
      model: req.model,
    };
  }
}

// ── streaming event mapping (pure; injectable clock for tests) ──────────────

type AccumState =
  | { kind: "text" }
  | { kind: "thinking"; signature: string }
  | { kind: "redacted_thinking" }
  | { kind: "tool_use"; id: string; name: string; partialJson: string };

/**
 * Map the SDK's raw stream events to the `StreamEvent` contract. `start` first,
 * incremental `text`/`thinking`, `thinking_signature` at the close of a
 * thinking block (after its deltas, before the next block — where
 * `StreamConsumer` attaches it), `redacted_thinking` verbatim, ONE consolidated
 * `tool_use` per block, then `done`.
 */
export async function* anthropicStreamEvents(
  model: string,
  events: AsyncIterable<RawMessageStreamEvent>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  yield { type: "start", model };

  const accum = new Map<number, AccumState>();
  let textAccum = "";
  let stopReason = "end_turn";
  let usage: Usage = emptyUsage();

  try {
    for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        usage = anthropicUsage(event.message.usage);
        break;
      }
      case "content_block_start": {
        const blk = event.content_block;
        if (blk.type === "text") {
          accum.set(event.index, { kind: "text" });
        } else if (blk.type === "thinking") {
          accum.set(event.index, { kind: "thinking", signature: blk.signature ?? "" });
        } else if (blk.type === "tool_use") {
          accum.set(event.index, { kind: "tool_use", id: blk.id, name: blk.name, partialJson: "" });
        } else if (blk.type === "redacted_thinking") {
          accum.set(event.index, { kind: "redacted_thinking" });
          markFirst();
          yield { type: "redacted_thinking", data: blk.data };
        }
        break;
      }
      case "content_block_delta": {
        const state = accum.get(event.index);
        if (!state) break;
        const d = event.delta;
        if (d.type === "text_delta" && state.kind === "text") {
          markFirst();
          textAccum += d.text;
          yield { type: "text", text: d.text };
        } else if (d.type === "thinking_delta" && state.kind === "thinking") {
          markFirst();
          yield { type: "thinking", text: d.thinking };
        } else if (d.type === "signature_delta" && state.kind === "thinking") {
          state.signature += d.signature;
        } else if (d.type === "input_json_delta" && state.kind === "tool_use") {
          state.partialJson += d.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const state = accum.get(event.index);
        if (state?.kind === "thinking" && state.signature) {
          yield { type: "thinking_signature", signature: state.signature };
        } else if (state?.kind === "tool_use") {
          markFirst();
          yield { type: "tool_use", id: state.id, name: state.name, input: parseArgs(state.partialJson) };
        }
        break;
      }
      case "message_delta": {
        if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        usage = mergeAnthropicUsage(usage, event.usage);
        break;
      }
      case "message_stop":
        break;
    }
    }
  } catch (err) {
    // The Anthropic stream failed mid-flight. `usage` already holds the
    // cache write reported in `message_start` (which the provider bills
    // before any output), so surface it instead of letting the failure drop
    // the cost to zero. The daemon records this then still retries.
    yield streamErrorEvent(err, usage, startedAt, firstTokenAt, now);
    return;
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: textAccum,
    finish_reason: stopReason,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

// ── request construction ────────────────────────────────────────────────────

/** The wire params, plus the OpenRouter `provider` routing field the SDK type
 * doesn't model. (`output_config` IS typed by the SDK as of 0.100.1.) */
type AnthropicParams = MessageCreateParams & {
  provider?: unknown;
};

function buildAnthropicCall(req: SidecarRequest): { client: Anthropic; params: AnthropicParams } {
  const client = new Anthropic({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: stripTrailingV1(req.base_url) } : {}),
  });
  return { client, params: buildAnthropicParams(req) };
}

/**
 * Pure request-body builder. Exported for the parity test, which asserts the
 * cache-breakpoint placement, thinking config, and provider routing without
 * hitting the network.
 */
export function buildAnthropicParams(req: SidecarRequest): AnthropicParams {
  const opts = req.provider_options ?? {};
  const cacheTtl = typeof opts["cache_ttl"] === "string" ? (opts["cache_ttl"] as string) : "";
  const cacheEnabled = cacheTtl !== "";

  const converted = convertInlineSystemMessages(req.messages, req.model);
  const hasExistingMarkers = messagesHaveCacheControl(converted);

  let messages: MessageParam[];
  let system: TextBlockParam[];
  if (cacheEnabled && !hasExistingMarkers) {
    const cc = makeCacheControl(cacheTtl);
    const msgs = normalizeMessages(converted); // strip cc, string → block array
    // Keep `_label` through placement (the anchor skips memory_index by label),
    // then strip it afterward — mirrors Rust's normalize → place → strip order.
    const sys = systemToLabeledBlocks(req.system);
    const { msgBp, sysBp } = tsDefaultPlacement(msgs, sys);
    placeBreakpoints(msgs, sys, cc, msgBp, sysBp);
    for (const b of sys) delete (b as { _label?: string })._label;
    messages = msgs;
    system = sys;
  } else {
    messages = converted.map(toMessageParam);
    system = systemToBlocks(req.system); // strips _label; no cache_control
  }

  const { thinking, outputConfig } = buildThinkingParams(opts, req.model, req.max_tokens);
  const tools = buildTools(req.tools);

  const params: AnthropicParams = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
  // apply_common_params parity: temperature/top_p set unconditionally when
  // present (Rust does NOT gate them on thinking).
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.top_p !== undefined) params.top_p = req.top_p;
  if (thinking) params.thinking = thinking;
  if (outputConfig) params.output_config = outputConfig;

  // OpenRouter provider routing comes from config, not a base_url heuristic.
  const orProvider = opts["openrouter_provider"];
  if (orProvider && typeof orProvider === "object") {
    const provider: Record<string, unknown> = { ...(orProvider as Record<string, unknown>) };
    if ("order" in provider && !("allow_fallbacks" in provider)) {
      provider["allow_fallbacks"] = false;
    }
    params.provider = provider;
  }

  return params;
}

/** The SDK appends `/v1/messages`; Shore config writes base as `…/api/v1`, so
 * strip a trailing `/v1` to avoid `/v1/v1/messages`. Mirrors Rust's check. */
function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

// ── cache_control placement (default schedule, mirrors ts_default) ──────────

type CacheControl = { type: "ephemeral" } | { type: "ephemeral"; ttl: "1h" };

function makeCacheControl(ttl: string): CacheControl {
  if (ttl === "1h") return { type: "ephemeral", ttl };
  return { type: "ephemeral" };
}

function messagesHaveCacheControl(messages: WireMessage[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if ((b as { cache_control?: unknown }).cache_control !== undefined) return true;
      }
    }
  }
  return false;
}

/** Strip pre-existing cache_control and convert string content → block arrays
 * so the breakpoint can always land on a block. Mirrors the message half of
 * `normalize_for_caching`. */
function normalizeMessages(messages: WireMessage[]): MessageParam[] {
  return messages.map((m): MessageParam => {
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : m.content.map(toContentBlockParam);
    for (const b of blocks) delete (b as { cache_control?: unknown }).cache_control;
    return { role: m.role as "user" | "assistant", content: blocks };
  });
}

/** System → text blocks PRESERVING `_label` (placement reads it; stripped after). */
function systemToLabeledBlocks(
  system: SystemContent | undefined,
): Array<TextBlockParam & { _label?: string }> {
  if (system === undefined) return [];
  if (typeof system === "string") return system ? [{ type: "text", text: system }] : [];
  return system.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b._label !== undefined ? { _label: b._label } : {}),
  }));
}

/** Last system block whose `_label` is NOT `"memory_index"` (memory_index
 * churns on dreaming/compaction). Returns -1 if none. */
function lastStableSystemIndex(system: Array<{ _label?: string }>): number {
  for (let i = system.length - 1; i >= 0; i--) {
    if (system[i]?._label !== "memory_index") return i;
  }
  return -1;
}

/** `[last_stable_assistant, last_msg]`, deduped, sorted. */
function tsMessageBreakpoints(messages: MessageParam[]): number[] {
  if (messages.length === 0) return [];
  const lastIdx = messages.length - 1;
  let stableIdx = -1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      stableIdx = i;
      break;
    }
  }
  return [...new Set([stableIdx, lastIdx].filter((i) => i >= 0))].sort((a, b) => a - b);
}

function tsDefaultPlacement(
  messages: MessageParam[],
  system: Array<TextBlockParam & { _label?: string }>,
): { msgBp: number[]; sysBp: number[] } {
  const sysIdx = lastStableSystemIndex(system);
  return {
    sysBp: sysIdx >= 0 ? [sysIdx] : [],
    msgBp: tsMessageBreakpoints(messages),
  };
}

function placeBreakpoints(
  messages: MessageParam[],
  system: TextBlockParam[],
  cc: CacheControl,
  msgBp: number[],
  sysBp: number[],
): void {
  for (const idx of sysBp) {
    const block = system[idx];
    if (block) block.cache_control = cc;
  }
  for (const pos of msgBp) {
    const msg = messages[pos];
    if (msg && Array.isArray(msg.content)) applyMessageBreakpoint(msg.content, cc);
  }
}

/** Apply the breakpoint to the last text/tool_use/tool_result block (thinking
 * blocks reject cache_control). Empty text blocks are skipped as anchors:
 * Anthropic rejects "cache_control cannot be set for empty text blocks" and
 * fails the whole request, so the breakpoint walks back to the previous
 * eligible block (or is dropped if the message has none). */
function applyMessageBreakpoint(content: ContentBlockParam[], cc: CacheControl): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as ContentBlockParam & { cache_control?: unknown };
    if (b.type === "text") {
      if (((b as { text?: string }).text ?? "").trim() === "") continue;
      b.cache_control = cc;
      return;
    }
    if (b.type === "tool_use" || b.type === "tool_result") {
      b.cache_control = cc;
      return;
    }
  }
}

// ── system + inline-system handling ─────────────────────────────────────────

/** Today: always "wrap" (parity with current Rust). The seam lets opus-4.8
 * native mid-conv system messages slot in later without restructuring. */
function systemMessageStrategy(_model: string): "wrap" | "native" {
  return "wrap";
}

export function wrapInlineSystemInstruction(text: string): string {
  return `<system_instruction>${text}</system_instruction>`;
}

/** Convert system → Anthropic text blocks, dropping internal `_label`. */
function systemToBlocks(system: SystemContent | undefined): TextBlockParam[] {
  if (system === undefined) return [];
  if (typeof system === "string") {
    return system ? [{ type: "text", text: system }] : [];
  }
  return system.map((b) => ({ type: "text", text: b.text }));
}

/**
 * Convert `role:"system"` turns into wrapped `role:"user"` turns (the API
 * rejects role:system in messages[]). Merge into a preceding user turn to avoid
 * consecutive user roles. Mirrors the daemon's established inline-system wire
 * behavior.
 */
export function convertInlineSystemMessages(
  turns: WireMessage[],
  model: string,
): WireMessage[] {
  if (systemMessageStrategy(model) === "native") return turns; // not reached today
  if (!turns.some((t) => t.role === "system")) return turns;

  const out: WireMessage[] = [];
  for (const turn of turns) {
    if (turn.role !== "system") {
      out.push(turn);
      continue;
    }
    const text =
      typeof turn.content === "string"
        ? turn.content
        : turn.content
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");
    const wrapped = wrapInlineSystemInstruction(text);

    const prev = out[out.length - 1];
    if (prev && prev.role === "user") {
      if (typeof prev.content === "string") {
        prev.content = `${prev.content}\n\n${wrapped}`;
      } else {
        prev.content = [...prev.content, { type: "text", text: wrapped }];
      }
      continue;
    }
    out.push({ role: "user", content: wrapped });
  }
  return out;
}

// ── message + tool conversion ───────────────────────────────────────────────

function toMessageParam(m: WireMessage): MessageParam {
  const role = m.role as "user" | "assistant";
  if (typeof m.content === "string") return { role, content: m.content };
  return { role, content: m.content.map(toContentBlockParam) };
}

function toContentBlockParam(b: ContentBlock): ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, signature: b.signature ?? "" };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> };
    case "tool_result": {
      const out: ToolResultBlockParam = { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content };
      if (b.is_error) out.is_error = true;
      return out;
    }
    case "image":
      // Synthesized by the daemon from a message's `images` (base64 source).
      // The shape already matches Anthropic's ImageBlockParam; only the
      // media_type literal needs the same narrowing as imagesToAnthropicBlocks.
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: b.source.media_type as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: b.source.data,
        },
      };
  }
}

function buildTools(tools: unknown[] | undefined): Tool[] {
  if (!tools) return [];
  return tools.map((raw) => {
    const t = raw as { name?: string; description?: string; input_schema?: unknown };
    return {
      name: t.name ?? "",
      description: t.description ?? "",
      input_schema: (t.input_schema ?? { type: "object" }) as Tool["input_schema"],
    };
  });
}

function imagesToAnthropicBlocks(images: ImageRef[] | undefined): ContentBlockParam[] {
  if (!images || images.length === 0) return [];
  const out: ContentBlockParam[] = [];
  for (const img of images) {
    const resolved = resolveImage(img);
    if (!resolved) continue;
    out.push({
      type: "image",
      source: {
        type: "base64",
        media_type: resolved.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: resolved.base64,
      },
    });
  }
  return out;
}

// ── thinking params (port of build_thinking_params + thinking_caps) ─────────

const NAMED_EFFORT_VALUES = ["max", "xhigh", "high", "medium", "low"] as const;
type NamedEffort = (typeof NAMED_EFFORT_VALUES)[number];

function isEffortValue(s: string | undefined): s is NamedEffort {
  return s !== undefined && (NAMED_EFFORT_VALUES as readonly string[]).includes(s);
}

/** Clamp into `1024 <= budget < max_tokens`; undefined if no valid room. */
function clampEnabledBudget(requested: number, maxTokens: number): number | undefined {
  const ceiling = maxTokens - 1;
  if (ceiling < 1024) return undefined;
  return Math.min(Math.max(requested, 1024), ceiling);
}

type ThinkingParam =
  | { type: "adaptive"; display: "summarized" }
  | { type: "enabled"; budget_tokens: number };

/** Port of `build_thinking_params`: returns the thinking + output_config the
 * target model accepts. `display:"summarized"` on adaptive is REQUIRED (Opus
 * 4.7/4.8 default `omitted`, which returns empty thinking text). */
export function buildThinkingParams(
  opts: Record<string, unknown>,
  model: string,
  maxTokens: number,
): { thinking?: ThinkingParam; outputConfig?: { effort: NamedEffort } } {
  const effort = typeof opts["reasoning_effort"] === "string" ? (opts["reasoning_effort"] as string) : undefined;
  const namedEffort = isEffortValue(effort) ? effort : undefined;
  const wantsAdaptive = effort === "adaptive" || namedEffort !== undefined;

  const thinkingFlag = opts["thinking"] === true;
  const budget = typeof opts["budget_tokens"] === "number" ? (opts["budget_tokens"] as number) : undefined;
  const wantsEnabled = thinkingFlag || budget !== undefined;

  if (!wantsAdaptive && !wantsEnabled) return {};

  const caps = claudeThinkingCaps(model);
  const requestedBudget = budget;

  if (wantsAdaptive) {
    if (caps.adaptive) {
      return {
        thinking: { type: "adaptive", display: "summarized" },
        ...(namedEffort !== undefined ? { outputConfig: { effort: namedEffort } } : {}),
      };
    }
    // adaptive-incapable: map effort → budget.
    const derived = requestedBudget ?? effortBudget(effort ?? "medium");
    const b = clampEnabledBudget(derived, maxTokens);
    return b !== undefined ? { thinking: { type: "enabled", budget_tokens: b } } : {};
  }

  // budget/flag request: prefer enabled, fall back to adaptive.
  if (caps.enabled) {
    const b = clampEnabledBudget(requestedBudget ?? 1024, maxTokens);
    if (b !== undefined) return { thinking: { type: "enabled", budget_tokens: b } };
  }
  if (caps.adaptive) return { thinking: { type: "adaptive", display: "summarized" } };
  return {};
}

// ── usage ────────────────────────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function anthropicUsage(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** message_delta usage updates only the fields it carries. */
function mergeAnthropicUsage(
  prev: Usage,
  u: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): Usage {
  return {
    input_tokens: u.input_tokens ?? prev.input_tokens,
    output_tokens: u.output_tokens ?? prev.output_tokens,
    cache_read_tokens: u.cache_read_input_tokens ?? prev.cache_read_tokens,
    cache_creation_tokens: u.cache_creation_input_tokens ?? prev.cache_creation_tokens,
  };
}

function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === "") return {};
  try {
    return JSON.parse(argsJson);
  } catch {
    return {};
  }
}

// Image helper retained for when wire messages carry images.
export { imagesToAnthropicBlocks };
