import { describe, expect, test } from "bun:test";

import { CompactionWatch, trimmedBlocks } from "../src/browser/chat/compaction_watch.ts";
import type { CompactionPassEnd } from "../src/protocol/CompactionPassEnd.ts";
import type { CompactionWatchResult } from "../src/protocol/CompactionWatchResult.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const MIB = 1024 * 1024;
const RUNNING = { thread: "main", trigger: "idle", started_at: "2026-11-03T00:00:00Z", turns: 12 } as const;
const PASS: CompactionPassEnd = { thread: "main", trigger: "idle", started_at: "2026-11-03T00:00:00Z", ended_at: "2026-11-03T00:07:00Z", report: null, error: null };
const METADATA = { model: "opus", tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, timing: { total_ms: 1, ttft_ms: 1 } };

const thought = (text: string): ServerMessage => ({ type: "stream_chunk", text, content_type: "thinking", subagent: "compaction" });
const said = (text: string): ServerMessage => ({ type: "stream_chunk", text, content_type: "text" });
const ended = (content: string): ServerMessage => ({ type: "stream_end", content, metadata: METADATA, is_final: true });
const started: ServerMessage = { type: "stream_start", regen: false };
const phase = (name: string): ServerMessage => ({ type: "phase", phase: name });
const called = (id: string, name: string, input: unknown): ServerMessage => ({ type: "tool_call", tool_id: id, tool_name: name, input });
const answered = (id: string, output: string, isError = false): ServerMessage => ({ type: "tool_result", tool_id: id, tool_name: "read", output, is_error: isError });

interface Pending<T> { resolve: (value: T) => void; reject: (reason: unknown) => void }

function rig(schedule?: (callback: () => void) => void) {
  const watches: (Pending<CompactionWatchResult> & { observe: (message: ServerMessage) => void })[] = [];
  const stops: Pending<CompactionWatchResult>[] = [];
  const watch = new CompactionWatch({
    watch: async (observe) => await new Promise<CompactionWatchResult>((resolve, reject) => { watches.push({ observe, resolve, reject }); }),
    stop: async () => await new Promise<CompactionWatchResult>((resolve, reject) => { stops.push({ resolve, reject }); }),
  }, schedule);
  let notified = 0;
  watch.subscribe(() => { notified += 1; });
  const feed = (...messages: ServerMessage[]) => { for (const message of messages) watches.at(-1)?.observe(message); };
  return { watch, watches, stops, feed, notified: () => notified };
}

const finished: CompactionWatchResult = { character: "ada", state: "finished", pass: { ...PASS, error: "the provider went away" } };

test("a long pass keeps its newest output and says it dropped the rest, however long one block gets", () => {
  const { watch, feed } = rig();
  watch.open("ada", RUNNING);
  const piece = "x".repeat(64 * 1024);
  for (let index = 0; index < 40; index += 1) feed(thought(piece + String(index)));
  const record = watch.getSnapshot();
  const text = record?.blocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("") ?? "";
  expect(record?.limited).toBe(true);
  expect(text.length).toBeLessThanOrEqual(MIB);
  expect(text.endsWith(`${piece}39`)).toBe(true);
});

