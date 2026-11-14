import { type GenerateContentResponse } from "@google/genai";
import { describe, expect, test } from "bun:test";

import { buildGeminiParams, geminiStreamEvents, mergeConsecutiveRoles, translateMessages } from "../src/llm/providers/gemini.ts";
import { collect, tickingClock } from "./support/stream.ts";
import { ONE_PIXEL_GIF } from "./support/test_images.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { ProviderOptions, SidecarRequest, WireMessage } from "../src/llm/types.ts";

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

describe("stream edges", () => {
  const empty = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const run = (chunks: unknown[]) => collect(geminiStreamEvents("g", fakeChunks(chunks), tickingClock()));

  test("empty text is skipped, a single letter counts, and the first text sets the first token time", async () => {
    expect(await run([{ candidates: [{ content: { parts: [{ text: "" }, { text: "a" }] }, finishReason: "STOP" }] }])).toStrictEqual([
      { type: "start", model: "g" },
      { type: "text", text: "a" },
      { type: "done", content: "a", finish_reason: "end_turn", usage: empty, timing: { total_ms: 20, time_to_first_token_ms: 10 } },
    ]);
  });

  test("a stream with nothing in it times its first token at the end", async () => {
    expect(await run([])).toStrictEqual([
      { type: "start", model: "g" },
      { type: "done", content: "", finish_reason: "end_turn", usage: empty, timing: { total_ms: 10, time_to_first_token_ms: 10 } },
    ]);
  });

  test("a thought passes on a signature of any length, but not an empty or missing one", async () => {
    const events = await run([{ candidates: [{ content: { parts: [
      { text: "one", thought: true },
      { text: "two", thought: true, thoughtSignature: "" },
      { text: "three", thought: true, thoughtSignature: "s" },
    ] } }] }]);
    expect(events.slice(1, -1)).toStrictEqual([
      { type: "thinking", text: "one" },
      { type: "thinking", text: "two" },
      { type: "thinking", text: "three" },
      { type: "thinking_signature", signature: "s" },
    ]);
  });

  test("a lone call keeps its own id and signature, times the first token, and turns an ordinary stop into tool use", async () => {
    expect(await run([{ candidates: [{ content: { parts: [{ functionCall: { id: "call_a", name: "search", args: { q: 1 } }, thoughtSignature: "sig_a" }] }, finishReason: "STOP" }] }])).toStrictEqual([
      { type: "start", model: "g" },
      { type: "tool_use", id: "call_a", name: "search", input: { q: 1 }, thought_signature: "sig_a" },
      { type: "done", content: "", finish_reason: "tool_use", usage: empty, timing: { total_ms: 20, time_to_first_token_ms: 10 } },
    ]);
  });

  test("a call without an id or signature is numbered by its place and sent bare", async () => {
    const events = await run([{ candidates: [{ content: { parts: [{ functionCall: { name: "search", args: {} } }, { functionCall: { name: "read" } }] } }] }]);
    expect(events.slice(1, -1)).toStrictEqual([
      { type: "tool_use", id: "gemini_call_0", name: "search", input: {} },
      { type: "tool_use", id: "gemini_call_1", name: "read", input: {} },
    ]);
  });

  test("a turn cut short stays cut short even with a call in it, and a later chunk without a reason keeps it", async () => {
    const events = await run([
      { candidates: [{ content: { parts: [{ functionCall: { name: "search", args: {} } }] }, finishReason: "MAX_TOKENS" }] },
      { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 2 } });
  });
});

