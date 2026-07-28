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
 *   4. trivial plumbing: pass `provider_options.openrouter_provider` into
 *      `body.provider`, strip a trailing `/v1` from base_url.
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
  ProviderOptions,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  ToolDefinition,
  Usage,
  WireMessage,
} from "../types.ts";
import { EMPTY_TOOL_SCHEMA, streamErrorEvent } from "../types.ts";
import { recordCacheCall, type CachePlacement } from "../forensics.ts";
import { replayableMessages } from "../replay.ts";

export class AnthropicProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params, placement } = buildAnthropicCall(req);
    const stream = (await client.messages.create(
      { ...params, stream: true } as MessageCreateParamsStreaming,
      signal ? { signal } : undefined,
    )) as AsyncIterable<RawMessageStreamEvent>;
    // Record on the terminal event — `done` and `error` both carry the usage
    // the provider billed, and a stream that died mid-flight has already paid
    // for any cache write reported in `message_start`.
    for await (const event of anthropicStreamEvents(req.model, stream)) {
      if (event.type === "done" || event.type === "error") {
        recordCacheCall(req.forensics, req.model, placement, event.usage, event.type);
      }
      yield event;
    }
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, params, placement } = buildAnthropicCall(req);
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
    const usage = anthropicUsage(message.usage);
    recordCacheCall(req.forensics, req.model, placement, usage, "generate");
    return {
      content: textAccum,
      content_blocks,
      finish_reason: message.stop_reason ?? "end_turn",
      usage,
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

function buildAnthropicCall(
  req: SidecarRequest,
): { client: Anthropic; params: AnthropicParams; placement: CachePlacement } {
  const client = new Anthropic({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: stripTrailingV1(req.base_url) } : {}),
  });
  const { params, placement } = buildAnthropicPlan(req);
  return { client, params, placement };
}

/**
 * Pure request-body builder that also reports what it decided about caching.
 *
 * Placement is computed exactly once and both returned views come from it —
 * a second implementation for reporting would be free to drift from the one
 * that actually runs, which is the whole reason the forensic log matters.
 */
