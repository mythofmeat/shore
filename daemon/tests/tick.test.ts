import { describe, expect, test } from "bun:test";

import { backgroundRetryDelayMs, tickDecision, type TickInputs } from "../src/autonomy/tick.ts";

const HOUR_MS = 3_600_000;

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
  test("the idle trigger fires exactly at its threshold; turn count alone never fires", () => {
    expect(tickDecision(quietTick({ idleSecs: 3600 })).compaction).toBe("idle");
    expect(tickDecision(quietTick({ idleSecs: 3599 })).compaction).toBeUndefined();

    expect(tickDecision(quietTick({ activeTurnCount: 10_000, idleSecs: 0 })).compaction)
      .toBeUndefined();
  });

  test("a zero threshold is an off switch, not an always-on one", () => {
    const flooded = { activeTurnCount: 10_000, idleSecs: 10_000_000 };
    expect(tickDecision(quietTick(flooded)).compaction).toBeDefined();

    expect(
      tickDecision(quietTick({ ...flooded, idleTriggerSecs: 0 })).compaction,
    ).toBeUndefined();
    expect(
      tickDecision(quietTick({ ...flooded, idleTriggerSecs: 0, archiveAfterSecs: 0 }))
        .deepArchive,
    ).toBe(false);
  });

  test("a conversation below min turns compacts on neither trigger", () => {
    const short = quietTick({ activeTurnCount: 3, idleSecs: 10_000_000 });
    expect(tickDecision(short).compaction).toBeUndefined();
    expect(tickDecision(short).deepArchive).toBe(true);
  });

  test("a conversation past its turn ceiling still compacts once the user goes idle", () => {
    expect(tickDecision(quietTick({ activeTurnCount: 50, idleSecs: 10_000 })).compaction).toBe(
      "idle",
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
    const both = quietTick({ activeTurnCount: 50, idleSecs: 10_000_000, archiveAfterSecs: 5 });
    expect(tickDecision(both).compaction).toBe("idle");
    expect(tickDecision(both).deepArchive).toBe(false);
  });

  test("is suppressed by a latch taken on an earlier tick", () => {
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
    const d = tickDecision(
      quietTick({
        paused: true,
        activeTurnCount: 50,
        idleSecs: 10_000_000,
      }),
    );
    expect(d.heartbeatMayTick).toBe(false);
    expect(d.compaction).toBe("idle");
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
    expect(backgroundRetryDelayMs(0)).toBe(60_000);
    expect(backgroundRetryDelayMs(1)).toBe(60_000);
    expect(backgroundRetryDelayMs(2)).toBe(120_000);
    expect(backgroundRetryDelayMs(3)).toBe(240_000);
    expect(backgroundRetryDelayMs(4)).toBe(480_000);
    expect(backgroundRetryDelayMs(5)).toBe(960_000);
    expect(backgroundRetryDelayMs(6)).toBe(1_920_000);
    expect(backgroundRetryDelayMs(7)).toBe(HOUR_MS);
    expect(backgroundRetryDelayMs(50)).toBe(HOUR_MS);
    expect(backgroundRetryDelayMs(4_294_967_295)).toBe(HOUR_MS);
  });
});

function* everyTick(): Generator<TickInputs> {
  const bools = [false, true];
  for (const autonomyEnabled of bools)
    for (const paused of bools)
      for (const heartbeatEnabled of bools)
        for (const compactionEnabled of bools)
          for (const compactionTriggered of bools)
            for (const deepArchiveDone of bools)
              for (const activeTurnCount of [0, 4, 5, 19, 20])
                for (const minTurns of [0, 4, 20])
                  for (const idleSecs of [0, 100, 86_400])
                    for (const idleTriggerSecs of [0, 100])
                      for (const archiveAfterSecs of [0, 86_400])
                          yield {
                            autonomyEnabled,
                            paused,
                            heartbeatEnabled,
                            compactionEnabled,
                            compactionTriggered,
                            deepArchiveDone,
                            activeTurnCount,
                            minTurns,
                            idleSecs,
                            idleTriggerSecs,
                            archiveAfterSecs,
                          };
}

