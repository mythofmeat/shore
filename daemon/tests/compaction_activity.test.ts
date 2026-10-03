import { describe, expect, test } from "bun:test";

import { cancelPass, lastPass, runningPass, startPass, watchPass } from "../src/memory/compaction/activity.ts";
import type { CompactionOutcome } from "../src/memory/compaction/types.ts";
import { passEnd } from "../src/commands/compact.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { outcomeOf } from "./support/outcome.ts";

let sequence = 0;
const scope = (): { dataDir: string; character: string } => ({ dataDir: `/activity-${String(++sequence)}`, character: "ada" });

const chunk = (text: string, contentType = "thinking", subagent: string | null = "compaction"): ServerMessage =>
  ({ type: "stream_chunk", rid: null, text, content_type: contentType, subagent, task_id: null });
const phase = (text: string): ServerMessage => ({ type: "phase", rid: null, phase: text, model: null });
const toolCall = (name: string): ServerMessage =>
  ({ type: "tool_call", rid: null, tool_id: `${name}-1`, tool_name: name, input: {}, subagent: "compaction", task_id: null });

const paused: CompactionOutcome = {
  kind: "paused", conversationId: "ada", checkpointId: "c1", messageCount: 4, compactedTurns: 2,
  toolRounds: 1, toolsCalled: ["bash"], reason: "cancelled", detail: "stopped",
};

describe("a running pass", () => {
  test("a watcher who joins late is caught up with merged text, then follows live frames to the end", async () => {
    const { dataDir, character } = scope();
    const pass = startPass(dataDir, { character, thread: "main", trigger: "idle", startedAt: 1 });
    pass.emit(phase("compacting round 1"));
    pass.emit(chunk("Reading "));
    pass.emit(chunk("the turns"));
    pass.emit(chunk("Elsewhere", "thinking", null));
    pass.emit(chunk("Done.", "text", null));
    pass.emit(toolCall("edit"));

    const seen: ServerMessage[] = [];
    const watching = watchPass(dataDir, character, (frame) => seen.push(frame));
    expect(seen).toEqual([
      phase("compacting round 1"), chunk("Reading the turns"), chunk("Elsewhere", "thinking", null), chunk("Done.", "text", null), toolCall("edit"),
    ]);
    pass.emit(chunk(" live"));
    pass.finish(paused);
    const ended = await watching;
    expect(seen.at(-1)).toEqual(chunk(" live"));
    expect(ended).toMatchObject({ character, thread: "main", trigger: "idle", startedAt: 1, end: { kind: "outcome", outcome: paused } });
  });

  test("its frames still reach whoever started it, and its progress reads back", () => {
    const { dataDir, character } = scope();
    const upstream: ServerMessage[] = [];
    const pass = startPass(dataDir, { character, thread: "side", trigger: "manual", startedAt: 5 }, (frame) => upstream.push(frame));
    expect(runningPass(dataDir, character)).toEqual({ character, thread: "side", trigger: "manual", startedAt: 5, phase: undefined, lastTool: undefined });
    pass.emit(phase("compacting round 3"));
    pass.emit(toolCall("bash"));
    expect(upstream).toEqual([phase("compacting round 3"), toolCall("bash")]);
    expect(runningPass(dataDir, character)).toMatchObject({ phase: "compacting round 3", lastTool: "bash" });
    pass.finish(undefined);
    expect(runningPass(dataDir, character)).toBeUndefined();
  });

  test("a watcher that leaves stops receiving frames and the pass carries on", async () => {
    const { dataDir, character } = scope();
    const pass = startPass(dataDir, { character, thread: "main", trigger: "manual", startedAt: 1 });
    const seen: ServerMessage[] = [];
    const leave = new AbortController();
    const watching = watchPass(dataDir, character, (frame) => seen.push(frame), leave.signal);
    leave.abort();
    expect(await outcomeOf(watching)).toThrow("aborted");
    pass.emit(chunk("after"));
    expect(seen).toEqual([]);
    expect(runningPass(dataDir, character)).toBeDefined();
    pass.finish(paused);
  });
});

