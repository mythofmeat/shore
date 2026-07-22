/**
 * OpenRouter adapter (the sidecar contract shape) — the single path for every
 * NON-Anthropic provider.
 *
 * Built on OpenRouter's first-party `@openrouter/sdk` client. It replaces the
 * hand-cast `openai`-SDK adapter (`openai.ts`) and the Z.ai adapter (`zai.ts`):
 * DeepSeek, Kimi (Moonshot), GLM (Z.ai), MiniMax, GPT, xAI, etc. all reach
 * OpenRouter, which normalizes each vendor's bespoke reasoning shape
 * (`reasoning_content` / `reasoning_details` / `thinking.keep` / `clear_thinking`)
 * into ONE typed `reasoningDetails` array. So there is no per-provider reasoning
 * matrix here — we round-trip one opaque structure.
 *
 * The SDK is stateless (single call). The Rust daemon still owns the tool loop,
 * conversation state, prompt assembly, and memory — this is purely the wire.
 *
 * Reasoning handling:
 * - Inbound reasoning is SURFACED as `thinking` events (display/persistence).
 * - `reasoning_details` round-trips OPAQUELY: we serialize the response's
 *   `reasoningDetails` into the thinking block's signature carrier
 *   (`thinking_signature` event), and on the next turn we replay it verbatim
 *   from the incoming thinking block. We NEVER reconstruct reasoning from
 *   thinking text — that wrong-shape reconstruction was the Rust deepseek/kimi
 *   400/hang bug. Preserving reasoning is a proven non-critical continuity win
 *   via OpenRouter (it does not crash-gate tool loops), so when the daemon does
 *   not yet carry the blob, replay is a safe no-op.
 */

import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatAssistantMessage,
  ChatMessages,
  ChatFunctionTool,
  ChatRequest,
  ChatStreamChunk,
  ChatToolMessage,
  ChatUsage,
  ReasoningDetailUnion,
} from "@openrouter/sdk/models";

import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { foldEffort } from "../capabilities.ts";
import { type ResolvedImage, resolveImage, resolveImageBlock } from "../images.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  TurnMessage,
  Usage,
  WireMessage,
} from "../types.ts";

export class OpenRouterProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, chatRequest } = buildCall(req, /*streaming*/ true);
    const stream = (await client.chat.send(
      { chatRequest: { ...chatRequest, stream: true } },
      signal ? { fetchOptions: { signal } } : undefined,
    )) as AsyncIterable<ChatStreamChunk>;
    yield* openRouterStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, chatRequest } = buildCall(req, /*streaming*/ false);
    const result = await client.chat.send(
      { chatRequest: { ...chatRequest, stream: false } },
      signal ? { fetchOptions: { signal } } : undefined,
    );
    const choice = result.choices?.[0];
    const message = choice?.message;
    const content_blocks: ContentBlock[] = [];

    if (typeof message?.reasoning === "string" && message.reasoning.length > 0) {
      const block: ContentBlock = { type: "thinking", thinking: message.reasoning };
      const sig = encodeReasoningDetails(message.reasoningDetails);
      if (sig) block.signature = sig;
      content_blocks.push(block);
    }
    const text = typeof message?.content === "string" ? message.content : "";
    if (text) content_blocks.push({ type: "text", text });
    for (const tc of message?.toolCalls ?? []) {
      content_blocks.push({
        type: "tool_use",
        id: tc.id ?? "tc_0",
        name: tc.function?.name ?? "",
        input: parseArgs(tc.function?.arguments ?? ""),
      });
    }

    const total = Date.now() - startedAt;
    return {
      content: text,
      content_blocks,
      finish_reason: mapFinishReason(choice?.finishReason ?? "stop"),
      usage: extractUsage(result.usage),
      timing: { total_ms: total, time_to_first_token_ms: total },
      model: req.model,
    };
  }
}

/**
 * Pure chunk → `StreamEvent` mapping (no network), so it is unit-testable with
 * hand-built chunks and a fake clock. Emits `start`, incremental
 * `thinking`/`text`, a single `thinking_signature` carrying the consolidated
 * `reasoningDetails` (placed at the close of the thinking run so the consumer
 * attaches it to the thinking block), ONE consolidated `tool_use` per call, then
 * `done`.
 */
