import { describe, expect, test } from "bun:test";

import { mostRecentAssistantTurnStart } from "../src/llm/providers/anthropic.ts";
const user = (...content: unknown[]) => ({ role: "user", content });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string) => ({ type: "tool_use", id, name: "read", input: {} });
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const image = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } });

const startOf = (messages: unknown[]): number =>
  mostRecentAssistantTurnStart(messages as never);

describe("where the most recent assistant turn begins", () => {
  test("an empty conversation has nothing to mark, so the start is the end", () => {
    expect(startOf([])).toBe(0);
  });

  test("a conversation with no assistant message at all is entirely strippable history", () => {
    expect(startOf([user(text("one")), user(text("two"))])).toBe(2);
  });

  test("an assistant speaking first starts at the beginning", () => {
    expect(startOf([assistant(text("hello")), user(text("hi"))])).toBe(0);
  });

  test("a single reply starts right after the user who prompted it", () => {
    expect(startOf([user(text("hi")), assistant(text("hello"))])).toBe(1);
  });
});

describe("what counts as part of the same turn", () => {
  test("consecutive assistant messages are one turn", () => {
    expect(startOf([user(text("hi")), assistant(text("a")), assistant(text("b"))])).toBe(1);
  });

  test("a tool-result-only user sits inside the turn, it does not end it", () => {
    expect(
      startOf([
        user(text("hi")),
        assistant(toolUse("t1")),
        user(toolResult("t1")),
        assistant(text("done")),
      ]),
    ).toBe(1);
  });

  test("a whole tool loop is one turn, however many rounds it takes", () => {
    const messages = [user(text("go")), user(text("really go")), user(text("please"))];
    for (const id of ["t1", "t2", "t3"]) {
      messages.push(assistant(toolUse(id)), user(toolResult(id)));
    }
    messages.push(assistant(text("finished")));
    expect(startOf(messages)).toBe(3);
  });

  test("a trailing tool result after the last reply does not move the start", () => {
    expect(
      startOf([user(text("hi")), assistant(toolUse("t1")), user(toolResult("t1"))]),
    ).toBe(1);
  });
});

describe("what ends the run, because it is a genuine user turn", () => {
  test("a tool result carrying text alongside it", () => {
    expect(
      startOf([
        user(text("hi")),
        assistant(toolUse("t1")),
        user(toolResult("t1"), text("and also this")),
        assistant(text("ok")),
      ]),
    ).toBe(3);
  });

  test("an empty content array, which is not tool-result-only", () => {
    expect(startOf([user(text("hi")), user(), assistant(text("ok"))])).toBe(2);
  });

  test("string content rather than blocks, which cannot be inspected for tool results", () => {
    expect(
      startOf([user(text("hi")), { role: "user", content: "plain" }, assistant(text("ok"))]),
    ).toBe(2);
  });

  test("an image with no caption, which is a person attaching something", () => {
    expect(startOf([user(text("hi")), user(image()), assistant(text("ok"))])).toBe(2);
  });
});

describe("the boundary is always usable as a split point", () => {
  test("it never points past the end, or before the start", () => {
    const conversations: unknown[][] = [
      [],
      [user(text("a"))],
      [assistant(text("a"))],
      [user(text("a")), assistant(text("b")), user(toolResult("t")), assistant(text("c"))],
      [user(), user(), assistant(text("x"))],
    ];
    for (const messages of conversations) {
      const start = startOf(messages);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(messages.length);
    }
  });

  test("everything from the boundary on contains the last assistant message", () => {
    const messages = [
      user(text("a")),
      assistant(text("b")),
      user(text("c")),
      assistant(toolUse("t1")),
      user(toolResult("t1")),
      assistant(text("d")),
    ];
    const tail = messages.slice(startOf(messages));
    expect(tail.some((m) => m.role === "assistant")).toBe(true);
  });
});
