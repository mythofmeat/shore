import { describe, expect, test } from "bun:test";

import { decodeBody, type CoalescedStream } from "../src/commands/decode_body.ts";

function chatChunk(delta: unknown, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: "20260814230919e4294dab4dc9422d",
    object: "chat.completion.chunk",
    created: 1786720159,
    model: "glm-5.3",
    choices: [{ index: 0, delta }],
    ...extra,
  })}\n\n`;
}

describe("single JSON documents", () => {
  test("a request body parses into an object", () => {
    expect(decodeBody(`{"thinking":{"type":"enabled"}}`)).toEqual({
      thinking: { type: "enabled" },
    });
  });

  test("null stays null", () => {
    expect(decodeBody(null)).toBeNull();
  });

  test("a body that is neither JSON nor a stream comes back verbatim", () => {
    expect(decodeBody("overloaded")).toBe("overloaded");
  });

  test("a lone SSE header line is not a stream", () => {
    expect(decodeBody("event: message_start\n")).toBe("event: message_start\n");
  });
});

describe("chat-completions SSE", () => {
  const sse =
    chatChunk({ role: "assistant", content: " allowed" }) +
    chatChunk({ role: "assistant", content: " to" }) +
    chatChunk({ role: "assistant", content: " chew" }) +
    `data: ${JSON.stringify({
      id: "20260814230919e4294dab4dc9422d",
      model: "glm-5.3",
      choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: "" } }],
      usage: {
        prompt_tokens: 14241,
        completion_tokens: 1288,
        total_tokens: 15529,
        prompt_tokens_details: { cached_tokens: 12480 },
        completion_tokens_details: { reasoning_tokens: 797 },
      },
    })}\n\n` +
    `data: [DONE]\n\n` +
    `data: ${JSON.stringify({ choices: [], cost: "0" })}\n\n`;

  test("the deltas fold back into one string", () => {
    const out = decodeBody(sse) as CoalescedStream;
    expect(out.content).toBe(" allowed to chew");
  });

  test("the terminal frame supplies finish_reason and usage", () => {
    const out = decodeBody(sse) as CoalescedStream;
    expect(out.finish_reason).toBe("stop");
    expect(out.usage).toEqual({
      prompt_tokens: 14241,
      completion_tokens: 1288,
      total_tokens: 15529,
      prompt_tokens_details: { cached_tokens: 12480 },
      completion_tokens_details: { reasoning_tokens: 797 },
    });
  });

  test("the model and the frame count survive", () => {
    const out = decodeBody(sse) as CoalescedStream;
    expect(out.stream).toBe("sse");
    expect(out.model).toBe("glm-5.3");
    expect(out.chunk_count).toBe(5);
  });

  test("reasoning_content accumulates separately from content", () => {
    const out = decodeBody(
      chatChunk({ reasoning_content: "weigh " }) +
        chatChunk({ reasoning_content: "it" }) +
        chatChunk({ content: "done" }),
    ) as CoalescedStream;
    expect(out.thinking).toBe("weigh it");
    expect(out.content).toBe("done");
  });

  test("a stream with no thinking omits the key", () => {
    const out = decodeBody(chatChunk({ content: "hi" })) as CoalescedStream;
    expect(out).not.toHaveProperty("thinking");
    expect(out).not.toHaveProperty("tool_calls");
  });

  test("tool call fragments reassemble and parse", () => {
    const out = decodeBody(
      chatChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: `{"pa` } }] }) +
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: `th":"a.ts"}` } }] }),
    ) as CoalescedStream;
    expect(out.tool_calls).toEqual([{ id: "call_1", name: "read", arguments: { path: "a.ts" } }]);
  });

  test("a truncated tool call keeps its bytes rather than dropping them", () => {
    const out = decodeBody(
      chatChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: `{"pa` } }] }),
    ) as CoalescedStream;
    expect(out.tool_calls).toEqual([
      { id: "call_1", name: "read", arguments: null, arguments_unparsed: `{"pa` },
    ]);
  });

  test("interleaved tool calls stay in index order", () => {
    const out = decodeBody(
      chatChunk({ tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] }) +
        chatChunk({ tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "{}" } }] }),
    ) as CoalescedStream;
    expect(out.tool_calls?.map((c) => c.name)).toEqual(["first", "second"]);
  });
});

