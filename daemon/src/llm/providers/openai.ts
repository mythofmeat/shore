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
  ToolDefinition,
  TurnMessage,
  Usage,
  } from "../types.ts";
import { systemToText, toolResultText, toTurn } from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";
import { parseToolArgs } from "../tool_args.ts";

export class OpenAIProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params } = buildOpenAICall(req, true);
    const stream = (await client.chat.completions.create(
      params,
      signal ? { signal } : undefined,
    )) as AsyncIterable<ChatCompletionChunk>;
    yield* openAIStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
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
    if (chunk.usage) usage = extractUsage(chunk.usage as RawUsage);
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

  const effortRaw = req.provider_options?.reasoning_effort;
  if (typeof effortRaw === "string") {
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
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
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
