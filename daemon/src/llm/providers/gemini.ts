import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse as GeminiResponse,
  type Part,
  type SafetySetting,
  type ThinkingConfig,
  type Tool,
} from "@google/genai";

import { geminiLevelName } from "../capabilities.ts";
import { resolveImageBlock, omissionNotice } from "../images.ts";
import type { ContentBlock } from "../../engine/types.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  ToolDefinition,
  Usage,
  WireMessage,
} from "../types.ts";
import { EMPTY_TOOL_SCHEMA } from "../types.ts";
import { replayableMessages } from "../replay.ts";

type GeminiSchema = NonNullable<FunctionDeclaration["parameters"]>;

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
];

export class GeminiProvider implements SidecarProvider {
  async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { client, params } = buildGeminiCall(req, signal);
    const stream = await client.models.generateContentStream(params);
    yield* geminiStreamEvents(req.model, stream);
  }

  async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const { client, params } = buildGeminiCall(req, signal);
    const response = await client.models.generateContent(params);
    return geminiGenerateResponse(req.model, response, Date.now() - startedAt);
  }
}

function buildGeminiCall(
  req: SidecarRequest,
  signal?: AbortSignal,
): { client: GoogleGenAI; params: GenerateContentParameters } {
  const httpOptions: {
    apiVersion: string;
    retryOptions: { attempts: number };
    baseUrl?: string;
  } = {
    apiVersion: "v1beta",
    retryOptions: { attempts: 1 },
  };
  if (req.base_url !== undefined) httpOptions.baseUrl = req.base_url.replace(/\/+$/, "");

  return {
    client: new GoogleGenAI({ apiKey: req.api_key, httpOptions }),
    params: buildGeminiParams(req, signal),
  };
}

export function buildGeminiParams(
  req: SidecarRequest,
  signal?: AbortSignal,
): GenerateContentParameters {
  const config = buildGeminiConfig(req, signal);
  return {
    model: req.model,
    contents: translateMessages(replayableMessages(req)),
    config,
  };
}

function buildGeminiConfig(req: SidecarRequest, signal?: AbortSignal): GenerateContentConfig {
  const config: GenerateContentConfig = {
    maxOutputTokens: req.max_tokens,
    safetySettings: safetySettings(),
  };
  if (signal !== undefined) config.abortSignal = signal;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.top_p !== undefined) config.topP = req.top_p;

  const thinkingConfig = buildThinkingConfig(req);
  if (thinkingConfig !== undefined) config.thinkingConfig = thinkingConfig;

  const tools = translateTools(req.tools);
  if (tools !== undefined) config.tools = tools;

  const systemInstruction = translateSystem(req.system);
  if (systemInstruction !== undefined) config.systemInstruction = systemInstruction;

  return config;
}

export async function* geminiStreamEvents(
  model: string,
  chunks: AsyncIterable<GeminiResponse>,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  yield { type: "start", model };

  const functionCalls: Array<{ name: string; args: unknown }> = [];
  let textAccum = "";
  let finishReason = "end_turn";
  let usage = emptyUsage();

  for await (const chunk of chunks) {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) {
        markFirst();
        if (part.thought === true) {
          yield { type: "thinking", text: part.text };
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
            yield { type: "thinking_signature", signature: part.thoughtSignature };
          }
        } else {
          textAccum += part.text;
          yield { type: "text", text: part.text };
        }
      } else if (part.functionCall !== undefined) {
        functionCalls.push({
          name: part.functionCall.name ?? "",
          args: part.functionCall.args ?? {},
        });
      }
    }

    if (candidate?.finishReason !== undefined) {
      finishReason = normalizeFinishReason(candidate.finishReason);
    }
    if (chunk.usageMetadata !== undefined) {
      usage = extractGeminiUsage(chunk.usageMetadata);
    }
  }

  for (const [idx, call] of functionCalls.entries()) {
    markFirst();
    yield { type: "tool_use", id: `gemini_call_${idx}`, name: call.name, input: call.args };
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: textAccum,
    finish_reason: finishReason,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}

export function geminiGenerateResponse(
  model: string,
  response: GeminiResponse,
  totalMs: number,
): GenerateResponse {
  const candidate = response.candidates?.[0];
  let textAccum = "";
  const content_blocks: ContentBlock[] = [];
  let toolCallIdx = 0;

  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === "string" && part.text.length > 0) {
      if (part.thought === true) {
        const block: ContentBlock = { type: "thinking", thinking: part.text };
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
          block.signature = part.thoughtSignature;
        }
        content_blocks.push(block);
      } else {
        textAccum += part.text;
        content_blocks.push({ type: "text", text: part.text });
      }
    } else if (part.functionCall !== undefined) {
      const name = part.functionCall.name ?? "";
      content_blocks.push({
        type: "tool_use",
        id: `gemini_call_${toolCallIdx++}`,
        name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  return {
    content: textAccum,
    content_blocks,
    finish_reason: normalizeFinishReason(candidate?.finishReason),
    usage: extractGeminiUsage(response.usageMetadata),
    timing: { total_ms: totalMs, time_to_first_token_ms: totalMs },
    model,
  };
}

export function translateMessages(messages: WireMessage[]): Content[] {
  const toolIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolIdToName.set(block.id, block.name);
    }
  }

  const contents: Content[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractSystemText(msg.content);
      contents.push({ role: "user", parts: [{ text: wrapInlineSystemInstruction(text) }] });
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts = translateParts(msg.content, toolIdToName);
    if (parts.length > 0) contents.push({ role, parts });
  }

  mergeConsecutiveRoles(contents);
  return contents;
}

