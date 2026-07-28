/**
 * OpenAI-compatible adapter (the sidecar contract shape).
 *
 * Fronts OpenAI and every OpenAI-compatible gateway — DeepSeek, Kimi (Moonshot),
 * xAI, NanoGPT, etc. — which differ only by `base_url`. It consumes a
 * `SidecarRequest` (canonical Anthropic-shape blocks, as the Rust daemon
 * assembled them) and emits the `StreamEvent` NDJSON vocabulary the daemon's
 * `StreamConsumer` parses.
 *
 * No client-side cache markers: OpenAI-compatible backends cache server-side.
 *
 * **Thinking replay is decided upstream, transmitted faithfully here.** The
 * daemon's `maybe_strip_prior_thinking` (tri-state `replay_prior_thinking`,
 * #191) controls which assistant turns still carry thinking blocks by the time
 * a request reaches this adapter; whatever survives is emitted as
 * `reasoning_content` on the corresponding assistant message. Kimi K2.5+/K3
 * are trained in preserved-thinking-history mode and degrade erratically
 * without it; backends that reject inbound `reasoning_content` (DeepSeek
 * treats it as output-only) surface an API error the user can act on by
 * setting `replay_prior_thinking = "none"` for that model — never a silent
 * drop here. The retired Rust adapter's deepseek/kimi tool-loop bug was
 * replaying reasoning in the WRONG SHAPE unconditionally; the conversion
 * regression test now pins the faithful mapping in both directions (thinking
 * block ⇄ `reasoning_content`, absent ⇄ absent).
 */

import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { foldEffort } from "../capabilities.ts";
import { type ResolvedImage, resolveImage, resolveImageBlock } from "../images.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  ToolDefinition,
  TurnMessage,
  Usage,
  WireMessage,
} from "../types.ts";
import { toolResultText, toTurn } from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";

export class OpenAIProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params } = buildOpenAICall(req, /*streaming*/ true);
    const stream = (await client.chat.completions.create(
      params,
      signal ? { signal } : undefined,
    )) as AsyncIterable<ChatCompletionChunk>;
    yield* openAIStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, params } = buildOpenAICall(req, /*streaming*/ false);
    const completion = await client.chat.completions.create(
      params,
      signal ? { signal } : undefined,
    );
    // `params.stream` is false → the SDK returns a single ChatCompletion. Its
    // discriminated union doesn't narrow on a runtime boolean, so we read it
    // through a structural view.
    const c = completion as unknown as {
      choices: Array<{
        message: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: unknown[];
        };
        finish_reason: string | null;
      }>;
      usage?: RawUsage;
    };

    const choice = c.choices[0];
    const message = choice?.message;
    const content_blocks: ContentBlock[] = [];
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      content_blocks.push({ type: "thinking", thinking: reasoning });
    }
    const text = typeof message?.content === "string" ? message.content : "";
    if (text) content_blocks.push({ type: "text", text });
    if (Array.isArray(message?.tool_calls)) {
      for (const [index, tc] of message.tool_calls.entries()) {
        const tool = tc as { id?: string; function?: { name?: string; arguments?: string } };
        content_blocks.push({
          type: "tool_use",
          id: tool.id ?? `tc_${index}`,
          name: tool.function?.name ?? "",
          input: parseArgs(tool.function?.arguments ?? ""),
        });
      }
    }

    const total = Date.now() - startedAt;
    return {
      content: text,
      content_blocks,
      finish_reason: mapStopReason(choice?.finish_reason ?? "stop"),
      usage: extractUsage(c.usage),
      timing: { total_ms: total, time_to_first_token_ms: total },
      model: req.model,
    };
  }
}

/**
 * Pure chunk → `StreamEvent` mapping. Separated from the SDK call so it can be
 * unit-tested with hand-built chunks and a fake clock.
 *
 * Emits: `start` (once), incremental `text`/`thinking`, then ONE consolidated
 * `tool_use` per call (full parsed input — not deltas), then `done`. Tool-call
 * argument fragments are accumulated internally; the daemon's `StreamConsumer`
 * expects a single `tool_use` event, not start/delta/stop.
 */
