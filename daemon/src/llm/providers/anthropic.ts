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

import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { resolveImage, imageLabel, omissionNotice } from "../images.ts";
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
import {
  ANTHROPIC_CACHE_CONTROL_LIMIT,
  recordCacheCall,
  type CachePlacement,
} from "../../cache/forensics.ts";
import { replayableMessages } from "../replay.ts";
import { cacheBoundaryIndex } from "../system_boundary.ts";
import { effectiveCacheTtl } from "../cache_capability.ts";
import { anthropicClientFor } from "./anthropic_client.ts";
import { parseToolArgs } from "../tool_args.ts";

type ThinkingDisplay = NonNullable<ProviderOptions["thinking_display"]>;

export class AnthropicProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params, placement } = buildAnthropicCall(req);
    const stream = (await client.messages.create(
      { ...params, stream: true } as MessageCreateParamsStreaming,
      signal ? { signal } : undefined,
    )) as AsyncIterable<RawMessageStreamEvent>;
    for await (const event of anthropicStreamEvents(req.model, stream)) {
      if (event.type === "done" || event.type === "error") {
        recordCacheCall(req.context, req.model, placement, event.usage, event.type);
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
    recordCacheCall(req.context, req.model, placement, usage, "generate");
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

type AccumState =
  | { kind: "text" }
  | { kind: "thinking"; signature: string }
  | { kind: "redacted_thinking" }
  | { kind: "tool_use"; id: string; name: string; partialJson: string };

export interface TurnAccumulator {
  text: string;
  stopReason: string;
  usage: Usage;
}

export function newTurnAccumulator(): TurnAccumulator {
  return { text: "", stopReason: "end_turn", usage: emptyUsage() };
}

export async function* anthropicContentEvents(
  events: AsyncIterable<RawMessageStreamEvent>,
  acc: TurnAccumulator,
): AsyncIterable<StreamEvent> {
  const accum = new Map<number, AccumState>();
  {
    for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        acc.usage = anthropicUsage(event.message.usage);
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
          yield { type: "redacted_thinking", data: blk.data };
        }
        break;
      }
      case "content_block_delta": {
        const state = accum.get(event.index);
        if (!state) break;
        const d = event.delta;
        if (d.type === "text_delta" && state.kind === "text") {
          acc.text += d.text;
          yield { type: "text", text: d.text };
        } else if (d.type === "thinking_delta" && state.kind === "thinking") {
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
          yield {
            type: "tool_use",
            id: state.id,
            name: state.name,
            ...parseToolArgs(state.partialJson),
          };
        }
        break;
      }
      case "message_delta": {
        if (event.delta.stop_reason) acc.stopReason = event.delta.stop_reason;
        acc.usage = mergeAnthropicUsage(acc.usage, event.usage);
        break;
      }
      case "message_stop":
        break;
    }
    }
  }
}

export const marksFirstToken = (event: StreamEvent): boolean =>
  event.type !== "thinking_signature";

export async function* anthropicStreamEvents(
  model: string,
  events: AsyncIterable<RawMessageStreamEvent>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const acc = newTurnAccumulator();

  yield { type: "start", model };

  try {
    for await (const event of anthropicContentEvents(events, acc)) {
      if (firstTokenAt === 0 && marksFirstToken(event)) firstTokenAt = now();
      yield event;
    }
  } catch (err) {
    yield streamErrorEvent(err, acc.usage, startedAt, firstTokenAt, now);
    return;
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: acc.text,
    finish_reason: acc.stopReason,
    usage: acc.usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

type AnthropicParams = MessageCreateParams & {
  provider?: unknown;
};

function buildAnthropicCall(
  req: SidecarRequest,
): { client: Anthropic; params: AnthropicParams; placement: CachePlacement } {
  const client = anthropicClientFor(req);
  const { params, placement } = buildAnthropicPlan(req);
  return { client, params, placement };
}

export function buildAnthropicPlan(req: SidecarRequest): {
  params: AnthropicParams;
  placement: CachePlacement;
} {
  const opts = req.provider_options ?? {};
  const cacheTtl = effectiveCacheTtl(req.sdk, req.base_url, opts.cache_ttl ?? "");
  const cacheEnabled = cacheTtl !== "";
  if (req.context !== undefined && cacheTtl !== (opts.cache_ttl ?? "")) {
    if (cacheTtl === "") delete req.context.cache_ttl;
    else req.context.cache_ttl = cacheTtl;
  }

  const converted = convertInlineSystemMessages(replayableMessages(req), req.model);
  const hasExistingMarkers = messagesHaveCacheControl(converted);

  let messages: MessageParam[];
  let system: TextBlockParam[];
  let msgBreakpoints: number[] = [];
  let sysBreakpoints: number[] = [];
  let tally: BreakpointTally = {
    requested: 0,
    placed: 0,
    droppedNoAnchor: 0,
    droppedOverLimit: 0,
  };
  if (cacheEnabled) {
    const msgs = normalizeMessages(converted);
    const labelled = req.system ?? [];
    const sys = systemToBlocks(labelled);
    const placement = applyDefaultPlacement(msgs, sys, labelled, cacheTtl);
    const { msgBp, sysBp } = placement;
    tally = placement.tally;
    messages = msgs;
    system = sys;
    msgBreakpoints = msgBp;
    sysBreakpoints = sysBp;
  } else {
    messages = converted.map(toMessageParam);
    system = systemToBlocks(req.system);
  }

  const { thinking, outputConfig } = buildThinkingParams(
    opts,
    req.model,
    req.max_tokens,
    opts.thinking_display,
  );
  const tools = buildTools(req.tools);

  const params: AnthropicParams = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.top_p !== undefined) params.top_p = req.top_p;
  if (thinking) params.thinking = thinking;
  if (outputConfig) params.output_config = outputConfig;

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
      breakpoints_requested: tally.requested,
      breakpoints_placed: tally.placed,
      breakpoints_dropped_no_anchor: tally.droppedNoAnchor,
      breakpoints_dropped_over_limit: tally.droppedOverLimit,
    },
  };
}