export function buildAnthropicPlan(req: SidecarRequest): {
  params: AnthropicParams;
  placement: CachePlacement;
} {
  const opts = req.provider_options ?? {};
  const cacheTtl = opts.cache_ttl ?? "";
  const cacheEnabled = cacheTtl !== "";

  const converted = convertInlineSystemMessages(replayableMessages(req), req.model);
  const hasExistingMarkers = messagesHaveCacheControl(converted);

  let messages: MessageParam[];
  let system: TextBlockParam[];
  let msgBreakpoints: number[] = [];
  let sysBreakpoints: number[] = [];
  if (cacheEnabled && !hasExistingMarkers) {
    const cc = makeCacheControl(cacheTtl);
    const msgs = normalizeMessages(converted); // strip cc, string → block array
    // Placement reads the labels (the system anchor skips `memory_index`), so
    // it runs over the labelled blocks and emits provider blocks at the end.
    // The label cannot leak to the provider now: it is not on `TextBlockParam`.
    const labelled = req.system ?? [];
    const sys = systemToBlocks(labelled);
    const { msgBp, sysBp } = tsDefaultPlacement(msgs, labelled);
    placeBreakpoints(msgs, sys, cc, msgBp, sysBp);
    messages = msgs;
    system = sys;
    msgBreakpoints = msgBp;
    sysBreakpoints = sysBp;
  } else {
    messages = converted.map(toMessageParam);
    system = systemToBlocks(req.system); // no cache_control
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
  const orProvider = opts.openrouter_provider;
  if (orProvider && typeof orProvider === "object") {
    const provider: Record<string, unknown> = { ...(orProvider as Record<string, unknown>) };
    if ("order" in provider && !("allow_fallbacks" in provider)) {
      provider["allow_fallbacks"] = false;
    }
    params.provider = provider;
  }

  return {
    params,
    placement: {
      msg_breakpoints: msgBreakpoints,
      sys_breakpoints: sysBreakpoints,
      msg_count: messages.length,
      sys_blocks: system.length,
      cache_enabled: cacheEnabled,
      has_existing_markers: hasExistingMarkers,
    },
  };
}

/**
 * Pure request-body builder. Exported for the parity test, which asserts the
 * cache-breakpoint placement, thinking config, and provider routing without
 * hitting the network.
 */
export function buildAnthropicParams(req: SidecarRequest): AnthropicParams {
  return buildAnthropicPlan(req).params;
}

/** The SDK appends `/v1/messages`; Shore config writes base as `…/api/v1`, so
 * strip a trailing `/v1` to avoid `/v1/v1/messages`. Mirrors Rust's check. */
function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

// ── cache_control placement (default schedule, mirrors ts_default) ──────────
//
// This adapter owns the Anthropic breakpoint schedule. It places at most four
// markers, the provider limit: one system anchor on the last non-`memory_index`
// block, plus three message anchors at
// `[prev_frozen_boundary, frozen_boundary, last_msg]`.
//
// The load-bearing rule is that **a message anchor must sit in the frozen
// region** — strictly before the message at which the most-recent assistant
// turn begins. That boundary only ever advances, so everything before it is
// byte-stable for the life of the conversation. Anchoring the trailing turn
// itself is the bug fixed in #191: under `none` that turn loses the thinking a
// tool loop appended to it as soon as the next turn rebuilds from disk,
// rewriting the very bytes the anchor covered, and the read collapses to the
// system prefix alone. (The retired `last_turn` mode did this on *every* turn,
// tool loop or not, which is why it was removed — see `ThinkingReplay` in
// `crates/common/src/config/app.rs`.) A cache read resolves only up to a
// *placed* breakpoint, not as a free-running longest-prefix match, which is
// also why the second (older) frozen anchor is not redundant: after a
// multi-round tool loop the boundary jumps past the whole loop in one step, and
// that anchor is the only placed breakpoint left on a still-stable prefix. The
// final user message *is* anchored — it is the tail write each request pays for.
//
// One derived constraint, enforced below:
//   - A scheduled index whose message carries no `cache_control`-eligible block
//     walks back to the nearest message that has one, rather than dropping the
//     marker: `thinking` blocks reject `cache_control`, empty text blocks fail
//     the whole request, and caption-less image messages carry no text block at
//     all.

type CacheControl = { type: "ephemeral" } | { type: "ephemeral"; ttl: "1h" };

function makeCacheControl(ttl: string): CacheControl {
  if (ttl === "1h") return { type: "ephemeral", ttl };
  return { type: "ephemeral" };
}

function messagesHaveCacheControl(messages: WireMessage[]): boolean {
  return messages.some((m) =>
    m.content.some((b) => (b as { cache_control?: unknown }).cache_control !== undefined),
  );
}

/** Strip pre-existing cache_control and convert string content → block arrays
 * so the breakpoint can always land on a block. Mirrors the message half of
 * `normalize_for_caching`. */
function normalizeMessages(messages: WireMessage[]): MessageParam[] {
  return messages.map((m): MessageParam => {
    const blocks = m.content.map(toContentBlockParam);
    for (const b of blocks) delete (b as { cache_control?: unknown }).cache_control;
    return { role: m.role as "user" | "assistant", content: blocks };
  });
}

/** Last system block whose label is NOT `"memory_index"` — that block is
 * rewritten by every dreaming and compaction pass, so anchoring the system
 * breakpoint on it would throw the system prefix away each time. Returns -1
 * when there is no stable block. */
function lastStableSystemIndex(system: SystemContent): number {
  for (let i = system.length - 1; i >= 0; i--) {
    if (system[i]?.label !== "memory_index") return i;
  }
  return -1;
}

/** A user message whose content is entirely `tool_result` blocks — a tool-loop
 * continuation, not a genuine user turn. Mirrors `is_tool_result_only_user` in
 * the daemon's `content_util.rs`. */
function isToolResultOnlyUser(msg: MessageParam): boolean {
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => (b as { type?: string }).type === "tool_result");
}

