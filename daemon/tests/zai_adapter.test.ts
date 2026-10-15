import { describe, expect, test } from "bun:test";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { buildZaiMessages, zaiStreamEvents } from "../src/llm/providers/zai.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { rejectionOf } from "./support/outcome.ts";

function req(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "zai",
    model: "glm-5.1",
    api_key: "k",
    provider_key: "zai-api",
    messages: [],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    ...over,
  };
}

function asChunk(raw: unknown): ChatCompletionChunk {
  return raw as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const item of arr) yield asChunk(item);
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

  test("never replays a foreign provider's carrier as Z.ai reasoning", () => {
    const messages = buildZaiMessages(
      req({
        provider_options: { zai_clear_thinking: false },
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

  const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks(chunks), fakeClock()));

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
  expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([]), fakeClock()))))
    .toMatchObject({
      kind: "stream_errored",
      message: "Z.ai stream ended without a finish reason",
    });

  expect(await rejectionOf(collect(zaiStreamEvents("glm-5.1", fakeChunks([{
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
  }]), fakeClock())))).toMatchObject({
    kind: "stream_errored",
    message: "Z.ai stream ended without a finish reason",
  });
});
