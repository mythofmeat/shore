import { describe, expect, test } from "bun:test";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { buildZaiMessages, zaiGenerateResponse, zaiStreamEvents } from "../src/llm/providers/zai.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { rejectionOf } from "./support/outcome.ts";
import { collect, tickingClock, timedChunks } from "./support/stream.ts";

function req(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "zai",
    model: "glm-5.1",
    api_key: "k",
    provider_key: "zai-api",
    messages: [],
    max_tokens: 4096,
    reasoning_replay: "all",
    ...over,
  };
}

function asChunk(raw: unknown): ChatCompletionChunk {
  return raw as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const item of arr) yield asChunk(item);
}

describe("request construction", () => {

  test("never replays a foreign provider's carrier as Z.ai reasoning", () => {
    const messages = buildZaiMessages(
      req({
        provider_options: { zai_clear_reasoning: false },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "or chain", reasoning_details: [{ text: "or chain" }] },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    ) as unknown as Array<Record<string, unknown>>;

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });
});

test("maps Z.ai stream chunks to StreamEvents", async () => {
  const chunks = [
    {
      model: "glm-5.1-plus",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "think", content: "Hello " },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "lookup", arguments: '{"id":' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: "world", tool_calls: [{ index: 0, function: { arguments: "7}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
        cost: 0.0012,
      },
    },
  ];

  const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks(chunks), tickingClock()));

  expect(events[0]).toEqual({ type: "start", model: "glm-5.1-plus" });
  expect(events[1]).toEqual({ type: "thinking", text: "think" });
  expect(events[2]).toEqual({ type: "reasoning_content", reasoning: "think" });
  expect(events[3]).toEqual({ type: "text", text: "Hello " });
  expect(events[4]).toEqual({ type: "text", text: "world" });
  expect(events[5]).toEqual({
    type: "tool_use",
    id: "call_1",
    name: "lookup",
    input: { id: 7 },
  });
  expect(events[6]).toEqual({
    type: "done",
    content: "Hello world",
    finish_reason: "tool_use",
    usage: {
      input_tokens: 8,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_tokens: 12,
      total_cost_usd: 0.0012,
    },
    timing: { total_ms: 20, time_to_first_token_ms: 10 },
  });
});

test("rejects streams that end without terminal metadata", async () => {
  expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([]), tickingClock()))))
    .toMatchObject({
      kind: "stream_errored",
      message: "Z.ai stream ended without a finish reason",
    });

  expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([{
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
  }]), tickingClock())))).toMatchObject({
    kind: "stream_errored",
    message: "Z.ai stream ended without a finish reason",
  });
});

const usage = { prompt_tokens: 3, completion_tokens: 2 };
const stop = (extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage, ...extra });

describe("the start of a stream names the model that answers", () => {
  test("the first chunk's model if it gives one, otherwise the model asked for", async () => {
    const startOf = async (first: Record<string, unknown>): Promise<unknown> =>
      (await collect(zaiStreamEvents("glm-5.1", fakeChunks([{ choices: [], ...first }, stop({ model: "later" })]), tickingClock())))[0];
    expect(await startOf({ model: "g" })).toEqual({ type: "start", model: "g" });
    expect(await startOf({ model: "" })).toEqual({ type: "start", model: "glm-5.1" });
    expect(await startOf({})).toEqual({ type: "start", model: "glm-5.1" });
  });
});

