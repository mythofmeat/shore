import { type GenerateContentResponse } from "@google/genai";
import { describe, expect, test } from "bun:test";

import { geminiStreamEvents, translateMessages } from "../src/llm/providers/gemini.ts";
import { collect, tickingClock } from "./support/stream.ts";

function asGeminiResponse(raw: unknown): GenerateContentResponse {
  return raw as GenerateContentResponse;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<GenerateContentResponse> {
  for (const item of arr) yield asGeminiResponse(item);
}

describe("request construction", () => {

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
      id: "call_1",
      name: "search",
      args: { q: "cats" },
    });
    expect(contents[1]?.parts?.[0]?.functionResponse).toEqual({
      id: "call_1",
      name: "search",
      response: { result: "5 results" },
    });
    expect(contents).toHaveLength(2);
    expect(contents[1]?.role).toBe("user");
    expect(contents[1]?.parts?.[1]?.text).toBe("be brief");
  });

  test("an unsigned thinking block still sends nothing", () => {
    const contents = translateMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no carrier" },
          { type: "text", text: "the answer" },
        ],
      },
    ]);

    expect(contents[0]?.parts).toHaveLength(1);
    expect(contents[0]?.parts?.[0]?.text).toBe("the answer");
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
    geminiStreamEvents("gemini-3-flash-preview", fakeChunks(chunks), tickingClock()),
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
      input_tokens: 5,
      output_tokens: 4,
      cache_read_tokens: 7,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 20, time_to_first_token_ms: 10 },
  });
});
