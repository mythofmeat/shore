import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "ai";

import type { ContentBlock, ImageRef } from "../../engine/types.ts";
import { resolveImage, resolveImageBlock, imageLabel, omissionNotice } from "../images.ts";
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
import { REASONING_OFF } from "../types.ts";

export class VercelProvider implements SidecarProvider {
  constructor(private readonly customFetch?: typeof fetch) {}

  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    let firstTokenAt = 0;
    const markFirst = () => {
      if (firstTokenAt === 0) firstTokenAt = Date.now();
    };

    const result = streamText(buildCall(req, signal, this.customFetch));
    yield { type: "start", model: req.model };

    let textAccum = "";
    let finishReason = "stop";
    let usage: Usage = emptyUsage();
    let carrierEmitted = false;
    let finalProviderMetadata: unknown;

    for await (const part of result.stream) {
      switch (part.type) {
        case "reasoning-delta":
          if (part.text.length > 0) {
            markFirst();
            yield { type: "thinking", text: part.text };
          }
          break;
        case "reasoning-end": {
          const details = openRouterReasoningDetails(part.providerMetadata);
          if (!carrierEmitted && details !== undefined) {
            carrierEmitted = true;
            yield { type: "reasoning_details", details };
          }
          break;
        }
        case "text-delta":
          if (part.text.length > 0) {
            markFirst();
            textAccum += part.text;
            yield { type: "text", text: part.text };
          }
          break;
        case "tool-call": {
          const details = openRouterReasoningDetails(part.providerMetadata);
          if (!carrierEmitted && details !== undefined) {
            carrierEmitted = true;
            yield { type: "reasoning_details", details };
          }
          markFirst();
          yield { type: "tool_use", id: part.toolCallId, name: part.toolName, input: part.input };
          break;
        }
        case "finish-step": {
          finalProviderMetadata = part.providerMetadata;
          const details = openRouterReasoningDetails(finalProviderMetadata);
          if (!carrierEmitted && details !== undefined) {
            carrierEmitted = true;
            yield { type: "reasoning_details", details };
          }
          finishReason = part.finishReason;
          usage = toUsage(part.usage, finalProviderMetadata);
          break;
        }
        case "finish": {
          finishReason = part.finishReason;
          usage = toUsage(part.totalUsage, finalProviderMetadata);
          break;
        }
        case "error":
          throw part.error;
        default:
          break;
      }
    }

    const total = Date.now() - startedAt;
    yield {
      type: "done",
      content: textAccum,
      finish_reason: mapFinishReason(finishReason),
      usage,
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
    };
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const result = await generateText(
      buildCall(req, signal, this.customFetch) as Parameters<typeof generateText>[0],
    );

    const content_blocks: ContentBlock[] = [];
    const reasoningText = result.finalStep.reasoningText;
    const reasoningDetails = openRouterReasoningDetails(result.finalStep.providerMetadata);
    if (
      (typeof reasoningText === "string" && reasoningText.length > 0) ||
      reasoningDetails !== undefined
    ) {
      content_blocks.push({
        type: "thinking",
        thinking: reasoningText ?? "",
        ...(reasoningDetails !== undefined
          ? { reasoning_details: reasoningDetails }
          : {}),
      });
    }
    if (result.text) content_blocks.push({ type: "text", text: result.text });
    for (const tc of result.toolCalls) {
      content_blocks.push({ type: "tool_use", id: tc.toolCallId, name: tc.toolName, input: tc.input });
    }

    const total = Date.now() - startedAt;
    return {
      content: result.text,
      content_blocks,
      finish_reason: mapFinishReason(result.finishReason),
      usage: toUsage(result.usage, result.finalStep.providerMetadata),
      timing: { total_ms: total, time_to_first_token_ms: total },
      model: req.model,
    };
  }
}

type VercelCall = Parameters<typeof streamText>[0];

export function buildCall(
  req: SidecarRequest,
  signal?: AbortSignal,
  customFetch?: typeof fetch,
): VercelCall {
  const call: VercelCall = {
    model: buildModel(req, customFetch),
    messages: buildMessages(req),
    maxOutputTokens: req.max_tokens,
    maxRetries: 0,
    allowSystemInMessages: true,
  };
  const instructions = systemToText(req.system);
  if (instructions) call.instructions = instructions;
  const tools = buildTools(req.tools);
  if (tools) call.tools = tools;
  if (req.temperature !== undefined) call.temperature = req.temperature;
  if (req.top_p !== undefined) call.topP = req.top_p;
  if (signal) call.abortSignal = signal;
  const providerOptions = buildProviderOptions(req);
  if (providerOptions) call.providerOptions = providerOptions;
  return call;
}