describe("how a pass ends", () => {
  test("an outcome or a failure is kept as the last pass, but a pass with nothing to do is not", () => {
    const { dataDir, character } = scope();
    startPass(dataDir, { character, thread: "main", trigger: "turn", startedAt: 1 }, undefined, undefined, () => 9).finish(paused);
    expect(lastPass(dataDir, character)).toEqual({ character, thread: "main", trigger: "turn", startedAt: 1, endedAt: 9, end: { kind: "outcome", outcome: paused } });
    startPass(dataDir, { character, thread: "main", trigger: "idle", startedAt: 2 }).finish(undefined);
    expect(lastPass(dataDir, character)?.trigger).toBe("turn");
    startPass(dataDir, { character, thread: "main", trigger: "idle", startedAt: 3 }, undefined, undefined, () => 11).fail(new Error("provider down"));
    expect(lastPass(dataDir, character)).toMatchObject({ trigger: "idle", endedAt: 11, end: { kind: "failed", error: "provider down" } });
    expect(passEnd(lastPass(dataDir, character))).toEqual({
      thread: "main", trigger: "idle", started_at: "1970-01-01T00:00:00.003+00:00", ended_at: "1970-01-01T00:00:00.011+00:00", report: null, error: "provider down",
    });
  });

  test("with nothing running, watching and cancelling return at once", async () => {
    const { dataDir, character } = scope();
    expect(await watchPass(dataDir, character, () => {})).toBeUndefined();
    expect(await cancelPass(dataDir, character, "stop")).toBeUndefined();
  });

  test("cancelling aborts the pass with the reason given and waits for it to end", async () => {
    const { dataDir, character } = scope();
    const upstream = new AbortController();
    const pass = startPass(dataDir, { character, thread: "main", trigger: "idle", startedAt: 1 }, undefined, upstream.signal);
    let settled = false;
    const cancelled = cancelPass(dataDir, character, "Stopped on request").then((ended) => { settled = true; return ended; });
    expect(pass.signal.aborted).toBe(true);
    expect((pass.signal.reason as Error).message).toBe("Stopped on request");
    expect(upstream.signal.aborted).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    pass.finish(paused);
    expect(await cancelled).toMatchObject({ end: { kind: "outcome", outcome: paused } });
  });

  test("a pass also stops when whoever started it stops it", () => {
    const { dataDir, character } = scope();
    const upstream = new AbortController();
    const pass = startPass(dataDir, { character, thread: "main", trigger: "manual", startedAt: 1 }, undefined, upstream.signal);
    upstream.abort(new Error("client gone"));
    expect(pass.signal.aborted).toBe(true);
    pass.finish(paused);
  });

  test("a pass that ends after the next one started still settles its own watchers and leaves the next one running", async () => {
    const { dataDir, character } = scope();
    const first = startPass(dataDir, { character, thread: "main", trigger: "idle", startedAt: 1 });
    const watching = watchPass(dataDir, character, () => {});
    const next = startPass(dataDir, { character, thread: "main", trigger: "manual", startedAt: 2 });
    first.finish(paused);
    expect(await watching).toMatchObject({ trigger: "idle", end: { kind: "outcome", outcome: paused } });
    expect(runningPass(dataDir, character)?.trigger).toBe("manual");
    next.finish(undefined);
    expect(runningPass(dataDir, character)).toBeUndefined();
  });

  test("a second end is ignored", () => {
    const { dataDir, character } = scope();
    const pass = startPass(dataDir, { character, thread: "main", trigger: "manual", startedAt: 1 });
    pass.finish(paused);
    pass.fail(new Error("late"));
    expect(lastPass(dataDir, character)?.end).toEqual({ kind: "outcome", outcome: paused });
  });
});