export async function* openAIStreamEvents(
  model: string,
  chunks: AsyncIterable<ChatCompletionChunk>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  yield { type: "start", model };

  const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
  let textAccum = "";
  let finishReason: string | undefined;
  let usage: Usage = emptyUsage();

  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    if (choice) {
      const delta = choice.delta as {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: ChatCompletionChunk.Choice.Delta.ToolCall[];
      };

      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
        markFirst();
        yield { type: "thinking", text: reasoningDelta };
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        markFirst();
        textAccum += delta.content;
        yield { type: "text", text: delta.content };
      }

      if (delta.tool_calls) {
        markFirst();
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let state = toolCalls.get(idx);
          if (!state) {
            state = { id: tc.id ?? `tc_${idx}`, name: tc.function?.name ?? "", argsJson: "" };
            toolCalls.set(idx, state);
          }
          if (tc.id && tc.id !== state.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (tc.function?.arguments) state.argsJson += tc.function.arguments;
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) usage = extractUsage(chunk.usage as RawUsage);
  }

  // One consolidated tool_use event per call, in index order, with full input.
  for (const tc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool_use", id: tc[1].id, name: tc[1].name, input: parseArgs(tc[1].argsJson) };
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: textAccum,
    finish_reason: mapStopReason(finishReason ?? "stop"),
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

// ── request construction ──────────────────────────────────────────────────

function buildOpenAICall(
  req: SidecarRequest,
  streaming: boolean,
): { client: OpenAI; params: ChatCompletionCreateParams } {
  const client = new OpenAI({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: req.base_url } : {}),
  });

  const messages: ChatCompletionMessageParam[] = [];
  const systemText = systemToText(req.system);
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const turn of replayableMessages(req)) messages.push(...turnToOpenAI(toTurn(turn)));

  const tools = toOpenAITools(req.tools);

  const params: ChatCompletionCreateParams = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  if (tools.length > 0) params.tools = tools;
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.top_p !== undefined) params.top_p = req.top_p;

  // reasoning_effort comes via provider_options (the daemon only sets it for
  // models that accept it). Map to the OpenAI-valid set; unknown → omit.
  const effortRaw = req.provider_options?.reasoning_effort;
  if (typeof effortRaw === "string") {
    // foldEffort only ever returns an in-domain OpenAI value (minimal/low/medium/high/xhigh/max).
    const effort = foldEffort("openai", effortRaw, req.model);
    if (effort) {
      params.reasoning_effort = effort as NonNullable<ChatCompletionCreateParams["reasoning_effort"]>;
    }
  }

  return { client, params };
}

function toOpenAITools(tools: ToolDefinition[] | undefined): ChatCompletionTool[] {
  if (!tools) return [];
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? EMPTY_TOOL_SCHEMA,
    },
  }));
}

// ── message conversion ──────────────────────────────────────────────────────

/** Canonical wire turn → the converter's turn shape (string content → block). */
function systemToText(system: SystemContent | undefined): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  // Join structured blocks; `_label`/`cache_control` are internal, dropped.
  return system.map((b) => b.text).join("\n\n");
}

/**
 * Convert one canonical turn into OpenAI chat-completion message(s). Exported
 * for the conversion regression test: assistant thinking blocks map to
 * `reasoning_content` exactly when present (the daemon's replay setting
 * already decided what survives — see the module docs), the bare `reasoning`
 * field is never emitted, and tool-call-only assistant turns must omit
 * `content` (not emit `null`).
 */
export function turnToOpenAI(turn: TurnMessage): ChatCompletionMessageParam[] {
  if (turn.role === "system") {
    // OpenAI accepts mid-history `role:"system"` natively — pass through.
    const text = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return [{ role: "system", content: text }];
  }

  if (turn.role === "assistant") {
    const text = turn.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const reasoning = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n\n");
    const toolUses = turn.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    const msg: ChatCompletionAssistantMessageParam = { role: "assistant" };
    if (text) msg.content = text;
    // `reasoning_content` is not in the OpenAI SDK's param type — it's the
    // DeepSeek/Kimi/GLM dialect extension the daemon's replay setting opted
    // into by leaving the thinking block in place.
    if (reasoning) {
      (msg as unknown as Record<string, unknown>)["reasoning_content"] = reasoning;
    }
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
    }
    return [msg];
  }

  // User turn: tool_results → one `role:tool` message each; text + images ride
  // on a single user message, in content order (the daemon already inlines
  // image blocks ahead of the text they accompany).
  const out: ChatCompletionMessageParam[] = [];
  // `turn.images` is the legacy field; the daemon inlines images as `image`
  // content blocks instead and never populates it. Honored first so anything
  // that does set it keeps images-before-text ordering.
  const parts: Array<OpenAITextPart | OpenAIImagePart> = imagesToOpenAIParts(turn.images);
  for (const b of turn.content) {
    if (b.type === "tool_result") {
      const toolMsg: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: toolResultText(b.content),
      };
      out.push(toolMsg);
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const resolved = resolveImageBlock(b.source);
      if (resolved) parts.push(imageUrlPart(resolved));
    }
  }
  if (parts.length > 0) {
    out.push({ role: "user", content: parts });
  }
  return out;
}

type OpenAITextPart = { type: "text"; text: string };
type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };

function imageUrlPart(resolved: ResolvedImage): OpenAIImagePart {
  return {
    type: "image_url",
    image_url: { url: `data:${resolved.mediaType};base64,${resolved.base64}` },
  };
}

function imagesToOpenAIParts(images: ImageRef[] | undefined): OpenAIImagePart[] {
  if (!images || images.length === 0) return [];
  const out: OpenAIImagePart[] = [];
  for (const img of images) {
    const resolved = resolveImage(img);
    if (!resolved) continue;
    out.push(imageUrlPart(resolved));
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

function extractUsage(u: RawUsage | undefined): Usage {
  // OpenAI-convention `prompt_tokens` is the TOTAL prompt, inclusive of the
  // cached portion. Our ledger/pricing follows the Anthropic convention where
  // input/cache_read/cache_creation are disjoint and summed, so subtract the
  // cache hits to leave only the cache-miss tokens in `input_tokens`. Without
  // this the cached tokens are billed twice (once at the full input rate).
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
  };
  // OpenRouter reports total spend on `usage.cost`.
  if (typeof u?.cost === "number") usage.total_cost_usd = u.cost;
  return usage;
}

function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === "") return {};
  try {
    return JSON.parse(argsJson);
  } catch {
    return {};
  }
}


function mapStopReason(finish: string): string {
  switch (finish) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return finish;
  }
}