/** Index at which the most-recent assistant turn begins — the first message of
 * the trailing assistant run, walking back over assistant messages and the
 * tool-result-only user messages between them and stopping at the first genuine
 * user turn. Returns `messages.length` when there is no assistant message.
 *
 * Exported for its test, which pins it against
 * `crates/daemon/tests/fixtures/turn_boundary_parity.json`. That fixture was
 * shared with a Rust implementation while `replay_prior_thinking = last_turn`
 * needed the same boundary daemon-side; the mode is gone and this is now the
 * only implementation, but the cases still pin the walk-back rules.
 *
 * Note this runs *after* `convertInlineSystemMessages`: merging a trailing
 * `role:"system"` turn into a preceding user message both removes a message and
 * can turn a tool-result-only user into a "genuine" one (it gains a text
 * block). That only ever ends a turn earlier or shortens the array, so the
 * boundary stays conservative. Do not move this call before the conversion: the
 * breakpoint must be placed on the messages that actually go on the wire. */
export function mostRecentAssistantTurnStart(messages: MessageParam[]): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return messages.length;
  let start = lastAssistant;
  while (start > 0) {
    const prev = messages[start - 1];
    if (prev === undefined) break;
    if (prev.role === "assistant" || isToolResultOnlyUser(prev)) {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

/** `[prev_frozen_boundary, frozen_boundary, last_msg]`, deduped, sorted.
 *
 * `frozen_boundary` is the message just before the trailing assistant turn.
 * `replay_prior_thinking` strips thinking from assistant turns *before* that
 * boundary, and the boundary only ever moves forward as turns are appended, so
 * `[0, boundary)` is byte-stable for the life of the conversation under every
 * replay mode. An anchor there survives the strip.
 *
 * Anchoring on the trailing turn itself (the old `last_stable_assistant`) does
 * not: under `last_turn` that turn loses its thinking blocks as soon as another
 * turn lands, rewriting the very bytes the anchor covers. Both message anchors
 * then miss and the read collapses to the system prefix alone — a full re-cache
 * of the whole conversation on every committed turn.
 *
 * `prev_frozen_boundary` is the same boundary one turn back — the genuine-user
 * boundary of the turn *before* the trailing one. Under the normal turn cadence
 * it is exactly the previous request's `frozen_boundary`, so it is redundant.
 * It earns its slot on the request right after a multi-round tool loop: while
 * the loop runs, `frozen_boundary` is pinned at the loop start, and when the
 * loop ends and a new assistant turn lands the boundary jumps *past the whole
 * loop* in one step — stripping every round's thinking at once. The new
 * `frozen_boundary` sits after that rewritten region and misses; the still-
 * stable prefix (before the loop) is only readable because this second anchor
 * is sitting on it. Compaction and dreaming loops run well past Anthropic's
 * ~20-block automatic lookback, so without it those reads collapse to the
 * system prefix. Three message anchors plus the one system anchor is exactly
 * the four-breakpoint provider limit. */
function tsMessageBreakpoints(messages: MessageParam[]): number[] {
  if (messages.length === 0) return [];
  const anchors = [messages.length - 1];
  const frozenIdx = mostRecentAssistantTurnStart(messages) - 1;
  if (frozenIdx >= 0) {
    anchors.push(frozenIdx);
    // `messages[frozenIdx]` is a genuine user turn, so slicing it off leaves
    // the preceding assistant run intact and the same walk-back finds where
    // *that* turn began. A return of `frozenIdx` means no assistant message
    // precedes the boundary (nothing older to anchor).
    const prevStart = mostRecentAssistantTurnStart(messages.slice(0, frozenIdx));
    if (prevStart < frozenIdx && prevStart - 1 >= 0) anchors.push(prevStart - 1);
  }
  return [...new Set(anchors)].sort((a, b) => a - b);
}

function tsDefaultPlacement(
  messages: MessageParam[],
  system: SystemContent,
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
  // A scheduled index whose message has no anchorable block walks back to the
  // nearest older message that does, instead of silently dropping the
  // breakpoint. Dropping it is what the frozen-boundary anchor exists to
  // prevent: `messages[frozenIdx]` is always a genuine user message, and the
  // daemon deliberately persists caption-less image messages with *no* text
  // block (`handler/task.rs`), so before `image` became anchorable an
  // image-only boundary silently reduced the schedule to the last message
  // alone — the exact shape this schedule was written to fix. An assistant
  // message of only thinking blocks is the remaining un-anchorable case.
  const placed = new Set<number>();
  for (const pos of msgBp) {
    for (let i = pos; i >= 0; i--) {
      if (placed.has(i)) break; // collapsed into an anchor already at/behind i
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      if (applyMessageBreakpoint(msg.content, cc)) {
        placed.add(i);
        break;
      }
    }
  }
}

/** Apply the breakpoint to the last text/image/tool_use/tool_result block and
 * report whether one was found (thinking blocks reject cache_control). Empty
 * text blocks are skipped as anchors: Anthropic rejects "cache_control cannot
 * be set for empty text blocks" and fails the whole request, so the breakpoint
 * walks back to the previous eligible block. */
function applyMessageBreakpoint(content: ContentBlockParam[], cc: CacheControl): boolean {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as ContentBlockParam & { cache_control?: unknown };
    if (b.type === "text") {
      if (((b as { text?: string }).text ?? "").trim() === "") continue;
      b.cache_control = cc;
      return true;
    }
    if (b.type === "image" || b.type === "tool_use" || b.type === "tool_result") {
      b.cache_control = cc;
      return true;
    }
  }
  return false;
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

/** Convert system → Anthropic text blocks. The label stays behind: it is not a
 * field on `TextBlockParam`, so it can no longer leak to the provider. */
function systemToBlocks(system: SystemContent | undefined): TextBlockParam[] {
  return (system ?? []).map((b) => ({ type: "text", text: b.text }));
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
    const text = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const wrapped = wrapInlineSystemInstruction(text);

    const prev = out[out.length - 1];
    if (prev && prev.role === "user") {
      prev.content = [...prev.content, { type: "text", text: wrapped }];
      continue;
    }
    out.push({ role: "user", content: [{ type: "text", text: wrapped }] });
  }
  return out;
}

// ── message + tool conversion ───────────────────────────────────────────────

function toMessageParam(m: WireMessage): MessageParam {
  return { role: m.role as "user" | "assistant", content: m.content.map(toContentBlockParam) };
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
      // Block-shaped results come from the daemon's generated-image replay
      // (an image plus its caption); Anthropic accepts text and image blocks
      // there, which is exactly what that path produces.
      const content: NonNullable<ToolResultBlockParam["content"]> =
        typeof b.content === "string"
          ? b.content
          : (b.content.map(toContentBlockParam) as NonNullable<ToolResultBlockParam["content"]>);
      const out: ToolResultBlockParam = { type: "tool_result", tool_use_id: b.tool_use_id, content };
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

function buildTools(tools: ToolDefinition[] | undefined): Tool[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.input_schema ?? EMPTY_TOOL_SCHEMA) as Tool["input_schema"],
  }));
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

/** Returns the thinking + output_config the target model accepts.
 * `display:"summarized"` on adaptive is REQUIRED (Opus 4.7/4.8 default
 * `omitted`, which returns empty thinking text). */
export function buildThinkingParams(
  opts: ProviderOptions,
  model: string,
  maxTokens: number,
): { thinking?: ThinkingParam; outputConfig?: { effort: NamedEffort } } {
  const effort = opts.reasoning_effort;
  const namedEffort = isEffortValue(effort) ? effort : undefined;
  const wantsAdaptive = effort === "adaptive" || namedEffort !== undefined;

  // `budget_tokens` is the only way to ask for thinking without naming an
  // effort. There is no separate boolean knob — the daemon expresses "off" as
  // `thinking_enabled: false`, which never reaches an Anthropic-family model
  // that has thinking on by default.
  const budget = opts.budget_tokens;
  const wantsEnabled = budget !== undefined;

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
