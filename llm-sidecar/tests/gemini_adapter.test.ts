/**
 * Gemini adapter parity tests. These pin sidecar Gemini behavior without live
 * network calls: message/tool/system translation,
 * generation-aware thinkingConfig, safety OFF settings, streaming event
 * mapping, and non-streaming response shaping.
 */

import { HarmBlockThreshold, ThinkingLevel, type GenerateContentResponse } from "@google/genai";
import { describe, expect, test } from "bun:test";

import {
  buildGeminiParams,
  detectGeminiGeneration,
  geminiGenerateResponse,
  geminiStreamEvents,
  mergeConsecutiveRoles,
  translateMessages,
} from "../src/llm/providers/gemini.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";

function req(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "gemini",
    model: "gemini-2.5-pro",
    api_key: "k",
    messages: [],
    max_tokens: 4096,
    ...over,
  };
}

function asGeminiResponse(raw: unknown): GenerateContentResponse {
  return raw as GenerateContentResponse;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<GenerateContentResponse> {
  for (const item of arr) yield asGeminiResponse(item);
}

function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("request construction", () => {
  test("detects Gemini generation from model names", () => {
    expect(detectGeminiGeneration("gemini-2.0-flash")).toBe(2);
    expect(detectGeminiGeneration("google/gemini-3-flash-preview")).toBe(3);
    expect(detectGeminiGeneration("claude-opus-4.8")).toBe(0);
  });

  test("builds config with systemInstruction, functionDeclarations, safety OFF, and gen3 thinkingLevel", () => {
    const params = buildGeminiParams(
      req({
        model: "gemini-3-flash-preview",
        system: [
          { type: "text", text: "base" },
          { type: "text", text: "style" },
        ],
        tools: [
          {
            name: "search",
            description: "Search things",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        provider_options: { reasoning_effort: "low" },
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2048,
      }),
    );

    expect(params.model).toBe("gemini-3-flash-preview");
    expect(params.config?.maxOutputTokens).toBe(2048);
    expect(params.config?.temperature).toBe(0.7);
    expect(params.config?.topP).toBe(0.9);
    expect(params.config?.systemInstruction).toEqual({
      parts: [{ text: "base" }, { text: "style" }],
    });
    expect(params.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(params.config?.safetySettings?.every((s) => s.threshold === HarmBlockThreshold.OFF)).toBe(true);
    expect(params.config?.tools as unknown).toEqual([
      {
        functionDeclarations: [
          {
            name: "search",
            description: "Search things",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      },
    ]);
  });

  test("maps explicit budget and gen2 reasoning effort to thinkingBudget", () => {
    expect(
      buildGeminiParams(req({ provider_options: { budget_tokens: 1234 } })).config?.thinkingConfig,
    ).toEqual({ thinkingBudget: 1234 });
    expect(
      buildGeminiParams(req({ provider_options: { reasoning_effort: "high" } })).config?.thinkingConfig,
    ).toEqual({ thinkingBudget: -1 });
  });

  test("translates tool_use/tool_result and inline system messages", () => {
    const contents = translateMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "search", input: { q: "cats" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "5 results" }],
      },
      { role: "system", content: [{ type: "text", text: "be brief" }] },
    ]);

    expect(contents[0]?.role).toBe("model");
    expect(contents[0]?.parts?.[0]?.functionCall).toEqual({
      name: "search",
      args: { q: "cats" },
    });
    expect(contents[1]?.parts?.[0]?.functionResponse).toEqual({
      name: "search",
      response: { result: "5 results" },
    });
    expect(contents).toHaveLength(2);
    expect(contents[1]?.role).toBe("user");
    expect(contents[1]?.parts?.[1]?.text).toBe("<system_instruction>be brief</system_instruction>");
  });

  test("merges consecutive same-role plain text without merging thoughts", () => {
    const contents = [
      { role: "model", parts: [{ text: "thinking", thought: true }] },
      { role: "model", parts: [{ text: "answer" }] },
      { role: "model", parts: [{ text: "more" }] },
    ];

    mergeConsecutiveRoles(contents);

    expect(contents).toHaveLength(1);
    const parts = contents[0]?.parts as unknown[];
    expect(parts).toEqual([
      { text: "thinking", thought: true },
      { text: "answer\n\nmore" },
    ]);
  });
});

test("maps Gemini stream chunks to StreamEvents", async () => {
  const chunks = [
    {
      candidates: [
        { content: { parts: [{ text: "reason", thought: true, thoughtSignature: "sig_1" }] } },
      ],
      usageMetadata: { promptTokenCount: 10 },
    },
    {
      candidates: [{ content: { parts: [{ text: "answer" }] } }],
    },
    {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
          finishReason: "MALFORMED_FUNCTION_CALL",
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 7,
      },
    },
  ];

  const events = await collect(
    geminiStreamEvents("gemini-3-flash-preview", fakeChunks(chunks), fakeClock()),
  );

  expect(events[0]).toEqual({ type: "start", model: "gemini-3-flash-preview" });
  expect(events[1]).toEqual({ type: "thinking", text: "reason" });
  expect(events[2]).toEqual({ type: "thinking_signature", signature: "sig_1" });
  expect(events[3]).toEqual({ type: "text", text: "answer" });
  expect(events[4]).toEqual({
    type: "tool_use",
    id: "gemini_call_0",
    name: "search",
    input: { q: "x" },
  });
  expect(events[5]).toEqual({
    type: "done",
    content: "answer",
    finish_reason: "tool_use",
    usage: {
      // promptTokenCount (12) is inclusive of the 7 cached tokens; input_tokens
      // carries only the 5 cache-miss tokens so the buckets are disjoint.
      input_tokens: 5,
      output_tokens: 4,
      cache_read_tokens: 7,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 20, time_to_first_token_ms: 10 },
  });
});

test("maps non-streaming Gemini response to GenerateResponse", () => {
  const response = asGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { text: "think", thought: true, thoughtSignature: "sig_2" },
            { text: "hello" },
            { functionCall: { name: "lookup", args: { id: 7 } } },
          ],
        },
        finishReason: "MAX_TOKENS",
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 3,
    },
  });

  expect(geminiGenerateResponse("gemini-2.5-pro", response, 77)).toEqual({
    content: "hello",
    content_blocks: [
      { type: "thinking", thinking: "think", signature: "sig_2" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "gemini_call_0", name: "lookup", input: { id: 7 } },
    ],
    finish_reason: "max_tokens",
    usage: {
      // promptTokenCount (20) less the 3 cached tokens = 17 cache-miss tokens.
      input_tokens: 17,
      output_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 77, time_to_first_token_ms: 77 },
    model: "gemini-2.5-pro",
  });
});