describe("trimming a pass's blocks", () => {
  test("drops the oldest blocks first and never keeps a block out of order", () => {
    const blocks: ContentBlock[] = Array.from({ length: 10 }, (_, index) => ({ type: "text", text: String(index).padEnd(10, ".") }));
    const trimmed = trimmedBlocks(blocks, 35);
    expect(trimmed.limited).toBe(true);
    expect(trimmed.blocks.map((block) => block.type === "text" ? block.text[0] : "")).toEqual(["7", "8", "9"]);
  });

  test("keeps the end of a newest text or thinking block too long on its own, and drops any other", () => {
    expect(trimmedBlocks([{ type: "text", text: "abcdef" }], 3)).toEqual({ blocks: [{ type: "text", text: "def" }], limited: true });
    expect(trimmedBlocks([{ type: "thinking", thinking: "abcdef" }], 3)).toEqual({ blocks: [{ type: "thinking", thinking: "def" }], limited: true });
    expect(trimmedBlocks([{ type: "tool_result", tool_use_id: "t", content: "abcdef" }], 3)).toEqual({ blocks: [], limited: true });
    expect(trimmedBlocks([])).toEqual({ blocks: [], limited: false });
  });

  test("counts a tool call by its name and arguments, a result by its content, and a picture as nothing", () => {
    const call: ContentBlock = { type: "tool_use", id: "t", name: "nm", input: { a: 1 } };
    expect(trimmedBlocks([call], 9).limited).toBe(false);
    expect(trimmedBlocks([call], 8).limited).toBe(true);
    const plain: ContentBlock = { type: "tool_result", tool_use_id: "t", content: "abcd" };
    expect(trimmedBlocks([plain], 4).limited).toBe(false);
    expect(trimmedBlocks([plain], 3).limited).toBe(true);
    const nested: ContentBlock = { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "ab" }] };
    const nestedSize = JSON.stringify([{ type: "text", text: "ab" }]).length;
    expect(trimmedBlocks([nested], nestedSize).limited).toBe(false);
    expect(trimmedBlocks([nested], nestedSize - 1).limited).toBe(true);
    const picture: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(50) } };
    expect(trimmedBlocks([{ type: "text", text: "ab" }, picture], 2)).toEqual({ blocks: [{ type: "text", text: "ab" }, picture], limited: false });
  });
});