export function buildAnthropicParams(req: SidecarRequest): AnthropicParams {
  return buildAnthropicPlan(req).params;
}

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

function normalizeMessages(messages: WireMessage[]): MessageParam[] {
  return messages.map((m): MessageParam => {
    const blocks = m.content.map(toContentBlockParam);
    for (const b of blocks) delete (b as { cache_control?: unknown }).cache_control;
    return { role: m.role as "user" | "assistant", content: blocks };
  });
}



function isToolResultOnlyUser(msg: MessageParam): boolean {
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => (b as { type?: string }).type === "tool_result");
}

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

function tsMessageBreakpoints(messages: MessageParam[]): number[] {
  if (messages.length === 0) return [];
  const anchors = [messages.length - 1];
  const frozenIdx = mostRecentAssistantTurnStart(messages) - 1;
  if (frozenIdx >= 0) {
    anchors.push(frozenIdx);
    const prevStart = mostRecentAssistantTurnStart(messages.slice(0, frozenIdx));
    if (prevStart < frozenIdx && prevStart - 1 >= 0) anchors.push(prevStart - 1);
  }
  return [...new Set(anchors)].sort((a, b) => a - b);
}

function tsDefaultPlacement(
  messages: MessageParam[],
  system: SystemContent,
): { msgBp: number[]; sysBp: number[] } {
  const sysIdx = cacheBoundaryIndex(system);
  return {
    sysBp: sysIdx >= 0 ? [sysIdx] : [],
    msgBp: tsMessageBreakpoints(messages),
  };
}

export interface BreakpointTally {
  requested: number;
  placed: number;
  droppedNoAnchor: number;
  droppedOverLimit: number;
}

export function placeBreakpoints(
  messages: MessageParam[],
  system: TextBlockParam[],
  cc: CacheControl,
  msgBp: number[],
  sysBp: number[],
): BreakpointTally {
  const tally: BreakpointTally = {
    requested: msgBp.length + sysBp.length,
    placed: 0,
    droppedNoAnchor: 0,
    droppedOverLimit: 0,
  };

  const atLimit = (): boolean => tally.placed >= ANTHROPIC_CACHE_CONTROL_LIMIT;

  for (const idx of sysBp) {
    const block = system[idx];
    if (!block) {
      tally.droppedNoAnchor += 1;
      continue;
    }
    if (atLimit()) {
      tally.droppedOverLimit += 1;
      continue;
    }
    block.cache_control = cc;
    tally.placed += 1;
  }

  const placed = new Set<number>();
  for (const pos of msgBp) {
    if (atLimit()) {
      tally.droppedOverLimit += 1;
      continue;
    }
    let landed = false;
    for (let i = pos; i >= 0; i--) {
      if (placed.has(i)) break;
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      if (applyMessageBreakpoint(msg.content, cc)) {
        placed.add(i);
        tally.placed += 1;
        landed = true;
        break;
      }
    }
    if (!landed) tally.droppedNoAnchor += 1;
  }

  return warnIfDropped(tally);
}

