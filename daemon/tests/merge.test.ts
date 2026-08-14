import { describe, expect, test } from "bun:test";

import { mergeToolLoopMessages } from "../src/engine/merge";
import type { Message } from "../src/engine/types";

import fixture from "./engine_fixtures/merge.json";

interface MergeCase {
  name: string;
  input: Message[];
  expect: Message[];
}

function hydrate(m: Message): Message {
  return { ...m, images: m.images ?? [], content_blocks: m.content_blocks ?? [] };
}

function wire(m: Message): unknown {
  return JSON.parse(JSON.stringify(m));
}

describe("merge parity", () => {
  const cases = fixture.cases as unknown as MergeCase[];

  test("the fixture is the one that was generated", () => {
    expect(cases.length).toBe(31);
  });

  for (const c of cases) {
    test(c.name, () => {
      const got = mergeToolLoopMessages(c.input.map(hydrate));
      expect(got.length).toBe(c.expect.length);
      got.forEach((have, i) => {
        expect(wire(have)).toEqual(wire(hydrate(c.expect[i]!)));
      });
    });
  }
});

describe("the two asymmetries, stated on their own", () => {
  const loop = (closing: Message["content_blocks"]): Message[] => [
    {
      msg_id: "a1",
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [{ type: "tool_use", id: "t1", name: "grep", input: {} }],
      timestamp: "2026-04-04T12:00:00-04:00",
    },
    {
      msg_id: "r1",
      role: "user",
      content: "",
      images: [],
      content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "found" }],
      timestamp: "2026-04-04T12:00:01-04:00",
    },
    {
      msg_id: "a2",
      role: "assistant",
      content: "",
      images: [],
      content_blocks: closing,
      timestamp: "2026-04-04T12:00:02-04:00",
    },
  ];

  test("a whitespace-only text block survives only in the closing message", () => {
    const merged = mergeToolLoopMessages(loop([{ type: "text", text: "   " }]));
    expect(merged[0]!.content_blocks.filter((b) => b.type === "text")).toHaveLength(1);
    expect(merged[0]!.content).toBe("");
  });

  test("a tool_use in the closing message is never paired", () => {
    const merged = mergeToolLoopMessages(
      loop([{ type: "tool_use", id: "t2", name: "read", input: {} }]),
    );
    const kinds = merged[0]!.content_blocks.map((b) => b.type);
    expect(kinds).toEqual(["tool_use", "tool_result", "tool_use"]);
  });
});