export async function* openRouterStreamEvents(
  model: string,
  chunks: AsyncIterable<ChatStreamChunk>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  yield { type: "start", model };

  const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
  const reasoningDetails: ReasoningDetailUnion[] = [];
  let sawThinking = false;
  let sigEmitted = false;
  let textAccum = "";
  let finishReason: string | undefined;
  let usage: Usage = emptyUsage();

  // Emit the accumulated reasoning_details signature exactly once, while the
  // thinking block is still open (before any text/tool_use flushes it). An
  // orphan signature (no preceding thinking) would be discarded, so we gate on
  // having actually surfaced thinking.
  function* flushSignature(): Iterable<StreamEvent> {
    if (sigEmitted || !sawThinking) return;
    sigEmitted = true;
    const sig = encodeReasoningDetails(reasoningDetails);
    if (sig) yield { type: "thinking_signature", signature: sig };
  }

  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      if (typeof delta?.reasoning === "string" && delta.reasoning.length > 0) {
        markFirst();
        sawThinking = true;
        yield { type: "thinking", text: delta.reasoning };
      }
      if (Array.isArray(delta?.reasoningDetails)) reasoningDetails.push(...delta.reasoningDetails);

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        yield* flushSignature();
        markFirst();
        textAccum += delta.content;
        yield { type: "text", text: delta.content };
      }

      if (Array.isArray(delta?.toolCalls)) {
        yield* flushSignature();
        for (const tc of delta.toolCalls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
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

      if (choice.finishReason) finishReason = choice.finishReason;
    }
    if (chunk.usage) usage = extractUsage(chunk.usage);
  }

  // Thinking-only turn (no text or tool deltas): close the block now.
  yield* flushSignature();

  for (const tc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    markFirst();
    yield { type: "tool_use", id: tc[1].id, name: tc[1].name, input: parseArgs(tc[1].argsJson) };
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: textAccum,
    finish_reason: mapFinishReason(finishReason ?? "stop"),
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

// ── request construction ────────────────────────────────────────────────────

export function buildCall(
  req: SidecarRequest,
  streaming: boolean,
): { client: OpenRouter; chatRequest: ChatRequest } {
  const client = new OpenRouter({
    apiKey: req.api_key,
    ...(req.base_url ? { serverURL: req.base_url } : {}),
  });

  const messages = buildMessages(req);
  const tools = toTools(req.tools);

  const chatRequest: ChatRequest = {
    model: req.model,
    messages,
    maxTokens: req.max_tokens,
    ...(streaming ? { stream: true } : {}),
  };
  if (tools.length > 0) chatRequest.tools = tools;
  if (req.temperature !== undefined) chatRequest.temperature = req.temperature;
  if (req.top_p !== undefined) chatRequest.topP = req.top_p;

  // Explicit disable (`reasoning_effort = "off"` → `thinking_enabled = false` in
  // the daemon, issue #164): OpenRouter's `reasoning.effort = "none"` turns
  // reasoning OFF even for always-on reasoning models (GLM/Kimi/DeepSeek), where
  // simply omitting effort would leave them reasoning by default. `"none"` is a
  // first-class value of the SDK's effort enum, so this rides the typed path.
  if (req.provider_options?.["thinking_enabled"] === false) {
    chatRequest.reasoning = { effort: "none" as NonNullable<ChatRequest["reasoning"]>["effort"] };
  } else {
    const effortRaw = req.provider_options?.["reasoning_effort"];
    if (typeof effortRaw === "string") {
      // foldEffort only ever returns an in-domain OpenRouter value (minimal/low/medium/high/xhigh/max).
      const effort = foldEffort("openrouter", effortRaw, req.model);
      if (effort) {
        chatRequest.reasoning = { effort: effort as NonNullable<ChatRequest["reasoning"]>["effort"] };
      }
    }
  }

  // Provider routing is config-owned (the daemon sets openrouter_provider); pass
  // it through verbatim, never inferred from base_url.
  const routing = req.provider_options?.["openrouter_provider"];
  if (routing && typeof routing === "object") {
    chatRequest.provider = routing as ChatRequest["provider"];
  }

  return { client, chatRequest };
}

function toTools(tools: unknown[] | undefined): ChatFunctionTool[] {
  if (!tools) return [];
  return tools.map((raw) => {
    const t = raw as { name?: string; description?: string; input_schema?: unknown };
    return {
      type: "function",
      function: {
        name: t.name ?? "",
        description: t.description ?? "",
        parameters: (t.input_schema ?? {}) as Record<string, unknown>,
      },
    } as ChatFunctionTool;
  });
}

// ── message conversion ────────────────────────────────────────────────────────

function buildMessages(req: SidecarRequest): ChatMessages[] {
  const messages: ChatMessages[] = [];
  const systemText = systemToText(req.system);
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const turn of req.messages) messages.push(...turnToOpenRouter(normalizeTurn(turn)));
  return messages;
}