function buildModel(req: SidecarRequest, customFetch?: typeof fetch): LanguageModel {
  const settings = {
    apiKey: req.api_key,
    ...(req.base_url ? { baseURL: req.base_url } : {}),
    ...(customFetch ? { fetch: customFetch } : {}),
  };
  if (req.sdk === "openrouter") {
    return createOpenRouter({ ...settings, compatibility: "strict" }).chat(
      req.model,
      buildOpenRouterSettings(req),
    );
  }
  if (req.sdk === "deepseek") return createDeepSeek(settings)(req.model);
  return createMoonshotAI(settings)(req.model);
}

type ProviderOptionsValue = NonNullable<VercelCall["providerOptions"]>;

export function buildProviderOptions(req: SidecarRequest): ProviderOptionsValue | undefined {
  if (req.sdk === "openrouter") return undefined;
  const opts = req.provider_options ?? {};
  const inner: Record<string, unknown> = {};

  if (opts.thinking_enabled === false) {
    inner["thinking"] = { type: "disabled" };
  } else {
    const effort = opts.reasoning_effort;
    if (typeof effort === "string" && effort !== REASONING_OFF) inner["reasoningEffort"] = effort;
    const budget = opts.budget_tokens;
    if (req.sdk !== "deepseek" && typeof budget === "number" && budget > 0) {
      inner["thinking"] = { type: "enabled", budgetTokens: budget };
    }
  }

  if (Object.keys(inner).length === 0) return undefined;
  const key = req.sdk === "deepseek" ? "deepseek" : "moonshotai";
  return { [key]: inner } as ProviderOptionsValue;
}

export function buildOpenRouterSettings(req: SidecarRequest): OpenRouterChatSettings {
  const settings: OpenRouterChatSettings = {};
  const opts = req.provider_options ?? {};
  const effort = opts.reasoning_effort;
  const budget = opts.budget_tokens;

  if (opts.thinking_enabled === false || effort === REASONING_OFF) {
    settings.reasoning = { effort: "none" };
  } else if (typeof effort === "string" && effort.length > 0) {
    settings.reasoning = { effort } as NonNullable<OpenRouterChatSettings["reasoning"]>;
  } else if (typeof budget === "number" && budget > 0) {
    settings.reasoning = { max_tokens: budget };
  }

  const routing = opts.openrouter_provider;
  if (routing !== null && typeof routing === "object" && !Array.isArray(routing)) {
    settings.provider = snakeCaseKeys(routing) as NonNullable<OpenRouterChatSettings["provider"]>;
  }
  return settings;
}

function snakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)] = snakeCaseKeys(inner);
  }
  return out;
}

function buildTools(tools: ToolDefinition[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: Record<string, Tool> = {};
  for (const t of tools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.input_schema ?? EMPTY_TOOL_SCHEMA),
    });
  }
  return out;
}

function buildMessages(req: SidecarRequest): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const turn of replayableMessages(req)) {
    const norm = toTurn(turn);
    messages.push(...turnToVercel(norm, toolNames, req.sdk));
    for (const b of norm.content) {
      if (b.type === "tool_use") toolNames.set(b.id, b.name);
    }
  }
  return messages;
}

