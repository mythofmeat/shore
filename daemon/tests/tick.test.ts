/**
 * The per-tick trigger decision's own behaviour.
 *
 * `tick_parity.test.ts` replays a 400-case sweep recorded from the Rust and is
 * the stronger check for anything the sweep's value sets can reach. This file
 * says what the answers mean, and covers the retry backoff, which is a separate
 * function the sweep does not touch.
 *
 * Each test here mirrors one in `crates/daemon/src/autonomy/manager.rs`.
 */

import { describe, expect, test } from "bun:test";

import { backgroundRetryDelayMs, tickDecision, type TickInputs } from "../src/autonomy/tick.ts";

const HOUR_MS = 3_600_000;

/** A tick that fires nothing: every switch on, every threshold unmet. */
function quietTick(overrides: Partial<TickInputs> = {}): TickInputs {
  return {
    autonomyEnabled: true,
    paused: false,
    heartbeatEnabled: true,

    compactionEnabled: true,
    compactionTriggered: false,
    deepArchiveDone: false,
    activeTurnCount: 10,
    minTurns: 4,
    maxTurns: 20,
    idleSecs: 0,
    idleTriggerSecs: 3600,
    archiveAfterSecs: 86_400,

    ...overrides,
  };
}

describe("a quiet tick", () => {
  test("fires nothing but still lets the heartbeat run", () => {
    const d = tickDecision(quietTick());
    expect(d.heartbeatMayTick).toBe(true);
    expect(d.compaction).toBeUndefined();
    expect(d.deepArchive).toBe(false);
  });
});

describe("compaction", () => {
  test("both triggers fire exactly at their thresholds", () => {
    expect(tickDecision(quietTick({ activeTurnCount: 20 })).compaction).toBe("max_turns");
    expect(tickDecision(quietTick({ activeTurnCount: 19 })).compaction).toBeUndefined();

    expect(tickDecision(quietTick({ idleSecs: 3600 })).compaction).toBe("idle");
    expect(tickDecision(quietTick({ idleSecs: 3599 })).compaction).toBeUndefined();
  });

  test("a zero threshold is an off switch, not an always-on one", () => {
    const flooded = { activeTurnCount: 10_000, idleSecs: 10_000_000 };
    expect(tickDecision(quietTick(flooded)).compaction).toBeDefined();

    expect(
      tickDecision(quietTick({ ...flooded, maxTurns: 0, idleTriggerSecs: 0 })).compaction,
    ).toBeUndefined();
    expect(
      tickDecision(quietTick({ ...flooded, maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 0 }))
        .deepArchive,
    ).toBe(false);
  });

  test("a conversation below min turns compacts on neither trigger", () => {
    // Its safety net is the deep archive, which has no turn threshold.
    const short = quietTick({ activeTurnCount: 3, idleSecs: 10_000_000 });
    expect(tickDecision(short).compaction).toBeUndefined();
    expect(tickDecision(short).deepArchive).toBe(true);
  });

  test("max turns wins when both triggers are satisfied", () => {
    // Only the log line distinguishes them, but the order decides which one a
    // reader sees when a long conversation also goes quiet.
    expect(tickDecision(quietTick({ activeTurnCount: 50, idleSecs: 10_000 })).compaction).toBe(
      "max_turns",
    );
  });
});

describe("the deep archive", () => {
  test("fires exactly at its threshold", () => {
    const at = { activeTurnCount: 1, idleSecs: 86_400 };
    expect(tickDecision(quietTick(at)).deepArchive).toBe(true);
    expect(tickDecision(quietTick({ ...at, idleSecs: 86_399 })).deepArchive).toBe(false);
  });

  test("yields to a compaction firing on the same tick", () => {
    // They share one latch; running both would have the second work from what
    // the first had already archived.
    const both = quietTick({ activeTurnCount: 50, idleSecs: 10_000_000, archiveAfterSecs: 5 });
    expect(tickDecision(both).compaction).toBe("max_turns");
    expect(tickDecision(both).deepArchive).toBe(false);
  });

  test("is suppressed by a latch taken on an earlier tick", () => {
    // Checking only "nothing fired now" would miss this: when the latch was
    // taken earlier, nothing fires now to block it.
    const latched = quietTick({
      compactionTriggered: true,
      activeTurnCount: 1,
      idleSecs: 10_000_000,
    });
    expect(tickDecision(latched).compaction).toBeUndefined();
    expect(tickDecision(latched).deepArchive).toBe(false);
  });

  test("is suppressed once it has already run for this idle period", () => {
    const done = quietTick({ deepArchiveDone: true, activeTurnCount: 1, idleSecs: 10_000_000 });
    expect(tickDecision(done).deepArchive).toBe(false);
  });
});

describe("the master switches", () => {
  test("pausing stops the heartbeat and nothing else", () => {
    // Easy to assume otherwise: a paused character still compacts and still
    // archives. Pause is a switch on speaking, not on housekeeping.
    const d = tickDecision(
      quietTick({
        paused: true,
        activeTurnCount: 50,
        idleSecs: 10_000_000,
      }),
    );
    expect(d.heartbeatMayTick).toBe(false);
    expect(d.compaction).toBe("max_turns");
  });

  test("disabling autonomy stops every trigger at once", () => {
    const d = tickDecision(
      quietTick({
        autonomyEnabled: false,
        activeTurnCount: 50,
        idleSecs: 10_000_000,
      }),
    );
    expect(d.heartbeatMayTick).toBe(false);
    expect(d.compaction).toBeUndefined();
    expect(d.deepArchive).toBe(false);
  });

  test("disabling compaction leaves the heartbeat alone", () => {
    const d = tickDecision(
      quietTick({
        compactionEnabled: false,
        activeTurnCount: 50,
        idleSecs: 10_000_000,
      }),
    );
    expect(d.compaction).toBeUndefined();
    expect(d.deepArchive).toBe(false);
    expect(d.heartbeatMayTick).toBe(true);
  });

  test("the heartbeat gate reads all three switches", () => {
    expect(tickDecision(quietTick()).heartbeatMayTick).toBe(true);
    expect(tickDecision(quietTick({ paused: true })).heartbeatMayTick).toBe(false);
    expect(tickDecision(quietTick({ autonomyEnabled: false })).heartbeatMayTick).toBe(false);
    expect(tickDecision(quietTick({ heartbeatEnabled: false })).heartbeatMayTick).toBe(false);
  });
});

describe("the background retry backoff", () => {
  test("doubles from a minute, then caps at an hour", () => {
    // The first failure is one minute, not two: the exponent is `count - 1`,
    // and the clamp at zero keeps counts 0 and 1 together.
    expect(backgroundRetryDelayMs(0)).toBe(60_000);
    expect(backgroundRetryDelayMs(1)).toBe(60_000);
    expect(backgroundRetryDelayMs(2)).toBe(120_000);
    expect(backgroundRetryDelayMs(3)).toBe(240_000);
    expect(backgroundRetryDelayMs(4)).toBe(480_000);
    expect(backgroundRetryDelayMs(5)).toBe(960_000);
    expect(backgroundRetryDelayMs(6)).toBe(1_920_000);
    // 60s × 2^6 = 3840s, clamped to the hour ceiling.
    expect(backgroundRetryDelayMs(7)).toBe(HOUR_MS);
    // And it stays there rather than shifting into overflow.
    expect(backgroundRetryDelayMs(50)).toBe(HOUR_MS);
    expect(backgroundRetryDelayMs(4_294_967_295)).toBe(HOUR_MS);
  });
});
