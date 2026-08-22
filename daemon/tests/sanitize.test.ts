import { describe, expect, test } from "bun:test";

import { sanitizeToolPairs } from "../src/llm/sanitize";
import type { WireMessage } from "../src/llm/types";

function assistant(...content: unknown[]): WireMessage {
  return { role: "assistant", content } as unknown as WireMessage;
}

function user(...content: unknown[]): WireMessage {
  return { role: "user", content } as unknown as WireMessage;
}

const text = (t: string) => ({ type: "text", text: t });
const use = (id: string) => ({ type: "tool_use", id, name: "read", input: {} });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });

describe("a conversation whose tool calls all have results", () => {
  test("is left alone, so the caller can skip the rewrite", () => {
    expect(
      sanitizeToolPairs([assistant(use("a")), user(result("a"))]),
    ).toBeUndefined();
  });

  test("stays untouched when there are no tools at all", () => {
    expect(sanitizeToolPairs([user(text("hi")), assistant(text("hello"))])).toBeUndefined();
  });

  test("matches ids across distant turns, not just adjacent ones", () => {
    expect(
      sanitizeToolPairs([
        assistant(use("a")),
        user(text("interrupting")),
        assistant(text("still going")),
        user(result("a")),
      ]),
    ).toBeUndefined();
  });
});

describe("a tool call with no result", () => {
  test("is dropped, because a provider rejects the dangling pair", () => {
    const got = sanitizeToolPairs([assistant(text("thinking"), use("a"))]);
    expect(got).toEqual([assistant(text("thinking"))]);
  });

  test("takes its message with it when nothing else is left in it", () => {
    const got = sanitizeToolPairs([user(text("go")), assistant(use("a"))]);
    expect(got).toEqual([user(text("go"))]);
  });

  test("does not take its paired siblings with it", () => {
    const got = sanitizeToolPairs([assistant(use("a"), use("b")), user(result("b"))]);
    expect(got).toEqual([assistant(use("b")), user(result("b"))]);
  });
});

describe("a tool result with no call", () => {
  test("is dropped too", () => {
    const got = sanitizeToolPairs([user(text("here"), result("ghost"))]);
    expect(got).toEqual([user(text("here"))]);
  });

  test("empties its message when it was the only block", () => {
    const got = sanitizeToolPairs([assistant(text("hi")), user(result("ghost"))]);
    expect(got).toEqual([assistant(text("hi"))]);
  });
});

describe("role decides what a block means", () => {
  test("a tool_use in a user turn is not a call, so it never pairs", () => {
    const got = sanitizeToolPairs([user(use("a")), assistant(use("a")), user(result("a"))]);
    expect(got).toBeUndefined();
  });

  test("a tool_result in an assistant turn is not a result", () => {
    const got = sanitizeToolPairs([assistant(use("a"), result("a"))]);
    expect(got).toEqual([assistant(result("a"))]);
  });
});

describe("the rewrite", () => {
  test("never mutates what it was given", () => {
    const messages = [assistant(use("a")), user(result("ghost"))];
    const before = JSON.stringify(messages);
    sanitizeToolPairs(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("carries provider_key and model through onto the rewritten message", () => {
    const tagged = {
      role: "assistant",
      content: [text("hi"), use("a")],
      provider_key: "moonshotai",
      model: "kimi-k3",
    } as unknown as WireMessage;
    expect(sanitizeToolPairs([tagged])).toEqual([
      {
        role: "assistant",
        content: [text("hi")],
        provider_key: "moonshotai",
        model: "kimi-k3",
      } as unknown as WireMessage,
    ]);
  });

  test("can empty the conversation entirely", () => {
    expect(sanitizeToolPairs([assistant(use("a")), user(result("ghost"))])).toEqual([]);
  });
});
