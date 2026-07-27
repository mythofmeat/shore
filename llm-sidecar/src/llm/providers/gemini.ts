/**
 * Gemini SDK adapter (sidecar contract shape).
 *
 * Implements the Gemini sidecar wire behavior: canonical Anthropic-shape
 * messages become Gemini `contents`, system prompt becomes
 * `systemInstruction`, tools become `functionDeclarations`, thinking config is
 * generation-aware, safety filters are set to `OFF`, and function calls are
 * emitted as consolidated `tool_use` events.
 */

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  ThinkingLevel,
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
import { resolveImageBlock } from "../images.ts";
import type { ContentBlock } from "../../engine/types.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  SystemContent,
  Usage,
  WireMessage,
} from "../types.ts";

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
    contents: translateMessages(req.messages),
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

// ── stream / generate mapping ───────────────────────────────────────────────

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

// ── request construction ────────────────────────────────────────────────────

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
        const resolved = resolveImageBlock(block.source);
        if (resolved) {
          parts.push({ inlineData: { mimeType: resolved.mediaType, data: resolved.base64 } });
        }
        break;
      }
      case "thinking":
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

      // Only merge into the immediately preceding part when it is itself plain
      // text. Walking back past a functionCall/functionResponse would reorder
      // the turn and corrupt tool-loop sequencing.
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
  if (system === undefined) return undefined;
  if (typeof system === "string") {
    return system ? { parts: [{ text: system }] } : undefined;
  }
  const parts = system.map((b) => ({ text: b.text }));
  return parts.length > 0 ? { parts } : undefined;
}

function translateTools(tools: unknown[] | undefined): Tool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const declarations: FunctionDeclaration[] = tools.map((raw) => {
    const t = raw as { name?: string; description?: string; input_schema?: unknown };
    const declaration: FunctionDeclaration = {
      name: t.name ?? "",
      description: t.description ?? "",
    };
    declaration.parameters = (t.input_schema ?? {}) as GeminiSchema;
    return declaration;
  });
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

  // `reasoning_effort` is always a string on the wire (Rust `Option<String>`);
  // an empty one means unset, same as absent.
  const effort = opts.reasoning_effort;
  if (effort === undefined || effort.length === 0) return undefined;

  if (generation >= 3) {
    const level = thinkingLevel(effort);
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

// The accepted Gemini effort set lives in capabilities.toml (via geminiLevelName);
// this only binds each accepted name to the genai SDK's ThinkingLevel enum.
function thinkingLevel(effort: string): ThinkingLevel | undefined {
  switch (geminiLevelName(effort)) {
    case "minimal":
      return ThinkingLevel.MINIMAL;
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
    default:
      return undefined;
  }
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
  // `promptTokenCount` is the TOTAL prompt, inclusive of the cached portion
  // (`cachedContentTokenCount`). Our ledger/pricing treats input/cache_read as
  // disjoint buckets that are summed, so subtract the cache hits to leave only
  // the cache-miss tokens in `input_tokens` (otherwise they bill twice).
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