describe("the sweep", () => {
  test("it is as big as it claims and every case is distinct", () => {
    const all = [...everyTick()];
    expect(all.length).toBe(11_520);
    expect(new Set(all.map((i) => JSON.stringify(i))).size).toBe(all.length);
  });

  test("it reaches every outcome the decision can produce", () => {
    const seen = new Set<string>();
    for (const i of everyTick()) {
      const d = tickDecision(i);
      seen.add(`${d.heartbeatMayTick}|${d.compaction ?? "none"}|${d.deepArchive}`);
    }
    expect([...seen].sort()).toEqual([
      "false|idle|false",
      "false|none|false",
      "false|none|true",
      "true|idle|false",
      "true|none|false",
      "true|none|true",
    ]);
  });

  test("compaction and the deep archive never both fire", () => {
    for (const i of everyTick()) {
      const d = tickDecision(i);
      expect(d.compaction !== undefined && d.deepArchive, JSON.stringify(i)).toBe(false);
    }
  });

  test("autonomy off means nothing fires, whatever else is set", () => {
    for (const i of everyTick()) {
      if (i.autonomyEnabled) continue;
      const d = tickDecision(i);
      expect(d.heartbeatMayTick, JSON.stringify(i)).toBe(false);
      expect(d.compaction, JSON.stringify(i)).toBeUndefined();
      expect(d.deepArchive, JSON.stringify(i)).toBe(false);
    }
  });

  test("the heartbeat gate reads only its own three switches", () => {
    for (const i of everyTick()) {
      expect(tickDecision(i).heartbeatMayTick, JSON.stringify(i)).toBe(
        i.autonomyEnabled && i.heartbeatEnabled && !i.paused,
      );
    }
  });

  test("pausing stops the heartbeat and nothing else", () => {
    for (const i of everyTick()) {
      if (i.paused) continue;
      const paused = tickDecision({ ...i, paused: true });
      const running = tickDecision(i);
      expect(paused.compaction, JSON.stringify(i)).toBe(running.compaction);
      expect(paused.deepArchive, JSON.stringify(i)).toBe(running.deepArchive);
    }
  });

  test("a compaction already in flight suppresses both triggers", () => {
    for (const i of everyTick()) {
      if (i.compactionTriggered) continue;
      const d = tickDecision({ ...i, compactionTriggered: true });
      expect(d.compaction, JSON.stringify(i)).toBeUndefined();
      expect(d.deepArchive, JSON.stringify(i)).toBe(false);
    }
  });

  test("a finished deep archive suppresses only the archive", () => {
    for (const i of everyTick()) {
      if (i.deepArchiveDone) continue;
      const done = tickDecision({ ...i, deepArchiveDone: true });
      expect(done.deepArchive, JSON.stringify(i)).toBe(false);
      expect(done.compaction, JSON.stringify(i)).toBe(tickDecision(i).compaction);
    }
  });

  test("every trigger has an off switch at zero", () => {
    for (const i of everyTick()) {
      if (tickDecision({ ...i, idleTriggerSecs: 0 }).compaction === "idle") {
        throw new Error(`idleTriggerSecs=0 still fired: ${JSON.stringify(i)}`);
      }
      if (tickDecision({ ...i, archiveAfterSecs: 0 }).deepArchive) {
        throw new Error(`archiveAfterSecs=0 still fired: ${JSON.stringify(i)}`);
      }
    }
  });

  test("idle still fires for a conversation over any turn count", () => {
    let fired = 0;
    for (const i of everyTick()) {
      const idleMet = i.idleTriggerSecs > 0 && i.idleSecs >= i.idleTriggerSecs;
      if (!(idleMet && i.activeTurnCount >= i.minTurns)) continue;
      if (!(i.autonomyEnabled && i.compactionEnabled && !i.compactionTriggered)) continue;
      fired += 1;
      expect(tickDecision(i).compaction, JSON.stringify(i)).toBe("idle");
    }
    expect(fired, "no case reached the trigger").toBeGreaterThan(0);
  });

  test("both compaction triggers respect the minimum turn count", () => {
    for (const i of everyTick()) {
      if (i.activeTurnCount >= i.minTurns) continue;
      expect(tickDecision(i).compaction, JSON.stringify(i)).toBeUndefined();
    }
  });

  test("the thresholds are inclusive", () => {
    const idle = quietTick({ minTurns: 4, idleTriggerSecs: 100, activeTurnCount: 10 });
    expect(tickDecision({ ...idle, idleSecs: 99 }).compaction).toBeUndefined();
    expect(tickDecision({ ...idle, idleSecs: 100 }).compaction).toBe("idle");

    const arch = quietTick({ archiveAfterSecs: 86_400, idleTriggerSecs: 0 });
    expect(tickDecision({ ...arch, idleSecs: 86_399 }).deepArchive).toBe(false);
    expect(tickDecision({ ...arch, idleSecs: 86_400 }).deepArchive).toBe(true);
  });
});
