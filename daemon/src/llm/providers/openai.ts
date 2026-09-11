import { prepareRequestImages } from "../prepare_images.ts";
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
import { REASONING_OFF } from "../types.ts";
import { effectiveCacheTtl } from "../cache_capability.ts";
import {
  NANOGPT_PROVIDER,
  nanogptPromptCaching,
  placeNanogptBreakpoints,
} from "./nanogpt_config.ts";
import { type ResolvedImage, resolveImage, resolveImageBlock, imageLabel, omissionNotice } from "../images.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  ToolDefinition,
  TurnMessage,
  Usage,
  } from "../types.ts";
import { systemToText, toolResultImages, toolResultText, toTurn } from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";
import { foldInlineSystemMessagesWithTail, translatesToAnthropic } from "../inline_system.ts";
import { parseToolArgs } from "../tool_args.ts";

export class OpenAIProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    req = await prepareRequestImages(req);
    const { client, params } = buildOpenAICall(req, true);
    const stream = (await client.chat.completions.create(
      params,
      signal ? { signal } : undefined,
    )) as AsyncIterable<ChatCompletionChunk>;
    yield* openAIStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    req = await prepareRequestImages(req);
    const startedAt = Date.now();
    const { client, params } = buildOpenAICall(req, false);
    const completion = await client.chat.completions.create(
      params,
      signal ? { signal } : undefined,
    );
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
          ...parseToolArgs(tool.function?.arguments ?? ""),
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
    if (chunk.usage) usage = extractUsage(chunk.usage);
  }

  for (const tc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    yield {
      type: "tool_use",
      id: tc[1].id,
      name: tc[1].name,
      ...parseToolArgs(tc[1].argsJson),
    };
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

export interface OpenAIMessagesWithTail {
  messages: ChatCompletionMessageParam[];
  transientTail: number[];
}

export function buildOpenAIMessagesWithTail(req: SidecarRequest): OpenAIMessagesWithTail {
  const messages: ChatCompletionMessageParam[] = [];
  const transientTail: number[] = [];
  const systemText = systemToText(req.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
    transientTail.push(0);
  }

  const replayable = replayableMessages(req);
  const folded = translatesToAnthropic(req.model)
    ? foldInlineSystemMessagesWithTail(replayable)
    : { turns: replayable, transientTail: replayable.map(() => 0) };

  folded.turns.forEach((turn, i) => {
    const emitted = turnToOpenAI(toTurn(turn));
    emitted.forEach((m, j) => {
      messages.push(m);
      const foldedBlocksLandHere = j === emitted.length - 1 && m.role === "user";
      transientTail.push(foldedBlocksLandHere ? (folded.transientTail[i] ?? 0) : 0);
    });
  });

  return { messages, transientTail };
}

export function buildOpenAIMessages(req: SidecarRequest): ChatCompletionMessageParam[] {
  return buildOpenAIMessagesWithTail(req).messages;
}

function buildOpenAICall(
  req: SidecarRequest,
  streaming: boolean,
): { client: OpenAI; params: ChatCompletionCreateParams } {
  const client = new OpenAI({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: req.base_url } : {}),
  });

  const { messages, transientTail } = buildOpenAIMessagesWithTail(req);

  const tools = toOpenAITools(req.tools);

  const params: ChatCompletionCreateParams = {
    model: req.model,
    messages,
    max_completion_tokens: req.max_tokens,
    ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  if (tools.length > 0) params.tools = tools;
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.top_p !== undefined) params.top_p = req.top_p;

  const effort = req.provider_options?.reasoning_effort;
  if (typeof effort === "string" && effort.length > 0) {
    params.reasoning_effort = (effort === REASONING_OFF
      ? "none"
      : effort) as NonNullable<ChatCompletionCreateParams["reasoning_effort"]>;
  }

  applyPromptCaching(req, params, transientTail);

  return { client, params };
}

export function applyPromptCaching(
  req: SidecarRequest,
  params: ChatCompletionCreateParams,
  transientTail: readonly number[] = [],
): void {
  const requested = req.provider_options?.cache_ttl ?? "";
  const ttl = effectiveCacheTtl(req.sdk, requested);
  if (req.context !== undefined && ttl !== requested) {
    if (ttl === "") delete req.context.cache_ttl;
    else req.context.cache_ttl = ttl;
  }
  if (ttl === "") return;
  if (req.sdk !== NANOGPT_PROVIDER) return;
  const helper = nanogptPromptCaching({ ttl });
  (params as unknown as Record<string, unknown>)["prompt_caching"] = helper;
  placeNanogptBreakpoints(params.messages ?? [], helper.ttl, transientTail);
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

export function turnToOpenAI(turn: TurnMessage): ChatCompletionMessageParam[] {
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
    const reasoning = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n\n");
    const toolUses = turn.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    const msg: ChatCompletionAssistantMessageParam = { role: "assistant" };
    if (text) msg.content = text;
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

  const out: ChatCompletionMessageParam[] = [];
  const parts: Array<OpenAITextPart | OpenAIImagePart> = imagesToOpenAIParts(turn.images);
  for (const b of turn.content) {
    if (b.type === "tool_result") {
      const toolMsg: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: toolResultText(b.content),
      };
      out.push(toolMsg);
      for (const image of toolResultImages(b.content)) {
        const resolution = resolveImageBlock(image.source);
        if ("omitted" in resolution) {
          parts.push({ type: "text", text: omissionNotice("a tool result image", resolution.omitted) });
        } else {
          parts.push(imageUrlPart(resolution.image));
        }
      }
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const resolution = resolveImageBlock(b.source);
      if ("omitted" in resolution) {
        parts.push({ type: "text", text: omissionNotice("an attached image", resolution.omitted) });
      } else {
        parts.push(imageUrlPart(resolution.image));
      }
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

function imagesToOpenAIParts(
  images: ImageRef[] | undefined,
): Array<OpenAIImagePart | OpenAITextPart> {
  if (!images || images.length === 0) return [];
  const out: Array<OpenAIImagePart | OpenAITextPart> = [];
  for (const img of images) {
    const resolution = resolveImage(img);
    if ("omitted" in resolution) {
      out.push({ type: "text", text: omissionNotice(imageLabel(img), resolution.omitted) });
      continue;
    }
    out.push(imageUrlPart(resolution.image));
  }
  return out;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
  const cacheRead = u?.cache_read_input_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
  };
  if (typeof u?.cost === "number") usage.total_cost_usd = u.cost;
  return usage;
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
