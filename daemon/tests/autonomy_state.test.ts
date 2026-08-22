import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeState,
  encodeState,
  fromRfc3339,
  loadState,
  saveState,
  STATE_FILENAME,
  STATE_VERSION,
  toRfc3339,
  type AutonomyStateFile,
} from "../src/autonomy/state_file.ts";


async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shore-state-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the file's identity", () => {
  test("is a versioned name, so an older daemon's file can be told apart", () => {
    expect(STATE_VERSION).toBeGreaterThan(0);
    expect(STATE_FILENAME).toBe("autonomy_state.json");
  });
});

describe("what a state file holds", () => {
  const POPULATED: AutonomyStateFile = {
    ticksWithoutUser: 3,
    nextWakeAt: Date.parse("2026-04-30T09:00:00Z"),
    lastUserAt: Date.parse("2026-04-30T08:00:00Z"),
    coveredTurnCount: 12,
    keepalive: {
      model: "claude-opus-4-6",
      intervalMs: 3_300_000,
      lastWarmAt: Date.parse("2026-04-30T08:30:00Z"),
      lastActiveAt: Date.parse("2026-04-30T08:29:00Z"),
    },
  };

  const BARE: AutonomyStateFile = {
    ticksWithoutUser: 0,
    nextWakeAt: undefined,
    lastUserAt: undefined,
    coveredTurnCount: 0,
    keepalive: undefined,
  };

  test("survives a round trip through the file it writes", () => {
    for (const [name, state] of [
      ["populated", POPULATED],
      ["bare", BARE],
    ] as const) {
      expect(decodeState(encodeState(state)), name).toEqual(state);
    }
  });

  test("re-encodes byte-identically, so a read-and-write cycle is a no-op", () => {
    for (const [name, state] of [
      ["populated", POPULATED],
      ["bare", BARE],
    ] as const) {
      const once = encodeState(state);
      const twice = encodeState(required(decodeState(once)));
      expect(twice, name).toBe(once);
    }
  });

  test("stamps the version it was written by", () => {
    expect(JSON.parse(encodeState(BARE))).toMatchObject({ version: STATE_VERSION });
  });

  test("writes timestamps as readable instants, not epoch numbers", () => {
    const written = JSON.parse(encodeState(POPULATED)) as Record<string, unknown>;
    expect(written["next_wake_at"]).toBe("2026-04-30T09:00:00+00:00");
    expect(written["last_user_at"]).toBe("2026-04-30T08:00:00+00:00");
  });

  test("always writes every field, using null for what is absent", () => {
    const bare = JSON.parse(encodeState(BARE)) as Record<string, unknown>;
    const populated = JSON.parse(encodeState(POPULATED)) as Record<string, unknown>;
    expect(Object.keys(bare).sort()).toEqual(Object.keys(populated).sort());
    expect(bare["next_wake_at"]).toBeNull();
    expect(bare["keepalive_model"]).toBeNull();
  });

  test("keeps the keepalive block together, or leaves all of it out", () => {
    const populated = JSON.parse(encodeState(POPULATED)) as Record<string, unknown>;
    expect(populated["keepalive_model"]).toBe("claude-opus-4-6");
    expect(populated["keepalive_interval_ms"]).toBe(3_300_000);
    expect(decodeState(encodeState(BARE))?.keepalive).toBeUndefined();
  });
});

