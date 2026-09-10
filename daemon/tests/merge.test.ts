import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { mergeToolLoopMessages } from "../src/engine/merge";
import type { Message } from "../src/engine/types";

import fixture from "./engine_captures/merge.json";

interface MergeCase {
  name: string;
  input: Message[];
  merged_ids: string[];
}

function hydrate(m: Message): Message {
  return { ...m, images: m.images ?? [], content_blocks: m.content_blocks ?? [] };
}

function wire(m: Message): unknown {
  return JSON.parse(JSON.stringify(m));
}

describe("merging a streamed turn into the conversation", () => {
  const cases = fixture.cases as unknown as MergeCase[];

  test("every case is a distinct claim, named for what it checks", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThan(20);
  });

  const blocksOf = (messages: readonly Message[]): string[] =>
    messages.flatMap((m) => m.content_blocks.map((b) => JSON.stringify(b)));

  for (const c of cases) {
    test(c.name, () => {
      const input = c.input.map(hydrate);
      const got = mergeToolLoopMessages(input);
      const byId = new Map(input.map((m) => [m.msg_id, m]));

      expect(
        got.map((m) => m.msg_id),
        "the messages that survive the merge, each named for the turn it ends",
      ).toEqual(c.merged_ids);

      for (const message of got) {
        const source = required(byId.get(message.msg_id));
        expect(
          wire({ ...message, content: "", content_blocks: [], images: [] }),
          `${message.msg_id}: a merged turn keeps everything about the message it ends`,
        ).toEqual(wire({ ...source, content: "", content_blocks: [], images: [] }));

        const untouched =
          JSON.stringify(message.content_blocks) === JSON.stringify(source.content_blocks);
        if (untouched) {
          expect(
            wire(message),
            `${message.msg_id}: a message with nothing to merge comes through as it was`,
          ).toEqual(wire(source));
          continue;
        }

        const text = message.content_blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text.trim())
          .filter((t) => t !== "");
        expect(
          message.content,
          `${message.msg_id}: its text is its text blocks, trimmed, blank ones left out`,
        ).toBe(text.join("\n"));

        message.content_blocks.forEach((block, i) => {
          if (block.type !== "tool_use") return;
          const answered = message.content_blocks.some(
            (b) => b.type === "tool_result" && b.tool_use_id === block.id,
          );
          if (!answered) return;
          const next = message.content_blocks[i + 1];
          expect(
            next?.type === "tool_result" && next.tool_use_id === block.id,
            `${message.msg_id}: ${block.id} is followed by what it returned`,
          ).toBe(true);
        });
      }

      const offered = blocksOf(input);
      const spare = [...offered];
      for (const block of blocksOf(got)) {
        const at = spare.indexOf(block);
        expect(at, `every block that comes out went in: ${block.slice(0, 60)}`).toBeGreaterThan(-1);
        spare.splice(at, 1);
      }
      for (const block of spare) {
        const parsed = JSON.parse(block) as { type: string; text?: string };
        expect(
          parsed.type === "tool_result" || (parsed.type === "text" && parsed.text?.trim() === ""),
          `a block is dropped only when it is a spare tool result or empty text: ${block.slice(0, 60)}`,
        ).toBe(true);
      }
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
    expect(required(merged[0]).content_blocks.filter((b) => b.type === "text")).toHaveLength(1);
    expect(required(merged[0]).content).toBe("");
  });

  test("a tool_use in the closing message is never paired", () => {
    const merged = mergeToolLoopMessages(
      loop([{ type: "tool_use", id: "t2", name: "read", input: {} }]),
    );
    const kinds = required(merged[0]).content_blocks.map((b) => b.type);
    expect(kinds).toEqual(["tool_use", "tool_result", "tool_use"]);
  });
});
