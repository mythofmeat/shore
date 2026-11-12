import { expect, test } from "bun:test";

import { decodeState, encodeState, NO_DREAM, type AutonomyStateFile } from "../src/autonomy/state_file.ts";

const T0 = Date.UTC(2026, 9, 30, 12);
const HOUR = 3_600_000;

function state(over: Partial<AutonomyStateFile> = {}): AutonomyStateFile {
  return {
    wakesWithoutUser: 2,
    lastUserAt: T0 - HOUR,
    forcedDormant: false,
    asked: undefined,
    lastHeartbeatAt: undefined,
    notBefore: undefined,
    coveredTurnCount: 7,
    keepalive: undefined,
    dream: NO_DREAM,
    ...over,
  };
}

function file(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: 4, ticks_without_user: 0, ...fields });
}

test("what a character's own time keeps comes back from its state file as it was written", () => {
  const empty = state();
  expect(decodeState(encodeState(empty))).toEqual(empty);
  const full = state({ forcedDormant: true, asked: { at: T0 + 2 * HOUR, reason: "check the tide table" }, lastHeartbeatAt: T0, notBefore: T0 + HOUR });
  expect(decodeState(encodeState(full))).toEqual(full);
  const written = JSON.parse(encodeState(full)) as Record<string, unknown>;
  expect(written).toMatchObject({
    version: 4, ticks_without_user: 2, forced_dormant: true, covered_turn_count: 7,
    next_wake_at: "2026-10-30T14:00:00+00:00", wake_reason: "check the tide table", wake_anchor_at: "2026-10-30T12:00:00+00:00", not_before: "2026-10-30T13:00:00+00:00",
  });
  expect(JSON.parse(encodeState(empty))).toMatchObject({ forced_dormant: false, next_wake_at: null, wake_reason: null, wake_anchor_at: null, not_before: null });
  expect(decodeState(encodeState(state({ asked: { at: T0, reason: "" } })))?.asked).toEqual({ at: T0, reason: "" });
});

test("a state file from before heartbeats joined the triggers is read for what it meant then", () => {
  const defaulted = decodeState(file({ next_wake_at: "2026-10-30T13:00:00+00:00", default_wake: true, wake_anchor_at: "2026-10-30T12:00:00+00:00", wake_reason: "stale" }));
  expect([defaulted?.asked, defaulted?.lastHeartbeatAt]).toEqual([undefined, T0]);

  const asked = decodeState(file({ next_wake_at: "2026-10-30T13:00:00+00:00", default_wake: false, wake_reason: "after the restart" }));
  expect([asked?.asked, asked?.lastHeartbeatAt, asked?.notBefore, asked?.forcedDormant]).toEqual([{ at: T0 + HOUR, reason: "after the restart" }, undefined, undefined, false]);

  expect(decodeState(file({ next_wake_at: "2026-10-30T13:00:00+00:00", wake_reason: null }))?.asked).toEqual({ at: T0 + HOUR, reason: "" });
  expect(decodeState(file({ next_wake_at: null, wake_reason: "left behind" }))?.asked).toBeUndefined();
  expect(decodeState(file({ forced_dormant: true }))?.forcedDormant).toBe(true);
  expect(decodeState(file({ forced_dormant: "yes" }))?.forcedDormant).toBe(false);
});

test("a state file that doesn't say how many wakes went unanswered isn't taken for one", () => {
  expect(decodeState(JSON.stringify({ version: 4 }))).toBeUndefined();
  expect(decodeState(file({ ticks_without_user: "3" }))).toBeUndefined();
  expect(decodeState(file({ ticks_without_user: 3 }))?.wakesWithoutUser).toBe(3);
});
