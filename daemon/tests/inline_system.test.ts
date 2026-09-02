import { describe, expect, test } from "bun:test";

import { foldInlineSystemMessages } from "../src/llm/inline_system.ts";
import type { WireMessage } from "../src/llm/types.ts";

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("foldInlineSystemMessages", () => {
  test("a trailing system turn merges into the user turn before it", () => {
    const out = foldInlineSystemMessages([
      { role: "user", content: text("write me a haiku") },
      { role: "assistant", content: text("...") },
      { role: "user", content: text("again") },
      { role: "system", content: text("be terse") },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2]?.content).toEqual([
      { type: "text", text: "again" },
      { type: "text", text: "be terse" },
    ]);
  });

  test("a system turn after an assistant turn becomes its own user turn", () => {
    const out = foldInlineSystemMessages([
      { role: "user", content: text("hi") },
      { role: "assistant", content: text("hello") },
      { role: "system", content: text("be terse") },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2]?.content).toEqual([{ type: "text", text: "be terse" }]);
  });

  test("it does not mutate the turns it was given", () => {
    const turns: WireMessage[] = [
      { role: "user", content: text("again") },
      { role: "system", content: text("be terse") },
    ];
    foldInlineSystemMessages(turns);
    expect(turns[0]?.content).toEqual([{ type: "text", text: "again" }]);
  });

  test("turns without a system role are passed through", () => {
    const turns: WireMessage[] = [
      { role: "user", content: text("hi") },
      { role: "assistant", content: text("hello") },
    ];
    expect(foldInlineSystemMessages(turns)).toEqual(turns);
  });
});