describe("streamed replies", () => {
  test("one-character deltas count, empty ones don't, and the reasoning is summed up just before the first text", async () => {
    const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks([
      { choices: [{ index: 0, delta: { reasoning_content: "", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "a" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "b" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }] },
      stop(),
    ]), tickingClock()));
    expect(events).toEqual([
      { type: "start", model: "glm-5.1" },
      { type: "thinking", text: "a" },
      { type: "thinking", text: "b" },
      { type: "reasoning_content", reasoning: "ab" },
      { type: "text", text: "x" },
      { type: "text", text: "y" },
      { type: "done", content: "xy", finish_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 20, time_to_first_token_ms: 10 } },
    ]);
  });

  test("a reply that only thinks and calls tools still sums up its reasoning, and its first token is the first call", async () => {
    const thinking = await collect(zaiStreamEvents("glm-5.1", fakeChunks([
      { choices: [{ index: 0, delta: { reasoning_content: "hmm" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ id: "c", function: { name: "look", arguments: { at: 1 } } }] }, finish_reason: "tool_calls" }], usage },
    ]), tickingClock()));
    expect(thinking.map((e) => e.type)).toEqual(["start", "thinking", "reasoning_content", "tool_use", "done"]);
    expect(thinking[3]).toEqual({ type: "tool_use", id: "c", name: "look", input: { at: 1 } });

    const toolsOnly = await collect(zaiStreamEvents("glm-5.1", fakeChunks([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "first", function: { name: "one", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "second", function: { name: "two" } }] }, finish_reason: "tool_calls" }], usage },
    ]), tickingClock()));
    expect(toolsOnly.filter((e) => e.type === "tool_use")).toEqual([
      { type: "tool_use", id: "first", name: "one", input: {} },
      { type: "tool_use", id: "second", name: "two", input: {} },
    ]);
    expect(toolsOnly.at(-1)).toMatchObject({ type: "done", content: "", timing: { total_ms: 20, time_to_first_token_ms: 10 } });
    expect(toolsOnly.some((e) => e.type === "reasoning_content")).toBe(false);
  });

  test("a stream with nothing in it still starts, then fails with the time it took", async () => {
    const seen: unknown[] = [];
    const failure = await rejectionOf((async () => {
      for await (const event of zaiStreamEvents("glm-5.1", fakeChunks([]), tickingClock())) seen.push(event);
    })());
    expect(seen).toEqual([{ type: "start", model: "glm-5.1" }]);
    expect(failure).toEqual({ kind: "stream_errored", message: "Z.ai stream ended without a finish reason", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 10, time_to_first_token_ms: 20 } });
  });

  test("an unknown finish reason or no token usage fails with what was counted so far", async () => {
    const odd = await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "network_error" }], usage },
    ]), tickingClock())));
    expect(odd).toEqual({ kind: "stream_errored", message: "Z.ai stream ended with unsupported finish reason 'network_error'", usage: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 20, time_to_first_token_ms: 10 } });
    const empty = await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    ]), tickingClock())));
    expect(empty).toEqual({ kind: "stream_errored", message: "Z.ai stream ended with zero token usage", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 20, time_to_first_token_ms: 10 } });
  });
});

describe("replayed history", () => {
  const history = (): SidecarRequest["messages"] => [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", provider_key: "zai-api", model: "glm-5.1", content: [{ type: "thinking", thinking: "t", reasoning_content: "why" }, { type: "text", text: "a" }] },
    { role: "assistant", provider_key: "zai-api", model: "glm-5.1", content: [{ type: "thinking", thinking: "t", reasoning_content: "" }, { type: "text", text: "b" }] },
    { role: "assistant", provider_key: "zai-api", model: "glm-5.1", content: [{ type: "thinking", thinking: "t", reasoning_content: "x" }, { type: "tool_use", id: "c1", name: "look", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "seen" }] },
  ];

  test("reasoning goes back only when thinking is on and Z.ai is told not to clear it, after the system prompt", () => {
    expect(buildZaiMessages(req({ system: [{ text: "sys", label: "soul" }], messages: history(), provider_options: { zai_clear_reasoning: false } }))).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: "a", reasoning_content: "why" },
      { role: "assistant", content: "b" },
      { role: "assistant", reasoning_content: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "seen" },
    ] as never);
    for (const provider_options of [{}, { zai_clear_reasoning: true }, { zai_clear_reasoning: false, thinking_enabled: false }]) {
      const messages = buildZaiMessages(req({ messages: history(), provider_options })) as unknown as Array<Record<string, unknown>>;
      expect(messages.filter((m) => "reasoning_content" in m)).toEqual([]);
      expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "q" }] });
    }
  });

  test("a tool's pictures are labelled with the tool that took them", () => {
    const messages = buildZaiMessages(req({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } }] }] },
    ] }));
    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Images from tool screenshot (tool_call_id: c1):" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } }] } as never);
  });
});

