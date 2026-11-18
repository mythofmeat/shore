import { describe, expect, test } from "bun:test";

import { archivedRangeIsCurrent, openArchivalCommit } from "../src/memory/compaction/plan.ts";
import type { Message } from "../src/engine/types.ts";
import { jsonlOf, planMessage, planOf } from "./support/archival_plan.ts";

const lit = planMessage("user", "is the lamp lit");
const yes = planMessage("assistant", "it is");
const door = planMessage("user", "and the door");
const shut = planMessage("assistant", "shut");

function said(message: Message, text: string): Message {
  return { ...message, content: text, content_blocks: [{ type: "text", text }] };
}

function reordered(messages: readonly Message[]): string {
  return messages.map((message) => JSON.stringify(Object.fromEntries(Object.entries(message).reverse()))).join("\n") + "\n";
}

describe("a range planned for archiving is still the one to archive", () => {
  test("when the conversation only grew after it, even past a line that can't be read", () => {
    const source = jsonlOf([lit, yes]);
    expect(archivedRangeIsCurrent({ sourceContent: source, splitAt: 2 }, `${source}{not json\n`)).toBe(true);
  });

  test("when its messages were written out again unchanged, up to the last one", () => {
    expect(archivedRangeIsCurrent({ sourceContent: jsonlOf([lit, yes]), splitAt: 2 }, reordered([lit, yes]))).toBe(true);
    expect(archivedRangeIsCurrent({ sourceContent: jsonlOf([lit, yes, door]), splitAt: 2 }, reordered([lit, yes, door, shut]))).toBe(true);
  });

  test("but not once one of its messages changed, the conversation got shorter than it, or a line can't be read", () => {
    const source = jsonlOf([lit, yes]);
    expect(archivedRangeIsCurrent({ sourceContent: source, splitAt: 2 }, reordered([lit, said(yes, "it was")]))).toBe(false);
    expect(archivedRangeIsCurrent({ sourceContent: source, splitAt: 2 }, reordered([lit]))).toBe(false);
    expect(archivedRangeIsCurrent({ sourceContent: source, splitAt: 2 }, `${reordered([lit, yes])}{not json\n`)).toBe(false);
  });

  test("and never when it reaches past the messages it was planned from", () => {
    expect(archivedRangeIsCurrent({ sourceContent: jsonlOf([lit, yes]), splitAt: 3 }, reordered([lit, yes, door]))).toBe(false);
  });
});

describe("a plan", () => {
  test("archives from the first message, a wake's reply at the end included unless it is asked to keep that", () => {
    const wake = { ...planMessage("assistant", "a note from a wake"), origin: "autonomous" as const };
    const ids = (keep: boolean): string[] => planOf([lit, yes, wake], { keepRecentTurns: 0, ...(keep ? { retainTrailingAutonomous: true } : {}) }).archival.map((message) => message.msg_id);
    expect(ids(false)).toEqual([lit.msg_id, yes.msg_id, wake.msg_id]);
    expect(ids(true)).toEqual([lit.msg_id, yes.msg_id]);
  });

  test("is committed against the conversation as it now is, keeping what came after the range", () => {
    const plan = planOf([lit, yes, door, shut], { keepRecentTurns: 1 });
    const live = jsonlOf([lit, yes, door, shut, planMessage("user", "and the gate")]);
    expect(openArchivalCommit(plan, live)).toEqual({ liveContent: live, retained: 3, retainedTurns: 2 });
    expect(openArchivalCommit(plan, reordered([said(lit, "was the lamp lit"), yes, door, shut]))).toBeUndefined();
  });
});