describe("messages", () => {
  const PNG = { type: "base64" as const, media_type: "image/gif", data: ONE_PIXEL_GIF };
  const looked = (content: string | ContentBlock[], isError?: boolean): WireMessage[] => [
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "look", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content, ...(isError === undefined ? {} : { is_error: isError }) }] },
  ];

  test("a tool's picture goes inside its response from Gemini 3 on, and beside it before", () => {
    const messages = looked([{ type: "text", text: "here" }, { type: "image", source: PNG }]);
    expect(translateMessages(messages)[1]?.parts).toStrictEqual([
      { functionResponse: { id: "call_1", name: "look", response: { result: "here" } } },
      { text: "Image from tool look (tool_call_id: call_1):" },
      { inlineData: { mimeType: "image/gif", data: ONE_PIXEL_GIF } },
    ]);
    expect(translateMessages(messages, true)[1]?.parts).toStrictEqual([
      { functionResponse: { id: "call_1", name: "look", response: { result: "here" }, parts: [{ inlineData: { mimeType: "image/gif", data: ONE_PIXEL_GIF } }] } },
    ]);
  });

  test("a picture that can't be sent leaves a notice, as the error of a tool result", () => {
    const tiff = { type: "base64" as const, media_type: "image/tiff", data: ONE_PIXEL_GIF };
    expect(translateMessages(looked([{ type: "text", text: "here" }, { type: "image", source: tiff }]), true)[1]?.parts).toStrictEqual([
      { functionResponse: { id: "call_1", name: "look", response: { error: "here\n[image omitted: a tool result image — image/tiff is not a supported format]" } } },
    ]);
    expect(translateMessages([{ role: "user", content: [{ type: "image", source: tiff }] }])).toStrictEqual([
      { role: "user", parts: [{ text: "[image omitted: an attached image — image/tiff is not a supported format]" }] },
    ]);
  });

  test("a failed tool result is sent as an error", () => {
    expect(translateMessages(looked("boom", true))[1]?.parts).toStrictEqual([{ functionResponse: { id: "call_1", name: "look", response: { error: "boom" } } }]);
  });

  test("a message left with nothing to send is dropped", () => {
    expect(translateMessages([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }, { type: "thinking", thinking: "blank", signature: "" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ])).toStrictEqual([{ role: "user", parts: [{ text: "hello\n\nagain" }] }]);
  });

  test("a signed thought and a signed call go back with their signatures", () => {
    expect(translateMessages([{ role: "assistant", content: [
      { type: "thinking", thinking: "plan", signature: "s" },
      { type: "tool_use", id: "c1", name: "search", input: { q: "x" }, thought_signature: "ts" },
      { type: "tool_use", id: "c2", name: "read", input: [] },
    ] }])).toStrictEqual([{ role: "model", parts: [
      { text: "plan", thought: true, thoughtSignature: "s" },
      { functionCall: { id: "c1", name: "search", args: { q: "x" } }, thoughtSignature: "ts" },
      { functionCall: { id: "c2", name: "read", args: {} } },
    ] }]);
  });

  test("turns of one role merge, joining plain text and keeping thoughts, pictures and what follows them apart", () => {
    const picture = { inlineData: { mimeType: "image/gif", data: ONE_PIXEL_GIF } };
    const contents = [
      { role: "user", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "b" }, picture, { text: "c" }, { text: "t", thought: true }] },
      { role: "user", parts: [{ text: "d" }] },
    ];
    mergeConsecutiveRoles(contents);
    expect(contents).toStrictEqual([{ role: "user", parts: [{ text: "a\n\nb" }, picture, { text: "c" }, { text: "t", thought: true }, { text: "d" }] }]);
  });
});

describe("how a Gemini request thinks and carries a tool's picture", () => {
  const request = (model: string, options?: ProviderOptions): SidecarRequest => ({
    sdk: "gemini", model, api_key: "k", max_tokens: 100, reasoning_replay: "all",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "look", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "here" }, { type: "image", source: { type: "base64", media_type: "image/gif", data: ONE_PIXEL_GIF } }] }] },
    ],
    ...(options === undefined ? {} : { provider_options: options }),
  });
  const built = (model: string, options?: ProviderOptions): unknown[] => {
    const params = buildGeminiParams(request(model, options));
    const sent = (params.contents as { parts?: { functionResponse?: { parts?: unknown[] } }[] }[])[1]?.parts ?? [];
    return [params.config?.thinkingConfig, sent[0]?.functionResponse?.parts === undefined ? "beside" : "inside"];
  };

  test("with no gemini_thinking_mode, or auto, the model's own generation decides: levels and pictures inside from Gemini 3 on", () => {
    expect(built("gemini-3-pro", { reasoning_effort: "high" })).toEqual([{ thinkingLevel: "HIGH" }, "inside"]);
    expect(built("gemini-2.5-flash", { reasoning_effort: "high" })).toEqual([{ thinkingBudget: -1 }, "beside"]);
    expect(built("gemini-3-pro", { reasoning_effort: "high", gemini_thinking_mode: "auto" })).toEqual([{ thinkingLevel: "HIGH" }, "inside"]);
    expect(built("gemini-2.5-flash", { reasoning_effort: "high", gemini_thinking_mode: "auto" })).toEqual([{ thinkingBudget: -1 }, "beside"]);
    expect(built("tuned-model", { reasoning_effort: "high" })).toEqual([{ thinkingBudget: -1 }, "beside"]);
    expect(built("gemini-4-pro", { reasoning_effort: "high" })).toEqual([{ thinkingLevel: "HIGH" }, "inside"]);
    expect([built("gemini-3-pro"), built("gemini-2.5-flash")]).toEqual([[undefined, "inside"], [undefined, "beside"]]);
  });

  test("level and budget say which way to think whatever the model is called", () => {
    expect(built("gemini-2.5-flash", { reasoning_effort: "low", gemini_thinking_mode: "level" })).toEqual([{ thinkingLevel: "LOW" }, "inside"]);
    expect(built("gemini-3-pro", { reasoning_effort: "low", gemini_thinking_mode: "budget" })).toEqual([{ thinkingBudget: -1 }, "beside"]);
  });

  test("a reasoning budget is sent as it is, an effort that isn't a level leaves the amount to the model, and no effort sends nothing", () => {
    expect(built("gemini-3-pro", { reasoning_effort: "high", reasoning_budget_tokens: 2048 })).toEqual([{ thinkingBudget: 2048 }, "inside"]);
    expect(built("gemini-3-pro", { reasoning_effort: "enormous" })).toEqual([{ thinkingBudget: -1 }, "inside"]);
    expect(built("gemini-3-pro", { reasoning_effort: "" })).toEqual([undefined, "inside"]);
    expect(built("gemini-3-pro", { gemini_thinking_mode: "level" })).toEqual([undefined, "inside"]);
  });
});