function warnIfDropped(tally: BreakpointTally): BreakpointTally {
  const dropped = tally.droppedNoAnchor + tally.droppedOverLimit;
  if (dropped === 0) return tally;
  console.warn(
    `shore: dropped ${String(dropped)} cache breakpoint(s) of ` +
      `${String(tally.requested)} requested — ${String(tally.droppedNoAnchor)} had no block ` +
      `that would take a marker, ${String(tally.droppedOverLimit)} exceeded the ` +
      `${String(ANTHROPIC_CACHE_CONTROL_LIMIT)} the API allows per request`,
  );
  return tally;
}

export function clearCacheMarkers(
  messages: MessageParam[],
  system: TextBlockParam[],
): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      delete (block as { cache_control?: unknown }).cache_control;
    }
  }
  for (const block of system) {
    delete (block as { cache_control?: unknown }).cache_control;
  }
}

export function applyDefaultPlacement(
  messages: MessageParam[],
  system: TextBlockParam[],
  labelled: SystemContent,
  cacheTtl: string,
): { msgBp: number[]; sysBp: number[]; tally: BreakpointTally } {
  const cc = makeCacheControl(cacheTtl);
  const { msgBp, sysBp } = tsDefaultPlacement(messages, labelled);
  const tally = placeBreakpoints(messages, system, cc, msgBp, sysBp);
  return { msgBp, sysBp, tally };
}

export function placeContinuationBreakpoints(
  messages: MessageParam[],
  system: TextBlockParam[],
  labelled: SystemContent,
  cacheTtl: string,
): { msgBp: number[]; sysBp: number[] } {
  if (cacheTtl === "") return { msgBp: [], sysBp: [] };

  clearCacheMarkers(messages, system);
  const { msgBp, sysBp } = applyDefaultPlacement(messages, system, labelled, cacheTtl);
  return { msgBp, sysBp };
}

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

function systemMessageStrategy(_model: string): "wrap" | "native" {
  return "wrap";
}

function wrapInlineSystemInstruction(text: string): string {
  return `<system_instruction>${text}</system_instruction>`;
}

function systemToBlocks(system: SystemContent | undefined): TextBlockParam[] {
  return (system ?? []).map((b) => ({ type: "text", text: b.text }));
}

function convertInlineSystemMessages(
  turns: WireMessage[],
  model: string,
): WireMessage[] {
  if (systemMessageStrategy(model) === "native") return turns;
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
      const content: NonNullable<ToolResultBlockParam["content"]> =
        typeof b.content === "string"
          ? b.content
          : (b.content.map(toContentBlockParam) as NonNullable<ToolResultBlockParam["content"]>);
      const out: ToolResultBlockParam = { type: "tool_result", tool_use_id: b.tool_use_id, content };
      if (b.is_error) out.is_error = true;
      return out;
    }
    case "image":
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
    const resolution = resolveImage(img);
    if ("omitted" in resolution) {
      out.push({ type: "text", text: omissionNotice(imageLabel(img), resolution.omitted) });
      continue;
    }
    out.push({
      type: "image",
      source: {
        type: "base64",
        media_type: resolution.image.mediaType as
          | "image/png"
          | "image/jpeg"
          | "image/webp"
          | "image/gif",
        data: resolution.image.base64,
      },
    });
  }
  return out;
}

const NAMED_EFFORT_VALUES = ["max", "xhigh", "high", "medium", "low"] as const;
type NamedEffort = (typeof NAMED_EFFORT_VALUES)[number];

function isEffortValue(s: string | undefined): s is NamedEffort {
  return s !== undefined && (NAMED_EFFORT_VALUES as readonly string[]).includes(s);
}

function clampEnabledBudget(requested: number, maxTokens: number): number | undefined {
  const ceiling = maxTokens - 1;
  if (ceiling < 1024) return undefined;
  return Math.min(Math.max(requested, 1024), ceiling);
}

type ThinkingParam =
  | { type: "adaptive"; display: ThinkingDisplay }
  | { type: "enabled"; budget_tokens: number };

export function buildThinkingParams(
  opts: ProviderOptions,
  model: string,
  maxTokens: number,
  display: ThinkingDisplay = "summarized",
): { thinking?: ThinkingParam; outputConfig?: { effort: NamedEffort } } {
  const effort = opts.reasoning_effort;
  const namedEffort = isEffortValue(effort) ? effort : undefined;
  const wantsAdaptive = effort === "adaptive" || namedEffort !== undefined;

  const budget = opts.budget_tokens;

  if (budget !== undefined) {
    const b = clampEnabledBudget(budget, maxTokens);
    if (b !== undefined) return { thinking: { type: "enabled", budget_tokens: b } };
    return {};
  }

  if (!wantsAdaptive) return {};

  return {
    thinking: { type: "adaptive", display },
    ...(namedEffort !== undefined ? { outputConfig: { effort: namedEffort } } : {}),
  };
}

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


export { imagesToAnthropicBlocks };