describe("whole replies", () => {
  test("reasoning, text and tool calls are read, with the model it reports and arguments given as objects", () => {
    expect(zaiGenerateResponse("glm-5.1", {
      model: "glm-5.1-air",
      choices: [{ message: { reasoning_content: "why", content: "here", tool_calls: [
        { id: "c1", type: "function", function: { name: "look", arguments: '{"a":1}' } },
        { type: "function", function: { name: "obj", arguments: { b: 2 } } },
        { function: { name: "bare" } },
        { type: "retrieval", function: { name: "skipped" } },
      ] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } },
    }, 70)).toEqual({
      content: "here",
      content_blocks: [
        { type: "thinking", thinking: "why", reasoning_content: "why" },
        { type: "text", text: "here" },
        { type: "tool_use", id: "c1", name: "look", input: { a: 1 } },
        { type: "tool_use", id: "tc_0", name: "obj", input: { b: 2 } },
        { type: "tool_use", id: "tc_0", name: "bare", input: {} },
      ],
      finish_reason: "tool_use",
      usage: { input_tokens: 4, output_tokens: 4, cache_read_tokens: 5, cache_creation_tokens: 0 },
      timing: { total_ms: 70, time_to_first_token_ms: 70 },
      model: "glm-5.1-air",
    });
    expect(zaiGenerateResponse("glm-5.1", { model: "", choices: [{ message: { reasoning_content: "", content: null }, finish_reason: "length" }], usage: { prompt_tokens: 1 } }, 5))
      .toMatchObject({ content: "", content_blocks: [], finish_reason: "max_tokens", model: "glm-5.1" });
  });

  test("a whole reply with no finish reason, an unknown one or no usage is refused", () => {
    const refusal = (completion: unknown): unknown => {
      try {
        zaiGenerateResponse("glm-5.1", completion, 8);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const timing = { total_ms: 8, time_to_first_token_ms: 8 };
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    expect(refusal({ choices: [{ message: {}, finish_reason: null }] })).toEqual({ kind: "stream_errored", message: "Z.ai response ended without a finish reason", usage: zero, timing });
    expect(refusal({ choices: [] })).toEqual({ kind: "stream_errored", message: "Z.ai response ended without a finish reason", usage: zero, timing });
    expect(refusal({ choices: [{ message: {}, finish_reason: "network_error" }] })).toEqual({ kind: "stream_errored", message: "Z.ai response ended with unsupported finish reason 'network_error'", usage: zero, timing });
    expect(refusal({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] })).toEqual({ kind: "stream_errored", message: "Z.ai response ended with zero token usage", usage: zero, timing });
  });

  test("Z.ai's finish reasons map onto shore's", () => {
    const finish = (reason: string): unknown => zaiGenerateResponse("glm-5.1", { choices: [{ message: {}, finish_reason: reason }], usage: { completion_tokens: 1 } }, 1).finish_reason;
    expect(["stop", "tool_calls", "length", "model_context_window_exceeded", "content_filter", "sensitive", "end_turn", "max_tokens", "tool_use", "refusal", "stop_sequence"].map(finish))
      .toEqual(["end_turn", "tool_use", "max_tokens", "max_tokens", "content_filter", "content_filter", "end_turn", "max_tokens", "tool_use", "refusal", "stop_sequence"]);
  });
});

describe("stream timing", () => {
  const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  test("the first thought times the first token, before any text", async () => {
    const { clock, chunks } = timedChunks<ChatCompletionChunk>(50, [[100, delta({ reasoning_content: "r" })], [200, { ...delta({ content: "a" }, "stop"), usage }]], 1000);
    expect((await collect(zaiStreamEvents("glm-5.1", chunks, clock))).at(-1)).toMatchObject({ type: "done", timing: { total_ms: 950, time_to_first_token_ms: 50 } });
  });

  test("a reply with no tokens times its first token at the end", async () => {
    const { clock, chunks } = timedChunks<ChatCompletionChunk>(50, [[100, stop()]], 1000);
    expect((await collect(zaiStreamEvents("glm-5.1", chunks, clock))).at(-1)).toMatchObject({ type: "done", timing: { total_ms: 950, time_to_first_token_ms: 950 } });
  });

  test("a stream that ends badly is timed the same way", async () => {
    const empty = timedChunks<ChatCompletionChunk>(50, [[100, delta({}, "stop")]], 1000);
    expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", empty.chunks, empty.clock)))).toMatchObject({ message: "Z.ai stream ended with zero token usage", timing: { total_ms: 950, time_to_first_token_ms: 950 } });
    const cut = timedChunks<ChatCompletionChunk>(50, [[100, delta({})]], 1000);
    expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", cut.chunks, cut.clock)))).toMatchObject({ message: "Z.ai stream ended without a finish reason", timing: { total_ms: 950, time_to_first_token_ms: 950 } });
    const spoke = timedChunks<ChatCompletionChunk>(50, [[100, delta({ content: "a" }, "stop")]], 1000);
    expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", spoke.chunks, spoke.clock)))).toMatchObject({ message: "Z.ai stream ended with zero token usage", timing: { total_ms: 950, time_to_first_token_ms: 50 } });
  });

  test("a call that gives no index is the first call", async () => {
    const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks([{ ...delta({ tool_calls: [{ function: { name: "look", arguments: "{}" } }] }, "tool_calls"), usage }]), tickingClock()));
    expect(events.find((e) => e.type === "tool_use")).toEqual({ type: "tool_use", id: "tc_0", name: "look", input: {} });
  });
});