function translateParts(content: WireMessage["content"], toolIdToName: Map<string, string>): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];

  const parts: Part[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ text: block.text });
        break;
      case "tool_use":
        parts.push({ functionCall: { name: block.name, args: toRecord(block.input) } });
        break;
      case "tool_result": {
        const name = toolIdToName.get(block.tool_use_id) ?? block.tool_use_id;
        parts.push({ functionResponse: { name, response: { result: block.content } } });
        break;
      }
      case "image": {
        const resolution = resolveImageBlock(block.source);
        if ("omitted" in resolution) {
          parts.push({ text: omissionNotice("an attached image", resolution.omitted) });
        } else {
          parts.push({
            inlineData: { mimeType: resolution.image.mediaType, data: resolution.image.base64 },
          });
        }
        break;
      }
      case "thinking":
        if (block.signature !== undefined && block.signature.length > 0) {
          parts.push({ text: block.thinking, thought: true, thoughtSignature: block.signature });
        }
        break;
      case "redacted_thinking":
        break;
    }
  }
  return parts;
}

export function mergeConsecutiveRoles(contents: Content[]): void {
  const merged: Content[] = [];

  for (const msg of contents) {
    const role = msg.role ?? "";
    const parts = msg.parts ?? [];
    const prev = merged[merged.length - 1];
    if (prev?.role !== role || prev.parts === undefined) {
      merged.push({ role, parts: [...parts] });
      continue;
    }

    for (const part of parts) {
      const isPlainText = part.text !== undefined && part.thought !== true;
      if (!isPlainText) {
        prev.parts.push(part);
        continue;
      }

      const last = prev.parts[prev.parts.length - 1];
      if (last?.text !== undefined && last.thought !== true) {
        prev.parts[prev.parts.length - 1] = {
          ...last,
          text: `${last.text ?? ""}\n\n${part.text ?? ""}`,
        };
      } else {
        prev.parts.push(part);
      }
    }
  }

  contents.splice(0, contents.length, ...merged);
}

function translateSystem(system: SystemContent | undefined): Content | undefined {
  const parts = (system ?? []).map((b) => ({ text: b.text }));
  return parts.length > 0 ? { parts } : undefined;
}

function translateTools(tools: ToolDefinition[] | undefined): Tool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (t.input_schema ?? EMPTY_TOOL_SCHEMA) as GeminiSchema,
  }));
  return [{ functionDeclarations: declarations }];
}

function buildThinkingConfig(req: SidecarRequest): ThinkingConfig | undefined {
  const opts = req.provider_options;
  if (opts === undefined) return undefined;

  const manualGeneration = opts.gemini_generation;
  const generation = manualGeneration !== undefined && manualGeneration > 0
    ? manualGeneration
    : detectGeminiGeneration(req.model);

  const budget = opts.budget_tokens;
  if (budget !== undefined) return { thinkingBudget: budget };

  const effort = opts.reasoning_effort;
  if (effort === undefined || effort.length === 0) return undefined;

  if (generation >= 3) {
    const level = geminiLevelName(effort);
    return level !== undefined ? { thinkingLevel: level } : { thinkingBudget: -1 };
  }
  return { thinkingBudget: -1 };
}

export function detectGeminiGeneration(model: string): number {
  const idx = model.indexOf("gemini-");
  if (idx < 0) return 0;
  const after = model.slice(idx + "gemini-".length);
  const digits = after.match(/^\d+/)?.[0];
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
}

function safetySettings(): SafetySetting[] {
  return SAFETY_CATEGORIES.map((category) => ({
    category,
    threshold: HarmBlockThreshold.OFF,
  }));
}

function extractSystemText(content: WireMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function wrapInlineSystemInstruction(text: string): string {
  return `<system_instruction>${text}</system_instruction>`;
}

function normalizeFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
      return "safety";
    case "RECITATION":
      return "recitation";
    case "MALFORMED_FUNCTION_CALL":
      return "tool_use";
    case "end_turn":
    case "max_tokens":
    case "tool_use":
      return reason;
    default:
      return "end_turn";
  }
}

function extractGeminiUsage(meta: GeminiResponse["usageMetadata"] | undefined): Usage {
  const cacheRead = meta?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, (meta?.promptTokenCount ?? 0) - cacheRead),
    output_tokens: meta?.candidatesTokenCount ?? 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
  };
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
