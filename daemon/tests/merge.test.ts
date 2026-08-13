/**
 * Recorded cases for merge.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";

import { mergeToolLoopMessages } from "../src/engine/merge";
import type { Message } from "../src/engine/types";

import fixture from "./engine_fixtures/merge.json";

interface MergeCase {
  name: string;
  input: Message[];
  expect: Message[];
}

/**
 * Rust omits empty/absent fields on the wire, so a fixture message may arrive
 * without `images` or `content_blocks`. `Message::normalize` is what fills them
 * in on load; this stands in for it, and only for the two array fields the
 * merge actually reads.
 */
function hydrate(m: Message): Message {
  return { ...m, images: m.images ?? [], content_blocks: m.content_blocks ?? [] };
}

/** Compare the way the wire does: an absent field and an undefined one are the
 *  same thing, so strip undefineds before matching. */
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
  // Both fall out of the closing message being appended raw rather than through
  // `collectRound`. They are pinned inside the fixture too; these say what they
  // are, so a future reader meets the intent and not just a block count.
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
    // It contributes nothing to `content`, which trims and drops empties.
    expect(merged[0]!.content).toBe("");
  });

  test("a tool_use in the closing message is never paired", () => {
    const merged = mergeToolLoopMessages(
      loop([{ type: "tool_use", id: "t2", name: "read", input: {} }]),
    );
    const kinds = merged[0]!.content_blocks.map((b) => b.type);
    // t1 paired inside the loop; t2 appended alone.
    expect(kinds).toEqual(["tool_use", "tool_result", "tool_use"]);
  });
});
