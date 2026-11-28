import { expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { consumeStream, emptyTiming, emptyUsage, type RegenStart } from "../src/llm/stream.ts";
import type { StreamEvent, Usage } from "../src/llm/types.ts";

async function* events(list: readonly StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of list) yield event;
}

async function consume(list: readonly StreamEvent[], regen: RegenStart = false) {
  const frames: ServerMessage[] = [];
  const outcome = await consumeStream(events(list), { regen, sink: (frame) => frames.push(frame), rid: "r1" });
  return { frames, outcome };
}

const usage: Usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_creation_tokens: 1 };
const context: Usage = { input_tokens: 30, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 40, time_to_first_token_ms: 7 };
const done = (extra: Partial<Extract<StreamEvent, { type: "done" }>> = {}): StreamEvent => ({ type: "done", content: "the reply", finish_reason: "end_turn", usage, timing, ...extra });

test("a stream's text, thinking and tool calls come back in the order they arrived, each with what it carried", async () => {
  const { frames, outcome } = await consume([
    { type: "start", model: "claude-sonnet-5-5" },
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "ping" },
    { type: "thinking", text: "hmm" },
    { type: "thinking_signature", signature: "sig" },
    { type: "text", text: "after" },
    { type: "redacted_thinking", data: "hidden" },
    { type: "reasoning_details", details: [{ step: 1 }] },
    { type: "tool_use", id: "t1", name: "read", input: {}, input_error: "Unexpected end of input", input_length: 7, thought_signature: "ts" },
    { type: "call_complete", usage, timing, finish_reason: "tool_use", continuation: true },
    { type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
    { type: "reasoning_content", reasoning: "worked it out" },
    done({ context_usage: context }),
  ]);
  expect(outcome).toEqual({
    ok: {
      content: "the reply",
      model: "claude-sonnet-5-5",
      finish_reason: "end_turn",
      usage,
      context_usage: context,
      timing,
      tool_uses: [
        { id: "t1", name: "read", input: {}, input_error: "Unexpected end of input", input_length: 7 },
        { id: "t2", name: "bash", input: { command: "ls" } },
      ],
      content_blocks: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "after" },
        { type: "redacted_thinking", data: "hidden" },
        { type: "thinking", thinking: "", reasoning_details: [{ step: 1 }] },
        { type: "tool_use", id: "t1", name: "read", input: {}, input_error: "Unexpected end of input", input_length: 7, thought_signature: "ts" },
        { type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
        { type: "thinking", thinking: "", reasoning_content: "worked it out" },
      ],
    },
  });
  expect(frames).toEqual([
    { type: "stream_start", subagent: null, rid: "r1", regen: false },
    { type: "stream_chunk", subagent: null, rid: "r1", text: "Hel", content_type: "text" },
    { type: "stream_chunk", subagent: null, rid: "r1", text: "lo", content_type: "text" },
    { type: "stream_chunk", subagent: null, rid: "r1", text: "hmm", content_type: "thinking" },
    { type: "stream_chunk", subagent: null, rid: "r1", text: "after", content_type: "text" },
  ]);
});

test("a stream with no start has no model, and the blocks a provider sends with its end take the place of what was gathered", async () => {
  const blocks = [{ type: "text" as const, text: "from the provider" }];
  const { outcome } = await consume([{ type: "text", text: "gathered" }, done({ content_blocks: blocks })]);
  expect(outcome).toEqual({ ok: { content: "the reply", model: "", finish_reason: "end_turn", usage, timing, tool_uses: [], content_blocks: blocks } });
});

test("a regenerated reply's start says so, and names what it replaces when there is anything", async () => {
  expect((await consume([{ type: "start", model: "m" }, done()], { replaces: ["a1", "a2"] })).frames[0]).toEqual({ type: "stream_start", subagent: null, rid: "r1", regen: true, replaces: ["a1", "a2"] });
  expect((await consume([{ type: "start", model: "m" }, done()], { replaces: [] })).frames[0]).toEqual({ type: "stream_start", subagent: null, rid: "r1", regen: true });
});

test("a provider's warning is passed on as it comes", async () => {
  expect((await consume([{ type: "provider_warning", message: "slow down" }, done()])).frames).toEqual([{ type: "provider_warning", rid: "r1", message: "slow down" }]);
});

test("an error ends the stream, as a stop when it was aborted and otherwise with what it knows", async () => {
  const cause = new Error("socket closed");
  expect((await consume([{ type: "error", message: "stopped", usage, timing, aborted: true }])).outcome).toEqual({ err: { kind: "aborted", message: "stopped" } });
  expect((await consume([{ type: "error", message: "overloaded", usage, timing, cause, retry_after_ms: 2000, timeout: true }])).outcome)
    .toEqual({ err: { kind: "stream_errored", cause, message: "overloaded", usage, timing, retry_after_ms: 2000, timeout: true } });
  expect((await consume([{ type: "error", message: "broke", usage: emptyUsage(), timing: emptyTiming(), timeout: false }])).outcome)
    .toEqual({ err: { kind: "stream_errored", message: "broke", usage: emptyUsage(), timing: emptyTiming() } });
});

test("a stream that ends without saying so is incomplete", async () => {
  expect((await consume([{ type: "text", text: "and then" }])).outcome).toEqual({ err: { kind: "incomplete_stream" } });
});
