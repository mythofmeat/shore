import { expect, test } from "bun:test";

import { CompactionWatch, MAX_PASS_CHARS, trimmedBlocks } from "../src/browser/chat/compaction_watch.ts";
import type { CompactionWatchResult } from "../src/protocol/CompactionWatchResult.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const RUNNING = { thread: "main", trigger: "idle", started_at: "2026-11-03T00:00:00Z", turns: 12 } as const;

function chunk(text: string): ServerMessage {
  return { type: "stream_chunk", text, content_type: "thinking", subagent: "compaction" };
}

function harness() {
  const watches: { observe: (message: ServerMessage) => void; finish: (result: CompactionWatchResult) => void; fail: (error: Error) => void }[] = [];
  const watch = new CompactionWatch({
    watch: async (observe) => await new Promise<CompactionWatchResult>((resolve, reject) => { watches.push({ observe, finish: resolve, fail: reject }); }),
    stop: async () => await Promise.resolve({ character: "ada", state: "idle", pass: null }),
  });
  return { watch, watches };
}

const finished: CompactionWatchResult = { character: "ada", state: "finished", pass: { thread: "main", trigger: "idle", started_at: "2026-11-03T00:00:00Z", ended_at: "2026-11-03T00:07:00Z", report: null, error: "the provider went away" } };

test("a long pass keeps its newest output and says it dropped the rest, however long one block gets", async () => {
  const { watch, watches } = harness();
  watch.open("ada", RUNNING);
  const piece = "x".repeat(64 * 1024);
  for (let index = 0; index < 40; index += 1) watches[0]?.observe(chunk(piece + String(index)));
  const record = watch.getSnapshot();
  const text = record?.blocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("") ?? "";
  expect(record?.limited).toBe(true);
  expect(text.length).toBeLessThanOrEqual(MAX_PASS_CHARS);
  expect(text.endsWith(`${piece}39`)).toBe(true);
});

test("trimming drops the oldest blocks first and never keeps a block out of order", () => {
  const blocks: ContentBlock[] = Array.from({ length: 10 }, (_, index) => ({ type: "text", text: String(index).padEnd(10, ".") }));
  const trimmed = trimmedBlocks(blocks, 35);
  expect(trimmed.limited).toBe(true);
  expect(trimmed.blocks.map((block) => block.type === "text" ? block.text[0] : "")).toEqual(["7", "8", "9"]);
});

test("the record of a finished pass stays until it is dismissed, and a new pass starts a new record", async () => {
  const { watch, watches } = harness();
  watch.open("ada", RUNNING);
  watches[0]?.observe(chunk("thinking about it"));
  watches[0]?.finish(finished);
  await Bun.sleep(0);
  expect(watch.getSnapshot()).toMatchObject({ running: false, failed: true, turns: 12 });
  expect(watch.getSnapshot()?.result).toContain("the provider went away");
  expect(watch.getSnapshot()?.blocks.length).toBe(1);

  watch.open("ada", null);
  expect(watches.length).toBe(1);
  expect(watch.getSnapshot()?.blocks.length).toBe(1);

  watch.open("ada", { ...RUNNING, started_at: "2026-11-03T01:00:00Z" });
  expect(watches.length).toBe(2);
  expect(watch.getSnapshot()).toMatchObject({ running: true, startedAt: "2026-11-03T01:00:00Z", blocks: [], result: null });

  watch.dismiss();
  expect(watch.getSnapshot()).toBeNull();
});

test("a connection lost mid-pass replays from the start when it returns, with nothing doubled", async () => {
  const { watch, watches } = harness();
  watch.open("ada", RUNNING);
  watches[0]?.observe(chunk("first part"));
  watches[0]?.fail(new Error("connection lost"));
  await Bun.sleep(0);
  expect(watch.getSnapshot()?.interrupted).toBe(true);

  watch.reconnected();
  expect(watches.length).toBe(2);
  expect(watch.getSnapshot()).toMatchObject({ interrupted: false, blocks: [] });
  watches[1]?.observe(chunk("first part"));
  watches[0]?.observe(chunk(" from the dead watcher"));
  expect(watch.getSnapshot()?.blocks).toEqual([{ type: "thinking", thinking: "first part" }]);
});
