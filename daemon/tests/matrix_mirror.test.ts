import { describe, expect, test } from "bun:test";

import type { NewMessage } from "../src/protocol/NewMessage";
import type { ServerMessage } from "../src/protocol/ServerMessage";

import {
  extractThinking,
  formatUserMirror,
  parseReaction,
  routeMirror,
  splitLines,
} from "../src/connections/matrix/mirror.ts";

function newMessage(overrides: Partial<NewMessage> = {}): ServerMessage {
  const message: NewMessage = {
    revision: 1,
    character: "alice",
    msg_id: "m1",
    role: "assistant",
    content: "hi there",
    images: [],
    content_blocks: [],
    timestamp: "2026-01-01T00:00:00Z",
  };
  return { type: "new_message", ...message, ...overrides };
}

describe("mirror_all frames", () => {
  test("an assistant reply becomes a post", () => {
    const route = routeMirror(newMessage({ origin: "assistant_reply" }));
    expect(route).toEqual({
      kind: "post",
      msgId: "m1",
      replacesLast: false,
      autonomous: false,
      thinking: undefined,
      text: "hi there",
      images: [],
    });
  });

  test("an autonomous message is posted and flagged", () => {
    const route = routeMirror(
      newMessage({ character: "bob", origin: "autonomous", content: "thinking of you" }),
    );
    expect(route).toMatchObject({ kind: "post", autonomous: true });
  });

  test("a regen reply carrying an alternative replaces the last one", () => {
    const route = routeMirror(
      newMessage({ origin: "assistant_reply", alt_count: 2, alt_index: 1, content: "better" }),
    );
    expect(route).toMatchObject({ kind: "post", replacesLast: true });
  });

  test("an autonomous message never replaces, whatever its alt metadata says", () => {
    const route = routeMirror(newMessage({ origin: "autonomous", alt_count: 2 }));
    expect(route).toMatchObject({ kind: "post", replacesLast: false });
  });

  test("alternatives stand in for alt_count when the daemon sends only the list", () => {
    const route = routeMirror(
      newMessage({
        origin: "assistant_reply",
        alternatives: [
          { content: "old", images: [], content_blocks: [], timestamp: "2026-01-01T00:00:00Z" },
          { content: "new", images: [], content_blocks: [], timestamp: "2026-01-01T00:00:01Z" },
        ],
      }),
    );
    expect(route).toMatchObject({ kind: "post", replacesLast: true });
  });

  test("a user prompt from another client becomes a mirrored prompt", () => {
    const route = routeMirror(newMessage({ origin: "user_input", content: "ping from the cli" }));
    expect(route).toEqual({
      kind: "user_prompt",
      msgId: "m1",
      content: "ping from the cli",
    });
  });

  test("a message with no origin posts as the bot", () => {
    expect(routeMirror(newMessage())).toMatchObject({ kind: "post", replacesLast: false });
  });

  test("an empty msg_id is no msg_id", () => {
    expect(routeMirror(newMessage({ msg_id: "" }))).toMatchObject({ msgId: undefined });
  });

  test("thinking blocks are concatenated and redacted ones skipped", () => {
    const route = routeMirror(
      newMessage({
        origin: "assistant_reply",
        content_blocks: [
          { type: "thinking", thinking: "first" },
          { type: "redacted_thinking", data: "ciphertext" },
          { type: "thinking", thinking: "   " },
          { type: "thinking", thinking: "second" },
          { type: "text", text: "hi there" },
        ],
      }),
    );
    expect(route).toMatchObject({ thinking: "first\n\nsecond" });
  });

  test("no readable thinking is undefined, not an empty string", () => {
    expect(extractThinking([{ type: "redacted_thinking", data: "x" }])).toBeUndefined();
    expect(extractThinking([])).toBeUndefined();
  });

  test("images ride along with the post", () => {
    const route = routeMirror(
      newMessage({
        origin: "assistant_reply",
        images: [{ path: "/tmp/a.png", caption: "a cat" }, { path: "/tmp/b.png" }],
      }),
    );
    expect(route).toMatchObject({
      images: [
        { path: "/tmp/a.png", caption: "a cat", data: undefined },
        { path: "/tmp/b.png", caption: undefined, data: undefined },
      ],
    });
  });
});

describe("the stream lifecycle", () => {
  test("start and chunk both assert typing; end only stops it", () => {
    const start = routeMirror({ type: "stream_start", regen: false });
    expect(start).toEqual({ kind: "start_typing" });

    const chunk = routeMirror({
      type: "stream_chunk",
      text: "partial",
      content_type: "text",
    });
    expect(chunk).toEqual({ kind: "start_typing" });

    const end = routeMirror({
      type: "stream_end",
      content: "the reply",
      is_final: true,
      metadata: {
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        timing: { total_ms: 0, ttft_ms: 0 },
        model: "test",
      },
    });
    expect(end).toEqual({ kind: "stop_typing" });
  });
});