function normalizeTurn(turn: WireMessage): TurnMessage {
  if (typeof turn.content === "string") {
    return { role: turn.role, content: [{ type: "text", text: turn.content }] };
  }
  return { role: turn.role, content: turn.content };
}

function systemToText(system: SystemContent | undefined): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

/**
 * One canonical turn → OpenRouter chat message(s). Assistant turns replay prior
 * `reasoning_details` (decoded from the thinking block's opaque signature
 * carrier) so OpenRouter can preserve cross-turn reasoning continuity. We never
 * send thinking TEXT back as a reasoning field — only the structured opaque
 * blob, when present.
 */
export function turnToOpenRouter(turn: TurnMessage): ChatMessages[] {
  if (turn.role === "system") {
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
    const toolUses = turn.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    const thinking = turn.content.find(
      (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking",
    );

    const msg: ChatAssistantMessage = { role: "assistant" };
    if (text) msg.content = text;
    if (toolUses.length > 0) {
      msg.toolCalls = toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
    }
    const replay = decodeReasoningDetails(thinking?.signature);
    if (replay) msg.reasoningDetails = replay;
    return [{ ...msg, role: "assistant" }];
  }

  // User turn: tool_results → one `role:tool` message each; text + images ride a
  // single user message.
  const out: ChatMessages[] = [];
  for (const b of turn.content) {
    if (b.type === "tool_result") {
      const toolMsg: ChatToolMessage = { role: "tool", toolCallId: b.tool_use_id, content: b.content };
      out.push(toolMsg);
    }
  }
  // `turn.images` is the legacy field; the daemon inlines images as `image`
  // content blocks instead and never populates it. Honored first so anything
  // that does set it keeps images-before-text ordering.
  const parts: Array<TextPart | ImagePart> = imagesToParts(turn.images);
  for (const b of turn.content) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const resolved = resolveImageBlock(b.source);
      if (resolved) parts.push(imageUrlPart(resolved));
    }
  }
  if (parts.length > 0) {
    out.push({ role: "user", content: parts } as ChatMessages);
  }
  return out;
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };

function imageUrlPart(resolved: ResolvedImage): ImagePart {
  return { type: "image_url", image_url: { url: `data:${resolved.mediaType};base64,${resolved.base64}` } };
}

function imagesToParts(images: ImageRef[] | undefined): ImagePart[] {
  if (!images || images.length === 0) return [];
  const out: ImagePart[] = [];
  for (const img of images) {
    const resolved = resolveImage(img);
    if (!resolved) continue;
    out.push(imageUrlPart(resolved));
  }
  return out;
}

// ── reasoning_details opaque carrier ──────────────────────────────────────────

/** Marker so an OpenRouter reasoning blob is never mistaken for a real Anthropic
 * signature (and vice-versa). Provider provenance should already prevent
 * cross-provider replay; this is belt-and-suspenders. */
const REASONING_SIG_PREFIX = "orrd:";

function encodeReasoningDetails(details: ReasoningDetailUnion[] | null | undefined): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  return REASONING_SIG_PREFIX + JSON.stringify(details);
}

function decodeReasoningDetails(signature: string | undefined): ReasoningDetailUnion[] | undefined {
  if (typeof signature !== "string" || !signature.startsWith(REASONING_SIG_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(signature.slice(REASONING_SIG_PREFIX.length));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ReasoningDetailUnion[]) : undefined;
  } catch {
    return undefined;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function extractUsage(u: ChatUsage | undefined): Usage {
  // OpenAI-convention `promptTokens` is the TOTAL prompt, inclusive of the
  // cached portion. Our ledger/pricing treats input/cache_read as disjoint
  // buckets that are summed, so subtract the cache hits to leave only the
  // cache-miss tokens in `input_tokens` (otherwise they bill twice). Note the
  // billed cost for OpenRouter rows comes from `usage.cost` when present, but
  // the token columns must still be disjoint.
  const cached =
    (u?.promptTokensDetails as { cachedTokens?: number } | null | undefined)?.cachedTokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.promptTokens ?? 0) - cached),
    output_tokens: u?.completionTokens ?? 0,
    cache_read_tokens: cached,
    cache_creation_tokens: 0,
  };
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

function mapFinishReason(finish: string): string {
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