describe("refusing what cannot be trusted", () => {
  test("a version that is not this one is ignored, not migrated", () => {
    const future = JSON.stringify({ version: 99, ticks_without_user: 0 });
    expect(decodeState(future)).toBeUndefined();

    const older = JSON.stringify({ version: STATE_VERSION - 1, ticks_without_user: 0 });
    expect(decodeState(older)).toBeUndefined();

    const missing = JSON.stringify({ ticks_without_user: 0 });
    expect(decodeState(missing)).toBeUndefined();
  });

  test("a version of the right value but the wrong type is ignored", () => {
    const stringly = JSON.stringify({ version: "4", ticks_without_user: 0 });
    expect(decodeState(stringly)).toBeUndefined();
  });

  test("corrupt bytes are ignored", () => {
    expect(decodeState("not valid json {{{{")).toBeUndefined();
    expect(decodeState("")).toBeUndefined();
    expect(decodeState("null")).toBeUndefined();
    expect(decodeState("[]")).toBeUndefined();
  });

  test("a tick count of the wrong type is ignored", () => {
    const bad = JSON.stringify({ version: STATE_VERSION, ticks_without_user: "three" });
    expect(decodeState(bad)).toBeUndefined();
  });

  test("a missing covered turn count reads as zero rather than refusing", () => {
    const raw = JSON.stringify({ version: STATE_VERSION, ticks_without_user: 1 });
    expect(decodeState(raw)?.coveredTurnCount).toBe(0);
  });
});

describe("the keepalive schedule is all-or-nothing", () => {
  const full = {
    version: STATE_VERSION,
    ticks_without_user: 0,
    keepalive_model: "claude-opus-4-6",
    keepalive_interval_ms: 3_300_000,
    keepalive_last_warm_at: "2026-04-30T08:30:00+00:00",
    keepalive_last_active_at: "2026-04-30T08:29:00+00:00",
  };

  test("all four fields arm it", () => {
    expect(decodeState(JSON.stringify(full))?.keepalive).toBeDefined();
  });

  test.each([
    "keepalive_model",
    "keepalive_interval_ms",
    "keepalive_last_warm_at",
    "keepalive_last_active_at",
  ])("dropping %s leaves it down", (field) => {
    const partial: Record<string, unknown> = { ...full };
    delete partial[field];
    const decoded = decodeState(JSON.stringify(partial));
    expect(decoded, "the rest of the state still loads").toBeDefined();
    expect(decoded?.keepalive, `${field} missing`).toBeUndefined();
  });

  test("an unparseable timestamp leaves it down", () => {
    const decoded = decodeState(
      JSON.stringify({ ...full, keepalive_last_warm_at: "yesterday-ish" }),
    );
    expect(decoded).toBeDefined();
    expect(decoded?.keepalive).toBeUndefined();
  });
});

describe("timestamps", () => {
  test("round-trip through the Rust's spelling", () => {
    const ms = Date.parse("2026-04-30T09:00:00Z");
    expect(toRfc3339(ms)).toBe("2026-04-30T09:00:00+00:00");
    expect(fromRfc3339(toRfc3339(ms))).toBe(ms);
  });

  test("an offset other than UTC still parses", () => {
    expect(fromRfc3339("2026-04-30T20:00:00+11:00")).toBe(Date.parse("2026-04-30T09:00:00Z"));
  });

  test("nonsense is not a time", () => {
    expect(fromRfc3339("yesterday-ish")).toBeUndefined();
    expect(fromRfc3339("")).toBeUndefined();
  });
});

describe("reading and writing the file", () => {
  test("a missing file is not an error", async () => {
    await inTempDir(async (dir) => {
      expect(await loadState(join(dir, STATE_FILENAME))).toBeUndefined();
    });
  });

  test("a saved state loads back with the same numbers", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, STATE_FILENAME);
      const state: AutonomyStateFile = {
        ticksWithoutUser: 7,
        nextWakeAt: Date.parse("2026-04-30T09:00:00Z"),
        lastUserAt: undefined,
        coveredTurnCount: 12,
        keepalive: undefined,
      };

      expect(await saveState(path, state)).toBe(true);
      expect(await loadState(path)).toEqual(state);
    });
  });

  test("a save that cannot land says so", async () => {
    await inTempDir(async (dir) => {
      const blocker = join(dir, "blocker");
      await Bun.write(blocker, "not a directory");
      const wrote = await saveState(join(blocker, STATE_FILENAME), {
        ticksWithoutUser: 0,
        nextWakeAt: undefined,
        lastUserAt: undefined,
        coveredTurnCount: 0,
        keepalive: undefined,
      });
      expect(wrote).toBe(false);
    });
  });
});