describe("anthropic SSE", () => {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { model: "claude-x", usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "one " },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "wall" },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 42 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");

  test("text deltas fold and usage merges across message_start and message_delta", () => {
    const out = decodeBody(sse) as CoalescedStream;
    expect(out.content).toBe("one wall");
    expect(out.model).toBe("claude-x");
    expect(out.finish_reason).toBe("end_turn");
    expect(out.usage).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 5,
      output_tokens: 42,
    });
  });

  test("thinking deltas land under thinking, not content", () => {
    const out = decodeBody(
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })}\n\n`,
    ) as CoalescedStream;
    expect(out.thinking).toBe("hmm");
    expect(out.content).toBe("");
  });

  test("input_json_delta fragments reassemble on content_block_stop", () => {
    const out = decodeBody(
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read" } })}\n\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"path"` } })}\n\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `:"a.ts"}` } })}\n\n` +
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    ) as CoalescedStream;
    expect(out.tool_calls).toEqual([{ id: "toolu_1", name: "read", arguments: { path: "a.ts" } }]);
  });

  test("an error frame is surfaced rather than swallowed", () => {
    const out = decodeBody(
      `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-x" } })}\n\n` +
        `data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
    ) as CoalescedStream;
    expect(out.error).toEqual({ type: "overloaded_error", message: "Overloaded" });
  });
});

describe("shore's own StreamEvent JSONL", () => {
  const jsonl = [
    { type: "start", model: "claude-x" },
    { type: "thinking", text: "weigh it" },
    { type: "text", text: "one " },
    { type: "text", text: "wall" },
    {
      type: "done",
      content: "one wall",
      finish_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 },
      timing: { total_ms: 42, time_to_first_token_ms: 7 },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  test("text events fold and the done event supplies the rest", () => {
    const out = decodeBody(jsonl) as CoalescedStream;
    expect(out.stream).toBe("events");
    expect(out.content).toBe("one wall");
    expect(out.thinking).toBe("weigh it");
    expect(out.model).toBe("claude-x");
    expect(out.finish_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 });
    expect(out.timing).toEqual({ total_ms: 42, time_to_first_token_ms: 7 });
    expect(out.chunk_count).toBe(5);
  });

  test("tool_use events carry their already-parsed input", () => {
    const out = decodeBody(
      [
        JSON.stringify({ type: "start", model: "claude-x" }),
        JSON.stringify({ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }),
      ].join("\n"),
    ) as CoalescedStream;
    expect(out.tool_calls).toEqual([{ id: "toolu_1", name: "read", arguments: { path: "a.ts" } }]);
  });

  test("an error event keeps its message", () => {
    const out = decodeBody(
      [
        JSON.stringify({ type: "start", model: "claude-x" }),
        JSON.stringify({ type: "error", message: "overloaded", usage: { input_tokens: 0 } }),
      ].join("\n"),
    ) as CoalescedStream;
    expect(out.error).toBe("overloaded");
  });

  test("provider diagnostics preserve the normalized response and remain inspectable", () => {
    const diagnostic = { type: "provider_event", provider: "claude_agent", event: { type: "system", subtype: "init", session_id: "session" } };
    const events = [
      { type: "start", model: "claude-x" },
      diagnostic,
      { type: "thinking", text: "" },
      { type: "thinking", text: "weigh it" },
      { type: "thinking_signature", signature: "opaque" },
      { type: "text", text: "reply" },
      { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } },
      { type: "done", content: "reply", finish_reason: "end_turn", usage: { input_tokens: 10 }, timing: { total_ms: 42 } },
    ];
    expect(decodeBody(events.map((event) => JSON.stringify(event)).join("\n"))).toEqual({
      stream: "events", model: "claude-x", content: "reply", thinking: "weigh it",
      tool_calls: [{ id: "tool_1", name: "read", arguments: { path: "a.ts" } }],
      finish_reason: "end_turn", usage: { input_tokens: 10 }, timing: { total_ms: 42 },
      provider_events: [diagnostic], chunk_count: events.length,
    });
  });

  test("future event types cannot veto a normalized response or lose their payloads", () => {
    const future = { type: "future_event", nested: { value: 7 } };
    const events = [{ type: "start", model: "claude-x" }, future, { type: "text", text: "reply" }];
    expect(decodeBody(events.map((event) => JSON.stringify(event)).join("\n"))).toEqual({
      stream: "events", model: "claude-x", content: "reply", unrecognized_events: [future], chunk_count: 3,
    });
  });

  test("a diagnostic-only stream keeps each provider wrapper", () => {
    const events = ["init", "status"].map((subtype) => ({
      type: "provider_event", provider: "claude_agent", event: { type: "system", subtype },
    }));
    expect(decodeBody(events.map((event) => JSON.stringify(event)).join("\n"))).toEqual({
      stream: "events", content: "", provider_events: events, chunk_count: 2,
    });
  });

  test.each([
    { name: "unknown event types", values: [{ type: "mystery" }, { type: "other" }] },
    { name: "objects without event types", values: [{ key: "a" }, { key: "b" }] },
    { name: "mixed JSON values", values: [{ type: "start" }, null, 3, false, "text", [1, 2]] },
  ])("JSONL with $name stays structured", ({ values }) => {
    const body = values.map((value) => JSON.stringify(value)).join("\r\n") + "\r\n\r\n";
    expect(decodeBody(body)).toEqual({ stream: "events", events: values, chunk_count: values.length });
  });

  test("lines that are not all JSON are left alone", () => {
    const body = `{"type":"start"}\nnot json`;
    expect(decodeBody(body)).toBe(body);
  });
});

describe("nothing is silently discarded", () => {
  test("an SSE frame that fails to parse falls back to the raw body", () => {
    const body = `data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {truncated\n\n`;
    expect(decodeBody(body)).toBe(body);
  });

  test("a body that only frames [DONE] falls back rather than coalescing to empty", () => {
    expect(decodeBody("data: [DONE]\n\n")).toBe("data: [DONE]\n\n");
  });

  test("CRLF framing decodes the same as LF", () => {
    const lf = decodeBody(chatChunk({ content: "hi" })) as CoalescedStream;
    const crlf = decodeBody(chatChunk({ content: "hi" }).replace(/\n/g, "\r\n")) as CoalescedStream;
    expect(crlf.content).toBe(lf.content);
  });
});