describe("watching a pass", () => {
  test("a new pass starts empty, with what is known of it, and tells its subscribers", () => {
    const { watch, watches, notified } = rig();
    watch.open("ada", { ...RUNNING, first_at: "2026-11-01T00:00:00Z", last_at: "2026-11-02T00:00:00Z" });
    expect(watch.getSnapshot()).toEqual({
      character: "ada", thread: "main", trigger: "idle", startedAt: RUNNING.started_at, endedAt: null, turns: 12, firstAt: "2026-11-01T00:00:00Z", lastAt: "2026-11-02T00:00:00Z",
      blocks: [], limited: false, phase: null, running: true, stopping: false, interrupted: false, result: null, failed: false,
    });
    expect(notified()).toBe(1);
    watch.open("bo", null);
    expect(watch.getSnapshot()).toMatchObject({ character: "bo", thread: null, trigger: null, startedAt: null, turns: null, firstAt: null, lastAt: null, running: true });
    expect(watches).toHaveLength(2);
  });

  test("frames become blocks: chunks of a kind join, an ending adds only what was not streamed, and tools are blocks of their own", () => {
    const { watch, feed } = rig();
    watch.open("ada", RUNNING);
    feed(phase("reading"), said("a"), said("b"), ended("ab"), ended("c"), ended(""));
    expect(watch.getSnapshot()).toMatchObject({ phase: "reading", blocks: [{ type: "text", text: "abc" }] });
    feed(thought("t1"), thought("t2"), said("d"), called("c_1", "read", { path: "a" }), answered("c_1", "contents", true), said("e"), said("f"));
    feed(said("p"), phase("writing"), ended("p"));
    feed(said("q"), started, ended("r"));
    feed(thought("u"), said("v"));
    expect(watch.getSnapshot()?.phase).toBe("writing");
    expect(watch.getSnapshot()?.blocks).toEqual([
      { type: "text", text: "abc" },
      { type: "thinking", thinking: "t1t2" },
      { type: "text", text: "d" },
      { type: "tool_use", id: "c_1", name: "read", input: { path: "a" } },
      { type: "tool_result", tool_use_id: "c_1", content: "contents", is_error: true },
      { type: "text", text: "efpqr" },
      { type: "thinking", thinking: "u" },
      { type: "text", text: "v" },
    ]);
  });

  test("every frame that changes the pass gives a new snapshot and tells subscribers, and others are ignored", () => {
    const { watch, feed, notified } = rig();
    watch.open("ada", RUNNING);
    for (const frame of [phase("x"), started, said("a"), ended("a"), called("c", "read", {}), answered("c", "")]) {
      const before = watch.getSnapshot();
      const count = notified();
      feed(frame);
      expect(watch.getSnapshot(), frame.type).not.toBe(before);
      expect(notified(), frame.type).toBe(count + 1);
    }
    const before = watch.getSnapshot();
    feed({ type: "ping" });
    expect(watch.getSnapshot()).toBe(before);
    expect(notified()).toBe(7);
  });

  test("streamed frames tell subscribers once per scheduled turn", () => {
    const queued: (() => void)[] = [];
    const { watch, feed, notified } = rig((callback) => { queued.push(callback); });
    watch.open("ada", RUNNING);
    expect(notified()).toBe(1);
    feed(said("a"), said("b"));
    expect(queued).toHaveLength(1);
    expect(notified()).toBe(1);
    queued.shift()?.();
    expect(notified()).toBe(2);
    feed(said("c"));
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(notified()).toBe(3);
  });

  test("a subscriber that leaves hears nothing more", () => {
    const { watch, notified } = rig();
    let heard = 0;
    const leave = watch.subscribe(() => { heard += 1; });
    watch.open("ada", RUNNING);
    leave();
    watch.dismiss();
    expect(heard).toBe(1);
    expect(notified()).toBe(2);
  });

  test("news of the running pass updates its details only when they changed, and only while it runs", async () => {
    const { watch, watches, feed, notified } = rig();
    watch.describe(RUNNING);
    expect(watch.getSnapshot()).toBeNull();
    watch.open("ada", RUNNING);
    const before = watch.getSnapshot();
    watch.describe({ ...RUNNING });
    expect(watch.getSnapshot()).toBe(before);
    expect(notified()).toBe(1);
    watch.open("ada", { ...RUNNING, turns: 20, trigger: "manual", first_at: "2026-11-01T00:00:00Z", last_at: "2026-11-02T00:00:00Z" });
    expect(watches).toHaveLength(1);
    expect(notified()).toBe(2);
    expect(watch.getSnapshot()).toMatchObject({ turns: 20, trigger: "manual", firstAt: "2026-11-01T00:00:00Z", lastAt: "2026-11-02T00:00:00Z" });
    watch.describe({ ...RUNNING, turns: 20, thread: "side" });
    expect(watch.getSnapshot()).toMatchObject({ thread: "side", trigger: "idle", firstAt: null, lastAt: null });
    watch.describe({ ...RUNNING, turns: 20, thread: "side", started_at: "2026-11-03T00:01:00Z" });
    expect(watch.getSnapshot()?.startedAt).toBe("2026-11-03T00:01:00Z");
    watch.describe({ thread: "side", trigger: "idle", started_at: "2026-11-03T00:01:00Z" });
    expect(watch.getSnapshot()?.turns).toBeNull();
    feed(said("kept"));
    watches[0]?.resolve({ character: "ada", state: "finished", pass: PASS });
    await Bun.sleep(0);
    const done = watch.getSnapshot();
    watch.describe({ ...RUNNING, turns: 99 });
    expect(watch.getSnapshot()).toBe(done);
  });

  test("an ending pass says how it went and clears what was in progress", async () => {
    const { watch, watches } = rig();
    watch.open("ada", { ...RUNNING, thread: "early", started_at: "2026-11-02T00:00:00Z" });
    watches[0]?.resolve({ character: "ada", state: "finished", pass: PASS });
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toMatchObject({ running: false, stopping: false, interrupted: false, phase: null, failed: false, result: "There was nothing to compact.", thread: "main", trigger: "idle", startedAt: PASS.started_at, endedAt: PASS.ended_at });

    watch.open("bo", RUNNING);
    watches[1]?.resolve({ character: "bo", state: "cancelled", pass: null });
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toMatchObject({ character: "bo", running: false, interrupted: false, failed: false, result: "No compaction is running.", thread: "main", endedAt: null });
  });

  test("the record of a finished pass stays until it is dismissed, and a new pass starts a new record", async () => {
    const { watch, watches, feed } = rig();
    watch.open("ada", RUNNING);
    feed(thought("thinking about it"));
    watches[0]?.resolve(finished);
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

  test("a dismissed pass ignores whatever its watch still sends", async () => {
    const { watch, watches, feed, notified } = rig();
    watch.open("ada", RUNNING);
    watch.dismiss();
    expect(notified()).toBe(2);
    feed(phase("x"), said("late"));
    watches[0]?.resolve(finished);
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toBeNull();
    expect(notified()).toBe(2);
  });

  test("a new pass forgets how much the last one had streamed", async () => {
    const { watch, watches, feed } = rig();
    watch.open("ada", RUNNING);
    feed(said("a"), answered("c", "x".repeat(MIB - 1)));
    expect(watch.getSnapshot()?.limited).toBe(false);
    watches[0]?.resolve(finished);
    await Bun.sleep(0);
    watch.open("ada", { ...RUNNING, started_at: "2026-11-03T01:00:00Z" });
    feed(answered("c", "y".repeat(MIB - 1)), ended("z"));
    expect(watch.getSnapshot()?.limited).toBe(false);
    expect(watch.getSnapshot()?.blocks.map((block) => block.type)).toEqual(["tool_result", "text"]);
  });
});

describe("how much of a pass is kept", () => {
  const quarter = MIB / 4;

  test("everything up to the size limit, then the newest blocks that fit three quarters of it, counting from what was kept", () => {
    const { watch, feed } = rig();
    watch.open("ada", RUNNING);
    for (const name of ["a", "b", "c", "d"]) feed(answered(name, name.repeat(quarter)));
    expect(watch.getSnapshot()?.limited).toBe(false);
    expect(watch.getSnapshot()?.blocks).toHaveLength(4);
    feed(answered("e", "e"));
    const ids = () => watch.getSnapshot()?.blocks.map((block) => block.type === "tool_result" ? block.tool_use_id : "");
    expect(watch.getSnapshot()?.limited).toBe(true);
    expect(ids()).toEqual(["c", "d", "e"]);
    feed(answered("f", "f".repeat(MIB - 2 * quarter - 1)));
    expect(ids()).toEqual(["c", "d", "e", "f"]);
  });

  test("up to the block limit, then the newest of them", () => {
    const { watch, feed } = rig();
    watch.open("ada", RUNNING);
    for (let index = 0; index < 1999; index += 1) feed(answered(String(index), ""));
    feed(answered("big", "x".repeat(MIB - quarter + 1)));
    expect(watch.getSnapshot()?.limited).toBe(false);
    expect(watch.getSnapshot()?.blocks).toHaveLength(2000);
    feed(answered("last", ""));
    expect(watch.getSnapshot()?.limited).toBe(true);
    expect(watch.getSnapshot()?.blocks).toHaveLength(2000);
    expect(watch.getSnapshot()?.blocks.some((block) => block.type === "tool_result" && block.tool_use_id === "big")).toBe(false);
  });

  test("block count alone also trims", () => {
    const { watch, feed } = rig();
    watch.open("ada", RUNNING);
    for (let index = 0; index < 2000; index += 1) feed(answered(String(index), ""));
    expect(watch.getSnapshot()?.limited).toBe(false);
    feed(answered("2000", ""));
    expect(watch.getSnapshot()?.limited).toBe(true);
    expect(watch.getSnapshot()?.blocks[0]).toMatchObject({ tool_use_id: "1" });
  });
});

describe("when the watch's connection drops", () => {
  test("the pass is marked interrupted with the reason, and an older watch failing late changes nothing", async () => {
    const { watch, watches } = rig();
    watch.open("ada", RUNNING);
    watch.open("bo", RUNNING);
    watches[0]?.reject(new Error("late"));
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toMatchObject({ character: "bo", interrupted: false, phase: null });
    watches[1]?.reject(new Error("connection lost"));
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toMatchObject({ character: "bo", interrupted: true, phase: "connection lost" });
    watch.open("cy", RUNNING);
    watches[2]?.reject("socket closed");
    await Bun.sleep(0);
    expect(watch.getSnapshot()).toMatchObject({ character: "cy", interrupted: true, phase: "socket closed" });
  });

  test("a connection lost mid-pass replays from the start when it returns, with nothing doubled", async () => {
    const { watch, watches } = rig();
    watch.open("ada", RUNNING);
    watches[0]?.observe(thought("first part"));
    watches[0]?.reject(new Error("connection lost"));
    await Bun.sleep(0);
    expect(watch.getSnapshot()?.interrupted).toBe(true);

    watch.reconnected();
    expect(watches.length).toBe(2);
    expect(watch.getSnapshot()).toMatchObject({ interrupted: false, blocks: [] });
    watches[1]?.observe(thought("first part"));
    watches[0]?.observe(thought(" from the dead watcher"));
    expect(watch.getSnapshot()?.blocks).toEqual([{ type: "thinking", thinking: "first part" }]);
  });

  test("returning starts the replay afresh, forgetting what had been kept and streamed", async () => {
    const { watch, watches, feed, notified } = rig();
    watch.reconnected();
    expect(watch.getSnapshot()).toBeNull();
    watch.open("ada", RUNNING);
    feed(said("a"), answered("c", "x".repeat(MIB - 1)));
    watch.reconnected();
    expect(watches, "a pass still being watched is left alone").toHaveLength(1);
    expect(watch.getSnapshot()?.blocks).toHaveLength(2);
    watches[0]?.reject(new Error("connection lost"));
    await Bun.sleep(0);
    const count = notified();
    watch.reconnected();
    expect(notified()).toBe(count + 1);
    expect(watch.getSnapshot()).toMatchObject({ blocks: [], limited: false, interrupted: false, phase: null });
    feed(answered("c", "y".repeat(MIB - 1)), ended("z"));
    expect(watch.getSnapshot()?.limited).toBe(false);
    expect(watch.getSnapshot()?.blocks.map((block) => block.type)).toEqual(["tool_result", "text"]);
  });

  test("returning clears a pass that had been cut short", async () => {
    const { watch, watches, feed } = rig();
    watch.open("ada", RUNNING);
    feed(answered("c", "x".repeat(MIB + 1)));
    expect(watch.getSnapshot()).toMatchObject({ blocks: [], limited: true });
    watches[0]?.reject(new Error("connection lost"));
    await Bun.sleep(0);
    watch.reconnected();
    expect(watch.getSnapshot()?.limited).toBe(false);
  });
});

describe("stopping a pass", () => {
  test("marks it stopping, and ends it when the daemon says nothing is running any more", async () => {
    const { watch, stops, notified } = rig();
    watch.open("ada", RUNNING);
    const stopping = watch.stop();
    expect(watch.getSnapshot()?.stopping).toBe(true);
    expect(notified()).toBe(2);
    stops[0]?.resolve({ character: "ada", state: "idle", pass: null });
    expect(await stopping).toBe("No compaction is running.");
    expect(watch.getSnapshot()).toMatchObject({ running: false, stopping: false, result: "No compaction is running." });
  });

  test("leaves a pass the daemon still reports to its watch", async () => {
    const { watch, stops } = rig();
    watch.open("ada", RUNNING);
    const stopping = watch.stop();
    stops[0]?.resolve({ character: "ada", state: "cancelled", pass: null });
    expect(await stopping).toBe("No compaction is running.");
    expect(watch.getSnapshot()).toMatchObject({ running: true, stopping: true, result: null });
  });

  test("changes nothing on a pass that already ended, or when nothing was open", async () => {
    const { watch, watches, stops } = rig();
    const nothing = watch.stop();
    expect(watch.getSnapshot()).toBeNull();
    stops[0]?.resolve({ character: "ada", state: "idle", pass: null });
    expect(await nothing).toBe("No compaction is running.");
    expect(watch.getSnapshot()).toBeNull();

    watch.open("ada", RUNNING);
    watches[0]?.resolve(finished);
    await Bun.sleep(0);
    const late = watch.stop();
    stops[1]?.resolve({ character: "ada", state: "idle", pass: null });
    await late;
    expect(watch.getSnapshot()).toMatchObject({ running: false, result: "Compaction failed: the provider went away." });
  });

  test("a stop that fails is no longer stopping, and says why", async () => {
    const { watch, stops } = rig();
    watch.open("ada", RUNNING);
    const stopping = watch.stop();
    stops[0]?.reject(new Error("daemon gone"));
    expect(await stopping.then(() => "", (error: unknown) => String(error))).toBe("Error: daemon gone");
    expect(watch.getSnapshot()).toMatchObject({ running: true, stopping: false });
  });
});