function textOf(turn: TurnMessage): string {
  return turn.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function turnToVercel(
  turn: TurnMessage,
  toolNames: Map<string, string>,
  sdk?: SidecarRequest["sdk"],
): ModelMessage[] {
  if (turn.role === "system") {
    return [{ role: "system", content: textOf(turn) }];
  }

  if (turn.role === "assistant") {
    const parts: Array<
      | { type: "reasoning"; text: string }
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];
    const thinking = turn.content.find(
      (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking",
    );
    if (sdk !== "openrouter" && thinking && thinking.thinking.length > 0) {
      parts.push({ type: "reasoning", text: thinking.thinking });
    }
    const text = textOf(turn);
    if (text) parts.push({ type: "text", text });
    for (const b of turn.content) {
      if (b.type === "tool_use") {
        parts.push({ type: "tool-call", toolCallId: b.id, toolName: b.name, input: b.input ?? {} });
      }
    }
    const reasoningDetails = thinking?.reasoning_details;
    if (parts.length === 0 && (sdk !== "openrouter" || reasoningDetails === undefined)) return [];
    const message: ModelMessage = { role: "assistant", content: parts };
    if (sdk === "openrouter" && reasoningDetails !== undefined) {
      message.providerOptions = {
        openrouter: { reasoning_details: reasoningDetails as JSONValue },
      };
    }
    return [message];
  }

  const out: ModelMessage[] = [];
  const toolParts = turn.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => {
      const toolName = toolNames.get(b.tool_use_id);
      if (toolName === undefined) {
        throw new Error(`tool_result references unknown tool_use_id: ${b.tool_use_id}`);
      }
      return {
        type: "tool-result" as const,
        toolCallId: b.tool_use_id,
        toolName,
        output: { type: "text" as const, value: toolResultText(b.content) },
      };
    });
  if (toolParts.length > 0) out.push({ role: "tool", content: toolParts });

  const userParts: Array<
    { type: "text"; text: string } | { type: "image"; image: string; mediaType: string }
  > = [];
  for (const img of imageParts(turn.images)) userParts.push(img);
  for (const b of turn.content) {
    if (b.type === "tool_result") {
      for (const image of toolResultImages(b.content)) {
        const resolution = resolveImageBlock(image.source);
        if ("omitted" in resolution) {
          userParts.push({
            type: "text",
            text: omissionNotice("a tool result image", resolution.omitted),
          });
        } else {
          userParts.push({
            type: "image",
            image: resolution.image.base64,
            mediaType: resolution.image.mediaType,
          });
        }
      }
    } else if (b.type === "text") {
      userParts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const resolution = resolveImageBlock(b.source);
      if ("omitted" in resolution) {
        userParts.push({
          type: "text",
          text: omissionNotice("an attached image", resolution.omitted),
        });
      } else {
        userParts.push({
          type: "image",
          image: resolution.image.base64,
          mediaType: resolution.image.mediaType,
        });
      }
    }
  }
  if (userParts.length > 0) out.push({ role: "user", content: userParts });
  return out;
}

function imageParts(
  images: ImageRef[] | undefined,
): Array<
  { type: "image"; image: string; mediaType: string } | { type: "text"; text: string }
> {
  if (!images || images.length === 0) return [];
  const out: Array<
    { type: "image"; image: string; mediaType: string } | { type: "text"; text: string }
  > = [];
  for (const img of images) {
    const resolution = resolveImage(img);
    if ("omitted" in resolution) {
      out.push({ type: "text", text: omissionNotice(imageLabel(img), resolution.omitted) });
      continue;
    }
    out.push({
      type: "image",
      image: resolution.image.base64,
      mediaType: resolution.image.mediaType,
    });
  }
  return out;
}

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

export function toUsage(u: LanguageModelUsage | undefined, providerMetadata?: unknown): Usage {
  const cacheRead = u?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u?.inputTokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: u?.outputTokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
  };
  const cost = openRouterCost(providerMetadata);
  if (cost !== undefined) usage.total_cost_usd = cost;
  return usage;
}

function openRouterReasoningDetails(providerMetadata: unknown): unknown[] | undefined {
  const openrouter = openRouterMetadata(providerMetadata);
  return Array.isArray(openrouter?.reasoning_details) ? openrouter.reasoning_details : undefined;
}

function openRouterCost(providerMetadata: unknown): number | undefined {
  const usage = openRouterMetadata(providerMetadata)?.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const cost = (usage as Record<string, unknown>).cost;
  return typeof cost === "number" ? cost : undefined;
}

function openRouterMetadata(providerMetadata: unknown): Record<string, unknown> | undefined {
  if (providerMetadata === null || typeof providerMetadata !== "object") return undefined;
  const openrouter = (providerMetadata as Record<string, unknown>).openrouter;
  return openrouter !== null && typeof openrouter === "object" && !Array.isArray(openrouter)
    ? (openrouter as Record<string, unknown>)
    : undefined;
}

function mapFinishReason(finish: string): string {
  switch (finish) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return finish;
  }
}
