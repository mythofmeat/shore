/**
 * Streaming-event mapping for the OpenAI adapter: hand-built SDK chunks +
 * a fake clock through the pure `openAIStreamEvents` generator. Asserts the
 * adapter emits the `StreamEvent` contract vocabulary in order — `start`,
 * incremental `text`/`thinking`, ONE consolidated `tool_use` (full input, not
 * deltas), then `done` with snake_case usage (+ cost) and timing.
 */

import { expect, test } from "bun:test";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { openAIStreamEvents } from "../src/llm/providers/openai.ts";
import type { StreamEvent } from "../src/llm/types.ts";

function asChunk(c: unknown): ChatCompletionChunk {
  return c as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const c of arr) yield asChunk(c);
}

/** Deterministic clock: 10ms per call. */
function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
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
    openAIStreamEvents("deepseek/deepseek-v4-pro", fakeChunks(chunks), fakeClock()),
  );

  // ── exact event sequence ──
  expect(events[0]).toEqual({ type: "start", model: "deepseek/deepseek-v4-pro" });
  expect(events[1]).toEqual({ type: "thinking", text: "think" });
  expect(events[2]).toEqual({ type: "text", text: "Hello " });
  expect(events[3]).toEqual({ type: "text", text: "world" });
  // tool_use is CONSOLIDATED: one event with the full parsed input, not deltas.
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
    expect(done.finish_reason).toBe("tool_use"); // mapped from "tool_calls"
    // prompt_tokens (100) is inclusive of the 80 cached tokens; input_tokens
    // carries only the cache-miss remainder (20) so the buckets are disjoint.
    expect(done.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_tokens: 0,
      total_cost_usd: 0.0012,
    });
    // fake clock: start=10, first token=20, done=30 → ttft 10, total 20.
    expect(done.timing).toEqual({ total_ms: 20, time_to_first_token_ms: 10 });
  }

  expect(events.length).toBe(6);

  // No tool_use_start/input_delta/done leakage from the old ChatEvent shape.
  for (const e of events) {
    expect(["start", "text", "thinking", "thinking_signature", "redacted_thinking", "tool_use", "done"]).toContain(e.type);
  }
});

test("text-only stream ends with end_turn and no tool_use events", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  ];
  const events = await collect(openAIStreamEvents("openai/gpt-5.5", fakeChunks(chunks), fakeClock()));
  expect(events.map((e) => e.type)).toEqual(["start", "text", "done"]);
  const done = events[2];
  if (done?.type === "done") {
    expect(done.finish_reason).toBe("end_turn");
    expect(done.content).toBe("hi");
    expect(done.usage.total_cost_usd).toBeUndefined();
  }
});
