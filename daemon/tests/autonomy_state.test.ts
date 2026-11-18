import { expect, test } from "bun:test";

import { decodeState, encodeState, type AutonomyStateFile } from "../src/autonomy/state_file.ts";

const T0 = Date.UTC(2026, 9, 30, 12);
const HOUR = 3_600_000;

function state(over: Partial<AutonomyStateFile> = {}): AutonomyStateFile {
  return {
    wakesWithoutUser: 2,
    lastUserAt: T0 - HOUR,
    forcedDormant: false,
    keepalive: undefined,
    ...over,
  };
}

function file(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: 4, ticks_without_user: 0, ...fields });
}

test("what a character's triggers and wakes keep comes back from its state file as it was written", () => {
  const awake = state();
  expect(decodeState(encodeState(awake))).toEqual(awake);
  const asleep = state({ forcedDormant: true, lastUserAt: undefined });
  expect(decodeState(encodeState(asleep))).toEqual(asleep);
  expect(JSON.parse(encodeState(asleep))).toMatchObject({ version: 4, ticks_without_user: 2, forced_dormant: true, last_user_at: null });
  expect(JSON.parse(encodeState(awake))).toMatchObject({ forced_dormant: false, last_user_at: "2026-10-30T11:00:00+00:00" });
  expect(encodeState(awake)).toStartWith('{\n  "version": 4,\n  "ticks_without_user": 2,\n');
});

test("a state file that isn't one, or is from another version, is not read", () => {
  for (const raw of ["{not json", "null", "[]", '"text"', "4", file({ version: 3, ticks_without_user: 1 })]) expect(decodeState(raw), raw).toBeUndefined();
});

test("a state file from when compaction wrote memory is read for what still applies, and the count of turns it covered is let go", () => {
  expect(decodeState(file({ ticks_without_user: 1, covered_turn_count: 3 }))).toEqual(state({ wakesWithoutUser: 1, lastUserAt: undefined }));
  expect(Object.keys(JSON.parse(encodeState(state())) as Record<string, unknown>).filter((key) => key.includes("covered"))).toEqual([]);
});

test("a state file from when Shore had heartbeats is read for what still applies, and the heartbeat it had waiting is let go", () => {
  const old = decodeState(file({
    ticks_without_user: 1, last_user_at: "2026-10-30T11:00:00+00:00", forced_dormant: true, covered_turn_count: 3,
    next_wake_at: "2026-10-30T13:00:00+00:00", default_wake: false, wake_reason: "after the restart", wake_anchor_at: "2026-10-30T12:00:00+00:00",
  }));
  expect(old).toEqual(state({ wakesWithoutUser: 1, forcedDormant: true }));
  expect(Object.keys(JSON.parse(encodeState(state())) as Record<string, unknown>).filter((key) => key.includes("wake"))).toEqual([]);
  expect(decodeState(file({ forced_dormant: "yes" }))?.forcedDormant).toBe(false);
});

test("a state file from when Shore had dreams is read for what still applies, and the dream schedule it kept is let go", () => {
  const old = decodeState(file({
    ticks_without_user: 1, last_user_at: "2026-10-30T11:00:00+00:00", covered_turn_count: 3,
    dream_last_at: "2026-10-29T03:00:00+00:00", dream_turns_since: 12, dream_retry_at: null, dream_failures: 1, dream_forced: true,
  }));
  expect(old).toEqual(state({ wakesWithoutUser: 1 }));
  expect(Object.keys(JSON.parse(encodeState(state())) as Record<string, unknown>).filter((key) => key.startsWith("dream"))).toEqual([]);
});

test("a state file that doesn't say how many wakes went unanswered isn't taken for one", () => {
  expect(decodeState(JSON.stringify({ version: 4 }))).toBeUndefined();
  expect(decodeState(file({ ticks_without_user: "3" }))).toBeUndefined();
  expect(decodeState(file({ ticks_without_user: 3 }))?.wakesWithoutUser).toBe(3);
});
