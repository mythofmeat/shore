import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatAssistantMessage,
  ChatMessages,
  ChatFunctionTool,
  ChatRequest,
  ChatResult,
  ChatStreamChunk,
  ChatToolMessage,
  ChatUsage,
  ReasoningDetailUnion,
} from "@openrouter/sdk/models";

import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { REASONING_OFF } from "../capabilities.ts";
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
import { systemToText, toolResultText, toTurn } from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";
import { parseToolArgs } from "../tool_args.ts";

export class OpenRouterProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, chatRequest } = buildCall(req, true);
    const stream = (await client.chat.send(
      { chatRequest: { ...chatRequest, stream: true } },
      signal ? { fetchOptions: { signal } } : undefined,
    )) as AsyncIterable<ChatStreamChunk>;
    yield* openRouterStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, chatRequest } = buildCall(req, false);
    const result = (await client.chat.send(
      { chatRequest: { ...chatRequest, stream: false } },
      signal ? { fetchOptions: { signal } } : undefined,
    )) as ChatResult;
    const choice = result.choices?.[0];
    const message = choice?.message;
    const content_blocks: ContentBlock[] = [];

    if (typeof message?.reasoning === "string" && message.reasoning.length > 0) {
      const block: ContentBlock = { type: "thinking", thinking: message.reasoning };
      const details = message.reasoningDetails;
      if (Array.isArray(details) && details.length > 0) block.reasoning_details = details;
      content_blocks.push(block);
    }
    const text = typeof message?.content === "string" ? message.content : "";
    if (text) content_blocks.push({ type: "text", text });
    for (const tc of message?.toolCalls ?? []) {
      content_blocks.push({
        type: "tool_use",
        id: tc.id ?? "tc_0",
        name: tc.function?.name ?? "",
        ...parseToolArgs(tc.function?.arguments ?? ""),
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

  function* flushSignature(): Iterable<StreamEvent> {
    if (sigEmitted || !sawThinking) return;
    sigEmitted = true;
    if (reasoningDetails.length > 0) {
      yield { type: "reasoning_details", details: reasoningDetails };
    }
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

  yield* flushSignature();

  for (const tc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    markFirst();
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
    finish_reason: mapFinishReason(finishReason ?? "stop"),
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

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

  if (req.provider_options?.thinking_enabled === false) {
    chatRequest.reasoning = { effort: "none" as NonNullable<ChatRequest["reasoning"]>["effort"] };
  } else {
    const effort = req.provider_options?.reasoning_effort;
    if (typeof effort === "string" && effort.length > 0) {
      const wire = effort === REASONING_OFF ? "none" : effort;
      chatRequest.reasoning = { effort: wire as NonNullable<ChatRequest["reasoning"]>["effort"] };
    }
  }

  const routing = req.provider_options?.openrouter_provider;
  if (routing && typeof routing === "object") {
    chatRequest.provider = routing;
  }

  return { client, chatRequest };
}

function toTools(tools: ToolDefinition[] | undefined): ChatFunctionTool[] {
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

function buildMessages(req: SidecarRequest): ChatMessages[] {
  const messages: ChatMessages[] = [];
  const systemText = systemToText(req.system);
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const turn of replayableMessages(req)) messages.push(...turnToOpenRouter(toTurn(turn)));
  return messages;
}

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
    const replay = thinking?.reasoning_details;
    if (Array.isArray(replay) && replay.length > 0) {
      msg.reasoningDetails = replay as ReasoningDetailUnion[];
    }
    return [{ ...msg, role: "assistant" }];
  }

  const out: ChatMessages[] = [];
  for (const b of turn.content) {
    if (b.type === "tool_result") {
      const toolMsg: ChatToolMessage = {
        role: "tool",
        toolCallId: b.tool_use_id,
        content: toolResultText(b.content),
      };
      out.push(toolMsg);
    }
  }
  const parts: Array<TextPart | ImagePart> = imagesToParts(turn.images);
  for (const b of turn.content) {
    if (b.type === "text") {
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
    out.push({ role: "user", content: parts } as ChatMessages);
  }
  return out;
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };

function imageUrlPart(resolved: ResolvedImage): ImagePart {
  return { type: "image_url", image_url: { url: `data:${resolved.mediaType};base64,${resolved.base64}` } };
}

function imagesToParts(images: ImageRef[] | undefined): Array<TextPart | ImagePart> {
  if (!images || images.length === 0) return [];
  const out: Array<TextPart | ImagePart> = [];
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

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function extractUsage(u: ChatUsage | undefined): Usage {
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
