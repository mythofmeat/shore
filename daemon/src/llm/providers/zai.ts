import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { ContentBlock } from "../../engine/types.ts";
import type { LlmError } from "../errors.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  ToolDefinition,
  TurnMessage,
  Usage,
} from "../types.ts";
import { systemToText, toTurn } from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";
import { turnToOpenAI } from "./openai.ts";
import { parseToolArgs } from "../tool_args.ts";
import { REASONING_OFF } from "../types.ts";
import { ZAI_API_BASE_URL } from "./zai_config.ts";

export type ZaiChatCompletionCreateParams = Omit<
  ChatCompletionCreateParams,
  "stream" | "max_tokens"
> & {
  stream: boolean;
  max_tokens: number;
  thinking: { type: "enabled" | "disabled"; clear_thinking?: boolean };
};

export class ZaiProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params } = buildZaiCall(req, true);
    const stream = (await client.chat.completions.create(
      params as ChatCompletionCreateParams,
      signal ? { signal } : undefined,
    )) as AsyncIterable<ChatCompletionChunk>;
    yield* zaiStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, params } = buildZaiCall(req, false);
    const completion = await client.chat.completions.create(
      params as ChatCompletionCreateParams,
      signal ? { signal } : undefined,
    );
    return zaiGenerateResponse(req.model, completion, Date.now() - startedAt);
  }
}

export function resolveZaiBaseUrl(req: SidecarRequest): string {
  return req.base_url ? trimTrailingSlash(req.base_url) : ZAI_API_BASE_URL;
}

function buildZaiCall(
  req: SidecarRequest,
  streaming: boolean,
): { client: OpenAI; params: ZaiChatCompletionCreateParams } {
  const client = new OpenAI({
    apiKey: req.api_key,
    baseURL: resolveZaiBaseUrl(req),
    maxRetries: 0,
  });
  return { client, params: buildZaiParams(req, streaming) };
}

export function buildZaiParams(
  req: SidecarRequest,
  streaming: boolean,
): ZaiChatCompletionCreateParams {
  const thinkingDisabled = req.provider_options?.thinking_enabled === false;
  const thinking: ZaiChatCompletionCreateParams["thinking"] = thinkingDisabled
    ? { type: "disabled" }
    : { type: "enabled" };
  if (!thinkingDisabled) {
    const clearThinking = req.provider_options?.zai_clear_thinking;
    if (typeof clearThinking === "boolean") thinking.clear_thinking = clearThinking;
  }

  const params: ZaiChatCompletionCreateParams = {
    model: req.model,
    messages: buildZaiMessages(req),
    max_tokens: req.max_tokens,
    stream: streaming,
    thinking,
  };

  const effort = req.provider_options?.reasoning_effort;
  if (!thinkingDisabled && typeof effort === "string" && effort !== REASONING_OFF) {
    params.reasoning_effort = effort as NonNullable<ChatCompletionCreateParams["reasoning_effort"]>;
  }

  if (streaming) params.stream_options = { include_usage: true };

  const tools = toZaiTools(req.tools);
  if (tools.length > 0) params.tools = tools;
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.top_p !== undefined) params.top_p = req.top_p;

  return params;
}

export function buildZaiMessages(req: SidecarRequest): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  const systemText = systemToText(req.system);
  if (systemText) messages.push({ role: "system", content: systemText });
  const preserveThinking =
    req.provider_options?.thinking_enabled !== false &&
    req.provider_options?.zai_clear_thinking === false;
  for (const turn of replayableMessages(req)) {
    messages.push(...turnToZai(toTurn(turn), preserveThinking));
  }
  return messages;
}

