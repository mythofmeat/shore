import { expect, test, describe } from "bun:test";
import { type ChatCompletionChunk, type ChatCompletionCreateParams } from "openai/resources/chat/completions";
import { openAIStreamEvents, applyPromptCaching } from "../src/llm/providers/openai.ts";
import { collect, tickingClock } from "./support/stream.ts";
import { type Sdk, type SidecarRequest } from "../src/llm/types.ts";

function asChunk(c: unknown): ChatCompletionChunk {
  return c as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const c of arr) yield asChunk(c);
}

test("maps a reasoning + text + split tool_call stream to StreamEvents", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } },
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
          delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        cost: 0.0012,
      },
    },
  ];

  const events = await collect(
    openAIStreamEvents("deepseek/deepseek-v4-pro", fakeChunks(chunks), tickingClock()),
  );

  expect(events[0]).toEqual({ type: "start", model: "deepseek/deepseek-v4-pro" });
  expect(events[1]).toEqual({ type: "thinking", text: "think" });
  expect(events[2]).toEqual({ type: "text", text: "Hello " });
  expect(events[3]).toEqual({ type: "text", text: "world" });
  expect(events[4]).toEqual({
    type: "tool_use",
    id: "call_1",
    name: "search",
    input: { q: "x" },
  });

  const done = events[5];
  expect(done?.type).toBe("done");
  if (done?.type === "done") {
    expect(done.content).toBe("Hello world");
    expect(done.finish_reason).toBe("tool_use");
    expect(done.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_tokens: 0,
      total_cost_usd: 0.0012,
    });
    expect(done.timing).toEqual({ total_ms: 20, time_to_first_token_ms: 10 });
  }

  expect(events.length).toBe(6);

  for (const e of events) {
    expect(["start", "text", "thinking", "thinking_signature", "redacted_thinking", "tool_use", "done"]).toContain(e.type);
  }
});

test("text-only stream ends with end_turn and no tool_use events", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  ];
  const events = await collect(openAIStreamEvents("openai/gpt-5.5", fakeChunks(chunks), tickingClock()));
  expect(events.map((e) => e.type)).toEqual(["start", "text", "done"]);
  const done = events[2];
  if (done?.type === "done") {
    expect(done.finish_reason).toBe("end_turn");
    expect(done.content).toBe("hi");
    expect(done.usage.total_cost_usd).toBeUndefined();
  }
});

function request(sdk: Sdk, cacheTtl?: string): SidecarRequest {
  return {
    sdk,
    provider_key: sdk === "nanogpt" ? "nanogpt" : "openai",
    model: "anthropic/claude-sonnet-5",
    api_key: "k",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(cacheTtl === undefined ? {} : { provider_options: { cache_ttl: cacheTtl } }),
  } as SidecarRequest;
}

function params(messageCount = 0): ChatCompletionCreateParams {
  return {
    model: "anthropic/claude-sonnet-5",
    messages: Array.from({ length: messageCount }, () => ({
      role: "user" as const,
      content: "hi",
    })),
  };
}

const helperIn = (p: ChatCompletionCreateParams): unknown =>
  (p as unknown as Record<string, unknown>)["prompt_caching"];

describe("the prompt-cache helper nano-gpt reads", () => {

  test("OpenAI's own endpoint never sees the field, which it would reject", () => {
    const p = params();
    applyPromptCaching(request("openai", "1h"), p);
    expect(helperIn(p)).toBeUndefined();
  });
});
