/**
 * The curated entry `shore log --heartbeat` reads.
 *
 * It looks redundant beside the raw `calls` rows and is not: a tool's *output*
 * lives in the next call's request, in whatever wire shape that provider wanted,
 * so reconstructing it on read means re-deriving one dialect from another. The
 * loop has it normalized at dispatch time, so it writes it down then.
 *
 * The two shapes worth pinning are both about what a person sees. Redacted
 * thinking becomes a visible placeholder rather than nothing, so the reasoning
 * list says "the model thought here and you may not see it" instead of looking
 * empty. And a write that fails is a warning, never a thrown heartbeat — a diary
 * entry is not worth a tick.
 */

import { describe, expect, test } from "bun:test";

import { buildEntry, recordTranscript } from "../src/transcript_capture.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { GenerateResponse } from "../src/llm/types.ts";

function response(blocks: ContentBlock[], over: Partial<GenerateResponse> = {}): GenerateResponse {
  return {
    content: "",
    content_blocks: blocks,
    finish_reason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_creation_tokens: 44 },
    timing: { total_ms: 5, time_to_first_token_ms: 2 },
    model: "claude-fixture",
    ...over,
  };
}

describe("the curated entry", () => {
  test("splits reasoning, text and tool calls", () => {
    const entry = buildEntry(
      response([
        { type: "thinking", thinking: "let me look" } as ContentBlock,
        { type: "text", text: "checking now" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.md" } } as ContentBlock,
      ]),
      [{ name: "read", input: { path: "a.md" }, output: "contents", isError: false }],
    );

    expect(entry.reasoning).toEqual(["let me look"]);
    expect(entry.text).toBe("checking now");
    // The tool's output comes from the loop, not the response — that is the
    // whole reason this table exists.
    expect(entry.tool_calls).toEqual([
      { name: "read", input: { path: "a.md" }, output: "contents", is_error: false },
    ]);
  });

  test("joins split text blocks with newlines", () => {
    const entry = buildEntry(
      response([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
      [],
    );

    expect(entry.text).toBe("first\nsecond");
  });

  test("drops blank thinking but keeps redacted thinking as a placeholder", () => {
    const entry = buildEntry(
      response([
        { type: "thinking", thinking: "   " } as ContentBlock,
        { type: "redacted_thinking", data: "blob" } as ContentBlock,
      ]),
      [],
    );

    // Not the same as no reasoning at all: the model thought, and the reader is
    // told they cannot see it.
    expect(entry.reasoning).toEqual(["[redacted thinking]"]);
  });

  test("an empty text block does not become a blank line", () => {
    const entry = buildEntry(
      response([
        { type: "text", text: "only this" },
        // After the real text, which is the ordering that catches it: a leading
        // empty block is absorbed by the "no separator yet" branch anyway.
        { type: "text", text: "" },
      ]),
      [],
    );

    expect(entry.text).toBe("only this");
  });

  test("a failed tool keeps its flag", () => {
    const entry = buildEntry(response([]), [
      { name: "edit", input: {}, output: "io: denied", isError: true },
    ]);

    expect(entry.tool_calls[0]?.is_error).toBe(true);
  });
});

describe("writing a row", () => {
  test("carries the usage, the model and the serialized entry", () => {
    const rows: unknown[] = [];

    recordTranscript(
      { recordTranscript: (r) => (rows.push(r), 1) },
      {
        source: "heartbeat",
        character: "ada",
        callType: "heartbeat_tool_loop",
        iteration: 2,
        provider: "anthropic",
        response: response([{ type: "text", text: "hello" }]),
        tools: [],
        now: () => new Date("2026-07-30T13:00:00Z"),
      },
    );

    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      source: "heartbeat",
      character: "ada",
      call_type: "heartbeat_tool_loop",
      iteration: 2,
      provider: "anthropic",
      model: "claude-fixture",
      finish_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 22, cache_read_tokens: 33 },
    });
    const entry = JSON.parse((rows[0] as { entry_json: string }).entry_json);
    expect(entry.text).toBe("hello");
  });

  test("an unreported model is stored as absent, not as an empty name", () => {
    const rows: { model: string | null }[] = [];

    recordTranscript(
      { recordTranscript: (r) => (rows.push(r as never), 1) },
      {
        source: "heartbeat",
        character: "ada",
        callType: "heartbeat",
        iteration: 0,
        response: response([], { model: "" }),
        tools: [],
      },
    );

    // A blank column reads as "not reported"; an empty string reads as a name
    // nobody set.
    expect(rows[0]?.model).toBeNull();
  });

  test("a write that throws warns rather than failing the tick", () => {
    expect(() =>
      recordTranscript(
        {
          recordTranscript: () => {
            throw new Error("database is locked");
          },
        },
        {
          source: "heartbeat",
          character: "ada",
          callType: "heartbeat",
          iteration: 0,
          response: response([]),
          tools: [],
        },
      ),
    ).not.toThrow();
  });
});