describe("warnings, errors and command output", () => {
  test("an error carries its code and message", () => {
    const route = routeMirror({ type: "error", code: "provider_error", message: "no model" });
    expect(route).toEqual({ kind: "error", text: "provider_error: no model" });
  });

  test("a usage warning renders money and percentage", () => {
    const route = routeMirror({
      type: "usage_warning",
      budget: "daily",
      message: "80% of daily budget",
      current_cost: 8,
      cost_limit: 10,
      percent_used: 0.8,
      crossed_warn_at: [0.8],
      period: "day",
      period_start: "2026-08-08T00:00:00Z",
      reset_at: "2026-08-09T00:00:00Z",
      reset_at_display: "2026-08-09 12:00 AM",
    });
    expect(route).toEqual({
      kind: "notice",
      text: "⚠️ 80% of daily budget — $8.00 of $10.00 (80%) this day",
    });
  });

  test("a Claude plan warning is a share of the plan, not money", () => {
    const route = routeMirror({
      type: "plan_limit_warning",
      window: "seven_day",
      limit: "Claude weekly limit",
      message: "Claude weekly limit is at 84%; resets at 2026-10-02 03:00 AM.",
      percent_used: 0.84,
      crossed_warn_at: [0.8],
      limit_at: 1,
      over_limit: false,
      resets_at: "2026-10-02T03:00:00+00:00",
      resets_at_display: "2026-10-02 03:00 AM",
    });
    expect(route).toEqual({ kind: "notice", text: "⚠️ Claude weekly limit is at 84%; resets at 2026-10-02 03:00 AM." });
  });

  test("a provider fallback names both keys, with and without a status", () => {
    const withStatus = routeMirror({
      type: "provider_fallback_warning",
      provider: "openrouter",
      from_key: "primary",
      to_key: "backup",
      kind: "quota_exhausted",
      status: 429,
      message: "quota",
    });
    expect(withStatus).toMatchObject({
      text:
        "⚠️ provider `openrouter`: key **primary** failed (quota_exhausted, HTTP 429) " +
        "— now using **backup**",
    });

    const without = routeMirror({
      type: "provider_fallback_warning",
      provider: "openrouter",
      from_key: "primary",
      to_key: "backup",
      kind: "missing_key",
      message: "missing",
    });
    expect(without).toMatchObject({
      text: "⚠️ provider `openrouter`: key **primary** failed (missing_key) — now using **backup**",
    });
  });

  test("a command output is carried whole", () => {
    const route = routeMirror({ type: "command_output", name: "status", data: { turns: 3 } });
    expect(route).toEqual({ kind: "command_output", name: "status", data: { turns: 3 } });
  });

  test("frames with nothing to show say so", () => {
    for (const msg of [
      { type: "ping" },
      { type: "shutdown" },
      { type: "unknown" },
      { type: "phase", phase: "thinking" },
    ] as ServerMessage[]) {
      expect(routeMirror(msg)).toEqual({ kind: "none" });
    }
  });
});

describe("reactions", () => {
  test("the control emoji, with and without the variation selector", () => {
    expect(parseReaction("🔁")).toBe("regen");
    expect(parseReaction("🔄")).toBe("regen");
    expect(parseReaction("🗑️")).toBe("delete");
    expect(parseReaction("🗑")).toBe("delete");
    expect(parseReaction("❌")).toBe("delete");
    expect(parseReaction("◀️")).toBe("alt_prev");
    expect(parseReaction("▶️")).toBe("alt_next");
    expect(parseReaction("⬅️")).toBe("alt_prev");
    expect(parseReaction("➡")).toBe("alt_next");
  });

  test("everything else is not a control", () => {
    expect(parseReaction("👍")).toBeUndefined();
    expect(parseReaction("❤️")).toBeUndefined();
    expect(parseReaction("")).toBeUndefined();
  });
});

describe("mirrored prompt formatting", () => {
  test("it blockquotes and prefixes every line", () => {
    expect(formatUserMirror("hello")).toBe("> \u{1F464} hello");
    expect(formatUserMirror("line one\nline two")).toBe("> \u{1F464} line one\n> line two");
  });

  test("a trailing newline does not become an empty quoted line", () => {
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(formatUserMirror("a\n")).toBe("> \u{1F464} a");
    expect(formatUserMirror("")).toBe("> \u{1F464}");
  });
});