function turnToZai(turn: TurnMessage, preserveThinking: boolean): ChatCompletionMessageParam[] {
  const msgs = turnToOpenAI({
    role: turn.role,
    content: turn.content.filter((b) => b.type !== "thinking"),
    ...(turn.images ? { images: turn.images } : {}),
  });
  if (turn.role !== "assistant" || !preserveThinking || msgs.length === 0) return msgs;
  const thinking = turn.content.find(
    (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking",
  );
  const reasoning = thinking?.reasoning_content;
  if (reasoning !== undefined && reasoning.length > 0) {
    (msgs[0] as unknown as Record<string, unknown>).reasoning_content = reasoning;
  }
  return msgs;
}

export async function* zaiStreamEvents(
  requestModel: string,
  chunks: AsyncIterable<ChatCompletionChunk>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  let startSent = false;
  let model = requestModel;
  const sendStart = function* (): Iterable<StreamEvent> {
    if (startSent) return;
    startSent = true;
    yield { type: "start", model };
  };

  const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
  let textAccum = "";
  let reasoningAccum = "";
  let sawThinking = false;
  let sigEmitted = false;
  let finishReason: string | undefined;
  let usage: Usage = emptyUsage();

  const flushSignature = function* (): Iterable<StreamEvent> {
    if (sigEmitted || !sawThinking) return;
    sigEmitted = true;
    if (reasoningAccum.length > 0) {
      yield { type: "reasoning_content", reasoning: reasoningAccum };
    }
  };

  for await (const chunk of chunks) {
    if (!startSent && typeof chunk.model === "string" && chunk.model.length > 0) {
      model = chunk.model;
    }
    yield* sendStart();

    const choice = chunk.choices[0];
    if (choice) {
      const delta = choice.delta as ZaiDelta;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        markFirst();
        sawThinking = true;
        reasoningAccum += delta.reasoning_content;
        yield { type: "thinking", text: delta.reasoning_content };
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield* flushSignature();
        markFirst();
        textAccum += delta.content;
        yield { type: "text", text: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let state = toolCalls.get(idx);
          if (!state) {
            state = { id: tc.id ?? `tc_${idx}`, name: tc.function?.name ?? "", argsJson: "" };
            toolCalls.set(idx, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (tc.function?.arguments !== undefined) {
            state.argsJson += stringifyArguments(tc.function.arguments);
          }
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) usage = extractUsage(chunk.usage);
  }

  yield* sendStart();
  yield* flushSignature();

  const normalizedFinish = normalizeZaiFinishReason(finishReason);
  if (normalizedFinish === undefined) {
    throw {
      kind: "stream_errored",
      message:
        finishReason === undefined
          ? "Z.ai stream ended without a finish reason"
          : `Z.ai stream ended with unsupported finish reason '${finishReason}'`,
      usage,
      timing: {
        total_ms: now() - startedAt,
        time_to_first_token_ms: firstTokenAt === 0 ? now() - startedAt : firstTokenAt - startedAt,
      },
    } satisfies LlmError;
  }
  if (!hasTokenUsage(usage)) {
    throw {
      kind: "stream_errored",
      message: "Z.ai stream ended with zero token usage",
      usage,
      timing: {
        total_ms: now() - startedAt,
        time_to_first_token_ms: firstTokenAt === 0 ? now() - startedAt : firstTokenAt - startedAt,
      },
    } satisfies LlmError;
  }

  for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    markFirst();
    yield { type: "tool_use", id: tc.id, name: tc.name, ...parseToolArgs(tc.argsJson) };
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: textAccum,
    finish_reason: normalizedFinish,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

export function zaiGenerateResponse(
  requestModel: string,
  completion: unknown,
  totalMs: number,
): GenerateResponse {
  const c = completion as ZaiCompletion;
  const choice = c.choices[0];
  const normalizedFinish = normalizeZaiFinishReason(choice?.finish_reason);
  if (normalizedFinish === undefined) {
    throw {
      kind: "stream_errored",
      message:
        choice?.finish_reason === undefined || choice.finish_reason === null
          ? "Z.ai response ended without a finish reason"
          : `Z.ai response ended with unsupported finish reason '${choice.finish_reason}'`,
      usage: extractUsage(c.usage),
      timing: { total_ms: totalMs, time_to_first_token_ms: totalMs },
    } satisfies LlmError;
  }
  const usage = extractUsage(c.usage);
  if (!hasTokenUsage(usage)) {
    throw {
      kind: "stream_errored",
      message: "Z.ai response ended with zero token usage",
      usage,
      timing: { total_ms: totalMs, time_to_first_token_ms: totalMs },
    } satisfies LlmError;
  }
  const message = choice?.message;
  const contentBlocks: ContentBlock[] = [];

  if (typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0) {
    contentBlocks.push({
      type: "thinking",
      thinking: message.reasoning_content,
      reasoning_content: message.reasoning_content,
    });
  }

  const text = typeof message?.content === "string" ? message.content : "";
  if (text) contentBlocks.push({ type: "text", text });

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc.type !== undefined && tc.type !== "function") continue;
      const rawArgs = tc.function?.arguments;
      contentBlocks.push({
        type: "tool_use",
        id: tc.id ?? "tc_0",
        name: tc.function?.name ?? "",
        ...(typeof rawArgs === "string"
          ? parseToolArgs(rawArgs)
          : { input: rawArgs && typeof rawArgs === "object" ? rawArgs : {} }),
      });
    }
  }

  return {
    content: text,
    content_blocks: contentBlocks,
    finish_reason: normalizedFinish,
    usage,
    timing: { total_ms: totalMs, time_to_first_token_ms: totalMs },
    model: typeof c.model === "string" && c.model.length > 0 ? c.model : requestModel,
  };
}

function toZaiTools(tools: ToolDefinition[] | undefined): ChatCompletionTool[] {
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

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  cost?: number;
}

interface ZaiDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

interface ZaiCompletion {
  model?: string;
  choices: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: RawUsage;
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
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
  };
  if (typeof u?.cost === "number") usage.total_cost_usd = u.cost;
  return usage;
}

function hasTokenUsage(usage: Usage): boolean {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens +
      usage.cache_creation_tokens > 0;
}

function stringifyArguments(args: string | Record<string, unknown>): string {
  return typeof args === "string" ? args : JSON.stringify(args);
}


function normalizeZaiFinishReason(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "content_filter":
    case "sensitive":
      return "content_filter";
    case "end_turn":
    case "max_tokens":
    case "tool_use":
    case "refusal":
    case "stop_sequence":
      return reason;
    case "network_error":
    default:
      return undefined;
  }
}
