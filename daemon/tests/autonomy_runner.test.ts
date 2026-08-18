import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeartbeatClock, type HeartbeatClockConfig } from "../src/autonomy/heartbeat.ts";
import { HeartbeatLog } from "../src/autonomy/heartbeat_log.ts";
import { loadState, STATE_FILENAME, type AutonomyStateFile } from "../src/autonomy/state_file.ts";
import {
  CharacterAutonomy,
  type AutonomyActionResult,
  type AutonomyExecutor,
  type AutonomyRunnerConfig,
} from "../src/autonomy/runner.ts";
import type { CompactionReason } from "../src/autonomy/tick.ts";

const HOUR = 3_600_000;

class SpyExecutor implements AutonomyExecutor {
  readonly calls: string[] = [];
  onCall: ((name: string) => void) | undefined;
  readonly unreachable = new Set<string>();
  readonly failing = new Set<string>();
  readonly results = new Map<string, AutonomyActionResult>();

  #record(name: string): AutonomyActionResult {
    this.calls.push(name);
    this.onCall?.(name);
    if (this.unreachable.has(name)) throw new Error(`${name} unreachable`);
    const result = this.results.get(name) ?? { events: [] };
    return this.failing.has(name) ? { ...result, failed: `${name} failed` } : result;
  }

  async runHeartbeatTick(): Promise<AutonomyActionResult> {
    return this.#record("heartbeat");
  }
  async runCompaction(
    _character: string,
    reason: CompactionReason,
  ): Promise<AutonomyActionResult> {
    return this.#record(`compaction:${reason}`);
  }
  async runDeepArchive(): Promise<AutonomyActionResult> {
    return this.#record("deep_archive");
  }
  async runDream(): Promise<AutonomyActionResult> {
    return this.#record("dream");
  }
}

function config(overrides: Partial<AutonomyRunnerConfig> = {}): AutonomyRunnerConfig {
  return {
    autonomyEnabled: true,
    heartbeatEnabled: true,

    compactionEnabled: true,
    minTurns: 4,
    maxTurns: 20,
    idleTriggerSecs: 3600,
    archiveAfterSecs: 86_400,
    maxContextTokens: 0,
    ...overrides,
  };
}

const COMPACTION_ONLY = { heartbeatEnabled: false } as const;

function clockConfig(): HeartbeatClockConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleTicks: 100,
    maxSilentMs: 48 * HOUR,
    minWakeIntervalMs: HOUR,
  };
}

function build(opts: {
  dir: string;
  config?: Partial<AutonomyRunnerConfig>;
  restored?: AutonomyStateFile;
  start?: number;
}) {
  const time = { now: opts.start ?? 1_000_000_000_000 };
  const now = () => time.now;
  const executor = new SpyExecutor();
  const runner = new CharacterAutonomy({
    character: "alice",
    config: config(opts.config),
    executor,
    statePath: join(opts.dir, STATE_FILENAME),
    clock: new HeartbeatClock(clockConfig(), time.now),
    log: new HeartbeatLog(join(opts.dir, "heartbeat.jsonl")),
    restored: opts.restored,
    now,
  });
  return { runner, executor, time };
}

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shore-runner-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function driveToHeartbeat(
  runner: CharacterAutonomy,
  time: { now: number },
): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    time.now += HOUR + 1000;
    if ((await runner.tick()).heartbeat === "run_tick") return;
  }
  throw new Error("the heartbeat never fired");
}

describe("a quiet tick", () => {
  test("does nothing and asks for nothing", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir });
      runner.onUserMessage(3, time.now);

      const outcome = await runner.tick();

      expect(outcome.heartbeat).toBe("none");
      expect(outcome.compaction).toBeUndefined();
      expect(outcome.deepArchive).toBe(false);
      expect(executor.calls).toEqual([]);
    });
  });

});

describe("ordering", () => {
  test("a fired heartbeat runs before anything else and is logged", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 1, minTurns: 1 },
      });
      runner.onUserMessage(5, time.now);
      await driveToHeartbeat(runner, time);

      expect(executor.calls[0]).toBe("heartbeat");
      expect(runner.log.recent(10).some((e) => e.kind === "tick_fired")).toBe(true);
    });
  });
});

describe("the single-flight latch", () => {
  const compactions = (executor: SpyExecutor) =>
    executor.calls.filter((c) => c.startsWith("compaction:"));

  test("a second tick does not re-fire compaction", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      executor.results.set("compaction:idle", { events: [], turnCount: 4 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      expect((await runner.tick()).compaction).toBe("idle");
      expect((await runner.tick()).compaction, "already fired").toBeUndefined();
      expect(compactions(executor)).toEqual(["compaction:idle"]);
    });
  });

  test("a user message re-arms both triggers", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      time.now += 60_000;
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      expect((await runner.tick()).compaction).toBe("idle");
      expect(compactions(executor)).toEqual(["compaction:idle", "compaction:idle"]);
    });
  });
});

describe("rechecking before the slow work", () => {
  async function archiveDueOnAHeartbeatTick(dir: string) {
    const built = build({
      dir,
      config: {
        maxTurns: 0,
        idleTriggerSecs: 0,
        archiveAfterSecs: 5 * 3600,
      },
    });
    const { runner, time } = built;
    runner.onUserMessage(1, time.now);

    time.now += HOUR + 1000;
    expect((await runner.tick()).heartbeat, "first firing, archive not due").toBe("run_tick");
    time.now += HOUR;
    await runner.tick();
    return built;
  }

  test("a deep archive that is still due actually runs", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      runner.onUserMessage(1, time.now);
      time.now += 10 * HOUR;

      const outcome = await runner.tick();
      expect(outcome.deepArchive).toBe(true);
      expect(outcome.abandoned).toEqual([]);
      expect(executor.calls).toContain("deep_archive");
    });
  });

  test("the deep archive does not fire twice for one idle period", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      runner.onUserMessage(1, time.now);
      time.now += 10 * HOUR;
      await runner.tick();

      time.now += 10 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(false);
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(1);
    });
  });

  test("the deep archive is abandoned if the user returns mid-tick", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = await archiveDueOnAHeartbeatTick(dir);
      executor.onCall = (name) => {
        if (name === "heartbeat") runner.onUserMessage(2, time.now);
      };

      time.now += 6 * HOUR;
      const outcome = await runner.tick();

      expect(outcome.heartbeat).toBe("run_tick");
      expect(outcome.deepArchive).toBe(false);
      expect(outcome.abandoned).toContain("deep_archive");
      expect(executor.calls).not.toContain("deep_archive");
    });
  });

  test("the character's own heartbeat message calls off the archive, and frees the latch", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = await archiveDueOnAHeartbeatTick(dir);
      executor.onCall = (name) => {
        if (name === "heartbeat") runner.onAssistantMessage(2, time.now);
      };

      time.now += 6 * HOUR;
      const outcome = await runner.tick();
      expect(outcome.abandoned).toContain("deep_archive");
      expect(executor.calls).not.toContain("deep_archive");

      executor.onCall = undefined;
      time.now += 6 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);
    });
  });

  test("an abandoned deep archive releases the latch", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = await archiveDueOnAHeartbeatTick(dir);
      executor.onCall = (name) => {
        if (name === "heartbeat") runner.onUserMessage(2, time.now);
      };
      time.now += 6 * HOUR;
      expect((await runner.tick()).abandoned).toContain("deep_archive");

      executor.onCall = undefined;
      time.now += 6 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);
      expect(executor.calls).toContain("deep_archive");
    });
  });

});

describe("the abandonment guard", () => {
  test("a trip is written to the log", async () => {
    await inTempDir(async (dir) => {
      const time = { now: 1_000_000_000_000 };
      const runner = new CharacterAutonomy({
        character: "alice",
        config: config({ maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 0 }),
        executor: new SpyExecutor(),
        statePath: join(dir, STATE_FILENAME),
        clock: new HeartbeatClock({ ...clockConfig(), maxIdleTicks: 1 }, time.now),
        log: new HeartbeatLog(join(dir, "heartbeat.jsonl")),
        now: () => time.now,
      });

      runner.onUserMessage(1, time.now);
      await driveToHeartbeat(runner, time);

      runner.clock.schedule(2 * HOUR, time.now);
      time.now += 2 * HOUR;
      expect((await runner.tick()).heartbeat, "the guard has tripped").toBe("none");

      expect(runner.log.recent(20).some((e) => e.kind === "dormant")).toBe(true);
      expect(runner.clock.nextWakeAt, "and the deadline is cleared").toBeUndefined();
    });
  });

  test("an ordinary not-yet tick says nothing", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir, config: {} });
      runner.onUserMessage(1, time.now);
      time.now += 60_000;

      expect((await runner.tick()).heartbeat).toBe("none");
      expect(runner.log.recent(20).some((e) => e.kind === "dormant")).toBe(false);
    });
  });

  test("the user coming back is written to the log too", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onUserMessage(1, time.now);
      await driveToHeartbeat(runner, time);
      expect(runner.clock.ticksWithoutUser, "the character talked into silence").toBeGreaterThan(0);

      runner.onUserMessage(2, time.now);

      const wakes = runner.log.recent(20).filter((e) => e.kind === "wake");
      expect(wakes.length).toBe(1);
      expect(wakes[0]?.detail).toBe("User returned — idle counter reset");
    });
  });

  test("an ordinary user message is not a return", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onUserMessage(1, time.now);
      runner.onUserMessage(2, time.now);

      expect(runner.log.recent(20).some((e) => e.kind === "wake")).toBe(false);
    });
  });
});

describe("the compaction the handler runs", () => {
  test("fires on turns, on tokens, and on neither below min turns", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({ dir, config: { maxTurns: 20, maxContextTokens: 100_000 } });

      expect(runner.shouldCompactNow(20, 0), "over max turns").toBe(true);
      expect(runner.shouldCompactNow(5, 100_000), "over the token ceiling").toBe(true);
      expect(runner.shouldCompactNow(19, 99_999), "under both").toBe(false);
      expect(runner.shouldCompactNow(3, 1_000_000), "under min turns").toBe(false);
    });
  });

  test("a zero ceiling is an off switch, not an always-on one", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({ dir, config: { maxTurns: 0, maxContextTokens: 0 } });
      expect(runner.shouldCompactNow(10_000, 10_000_000)).toBe(false);
    });
  });

  test("compaction switched off answers no whatever the numbers are", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({ dir, config: { compactionEnabled: false } });
      expect(runner.shouldCompactNow(500, 0)).toBe(false);
    });
  });

  test("a reload changes when it fires, without restarting the runner", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({
        dir,
        config: { autonomyEnabled: true, maxTurns: 20, maxContextTokens: 0 },
      });
      expect(runner.shouldCompactNow(10, 0)).toBe(false);

      runner.setCompactionConfig({
        compactionEnabled: true,
        minTurns: 2,
        maxTurns: 10,
        idleTriggerSecs: 5,
        archiveAfterSecs: 6,
        maxContextTokens: 0,
      });

      expect(runner.shouldCompactNow(10, 0)).toBe(true);
      expect(runner.inputs(0).idleTriggerSecs).toBe(5);
      expect(runner.inputs(0).autonomyEnabled).toBe(true);
    });
  });

  test("saying yes takes the latch, so the next tick does not compact too", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: COMPACTION_ONLY });
      runner.onUserMessage(50, time.now);

      expect(runner.shouldCompactNow(50, 0)).toBe(true);
      time.now += 3 * HOUR;
      await runner.tick();

      expect(executor.calls).toEqual([]);
    });
  });

  test("a failure the handler reports lets a later trigger retry", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { ...COMPACTION_ONLY, maxTurns: 0, maxContextTokens: 100 },
      });
      runner.onUserMessage(50, time.now);
      expect(runner.shouldCompactNow(50, 100)).toBe(true);

      runner.onCompactionFailed(time.now);

      time.now += 30_000;
      await runner.tick();
      expect(executor.calls, "not straight away").toEqual([]);

      time.now += 3 * HOUR;
      await runner.tick();
      expect(executor.calls).toEqual(["compaction:idle"]);
    });
  });

  test("a budget-paused compaction becomes due at its provider reset", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { ...COMPACTION_ONLY, maxTurns: 0, maxContextTokens: 100 },
      });
      runner.onUserMessage(50, time.now);
      expect(runner.shouldCompactNow(50, 100)).toBe(true);

      const resetAt = time.now + 2 * HOUR;
      runner.onCompactionFailed(time.now, resetAt);
      time.now = resetAt - 1;
      await runner.tick();
      expect(executor.calls).toEqual([]);

      time.now = resetAt;
      await runner.tick();
      expect(executor.calls).toEqual(["compaction:idle"]);
    });
  });
});

describe("forcing the heartbeat's hand", () => {
  test("a forced wake fires on the next tick and says whether it was dormant", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(1, time.now);

      expect(runner.forceHeartbeatNow(time.now), "not dormant").toBe(false);
      expect((await runner.tick()).heartbeat).toBe("run_tick");
      expect(executor.calls).toEqual(["heartbeat"]);
    });
  });

  test("forcing dormant stops the ticks; forcing active starts them again", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(1, time.now);

      runner.forceDormant();
      expect(runner.forceHeartbeatNow(time.now), "and it says so").toBe(true);
      time.now += 2 * HOUR;
      await runner.tick();
      expect(executor.calls, "a dormant clock suppresses the forced wake").toEqual([]);

      runner.forceActive(time.now);
      expect((await runner.tick()).heartbeat).toBe("run_tick");
      expect(executor.calls).toEqual(["heartbeat"]);
    });
  });

  test("a forced state survives a restart", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onUserMessage(1, time.now);
      runner.forceDormant();
      await runner.persist();

      const saved = await loadState(join(dir, STATE_FILENAME));
      expect(saved?.ticksWithoutUser).toBe(100);
      expect(saved?.nextWakeAt).toBeUndefined();
    });
  });
});

describe("the character scheduling its own next moment", () => {
  test("arms the clock, logs it, and answers with the hours it used", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      expect(runner.scheduleNextWake(3, "curious about the garden", time.now)).toBe(3);
      expect(runner.clock.nextWakeAt).toBe(time.now + 3 * HOUR);

      const line = runner.log.recent(5).find((e) => e.kind === "tool_use");
      expect(line?.detail).toBe("set_next_wake: 3.0h - curious about the garden");
    });
  });

  test("a wake outside the bounds is clamped, not refused", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      expect(runner.scheduleNextWake(500, "", time.now), "past the ceiling").toBe(48);
      expect(runner.scheduleNextWake(0.01, "", time.now), "under the floor").toBe(1);
      expect(runner.clock.nextWakeAt).toBe(time.now + HOUR);
    });
  });

  test("the new deadline survives a restart", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.scheduleNextWake(5, "later", time.now);
      await runner.persist();

      expect((await loadState(join(dir, STATE_FILENAME)))?.nextWakeAt).toBe(time.now + 5 * HOUR);
    });
  });
});

describe("the activity tracker", () => {
  test("records user messages on the calendar clock, not the wall clock", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      const nineAM = Date.UTC(2026, 6, 30, 9, 0, 0);

      runner.onUserMessage(1, time.now);
      runner.recordUserActivity(nineAM);

      const { stats, messageCount } = runner.activityStats(time.now, nineAM);
      expect(messageCount).toBe(1);
      expect(stats.hourHistogram[9]).toBe(1);
      expect(stats.computedAt, "the TTL runs on the wall clock").toBe(time.now);
    });
  });

  test("backfilling seeds the silence anchor as well as the histogram", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      const anHourAgo = time.now - HOUR;
      const calendar = Date.UTC(2026, 6, 30, 9, 0, 0);

      runner.backfillActivity([calendar, calendar + HOUR], anHourAgo);

      expect(runner.activityStats(time.now, calendar).messageCount).toBe(2);
      expect(runner.clock.lastUserAt).toBe(anHourAgo);
    });
  });

  test("backfilling does not overwrite a user message already seen", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onUserMessage(1, time.now);

      runner.backfillActivity([Date.UTC(2026, 6, 30, 9, 0, 0)], time.now - 48 * HOUR);

      expect(runner.clock.lastUserAt).toBe(time.now);
    });
  });
});

describe("a completed compaction", () => {
  test("frees the compaction latch but not the deep archive's", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      runner.onUserMessage(1, time.now);
      time.now += 10 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);

      runner.onCompactionComplete(2, time.now);
      time.now += 10 * HOUR;

      expect((await runner.tick()).deepArchive, "already archived this idle period").toBe(false);
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(1);
    });
  });

  test("the character speaking afterwards does not re-open the archive", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      runner.onUserMessage(1, time.now);
      time.now += 10 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);

      runner.onCompactionComplete(2, time.now);
      runner.onAssistantMessage(3, time.now);
      time.now += 10 * HOUR;

      expect((await runner.tick()).deepArchive).toBe(false);
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(1);
    });
  });

  test("records the turns memory now covers", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onCompactionComplete(9, time.now);
      expect(runner.snapshot().coveredTurnCount).toBe(9);
    });
  });

  test("lets a later compaction fire", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      runner.onCompactionComplete(50, time.now);
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBe("idle");
      expect(executor.calls.filter((c) => c.startsWith("compaction:")).length).toBe(2);
    });
  });
});

describe("pausing", () => {
  test("stops the heartbeat and nothing else", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(50, time.now);
      time.now += 4 * HOUR;
      runner.pause();

      const outcome = await runner.tick();
      expect(outcome.heartbeat).toBe("none");
      expect(executor.calls).toEqual(["compaction:idle"]);
    });
  });

  test("resuming lets it run again", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0 },
      });
      runner.onUserMessage(1, time.now);
      runner.pause();
      time.now += 4 * HOUR;
      expect((await runner.tick()).heartbeat, "paused").toBe("none");

      runner.resume();
      await driveToHeartbeat(runner, time);
    });
  });
});

describe("persistence", () => {
  test("a tick that changed something writes it", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.onUserMessage(3, time.now);
      await runner.tick();

      const saved = await loadState(join(dir, STATE_FILENAME));
      expect(saved).toBeDefined();
      expect(saved?.lastUserAt).toBe(time.now);
      expect(saved?.nextWakeAt).toBe(time.now + HOUR);
    });
  });

  test("a firing heartbeat is a change worth writing on its own", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 0 },
      });
      runner.onUserMessage(1, time.now);
      await runner.persist();
      const before = await loadState(join(dir, STATE_FILENAME));

      await driveToHeartbeat(runner, time);
      executor.calls.length = 0;

      const after = await loadState(join(dir, STATE_FILENAME));
      expect(after?.ticksWithoutUser, "the firing was recorded").toBe(1);
      expect(before?.ticksWithoutUser).toBe(0);
    });
  });

  test("a quiet tick writes nothing", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({ dir });
      await runner.tick();
      expect(await Bun.file(join(dir, STATE_FILENAME)).exists()).toBe(false);
    });
  });

  test("shutdown persists even when nothing changed", async () => {
    await inTempDir(async (dir) => {
      const { runner } = build({ dir });
      await runner.shutdown();
      expect(await loadState(join(dir, STATE_FILENAME))).toBeDefined();
    });
  });

  test("a restored state puts the clock back where it was", async () => {
    await inTempDir(async (dir) => {
      const start = 1_000_000_000_000;
      const restored: AutonomyStateFile = {
        ticksWithoutUser: 2,
        nextWakeAt: start + 5 * HOUR,
        lastUserAt: start - HOUR,
        coveredTurnCount: 7,
        keepalive: undefined,
      };
      const { runner, time } = build({ dir, restored, start });

      expect(runner.clock.ticksWithoutUser).toBe(2);
      expect(runner.clock.nextWakeAt).toBe(start + 5 * HOUR);
      expect(runner.snapshot().coveredTurnCount, "not the clock's, but carried").toBe(7);

      time.now = start + 4 * HOUR;
      expect((await runner.tick()).heartbeat).toBe("none");
      time.now = start + 5 * HOUR;
      expect((await runner.tick()).heartbeat).toBe("run_tick");
    });
  });

  test("the log lands beside the state", async () => {
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      runner.note("wake", "the user returned", time.now);
      await runner.persist();

      const lines = (await Bun.file(join(dir, "heartbeat.jsonl")).text()).trimEnd().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("wake");
      expect(lines[0]).toContain("the user returned");
    });
  });
});

describe("when the daemon cannot be reached", () => {
  test("the throw reaches the caller and the tick stops there", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: {},
      });
      executor.unreachable.add("compaction:idle");
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      await expect(runner.tick()).rejects.toThrow("compaction:idle unreachable");
      expect(executor.calls, "dreaming never ran").not.toContain("dream");
    });
  });

  test("the latch releases, so one bad moment does not wedge compaction", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: {},
      });
      executor.unreachable.add("compaction:idle");
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await expect(runner.tick()).rejects.toThrow();

      executor.unreachable.clear();
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBe("idle");
    });
  });

  test("what the tick decided before the throw still reaches disk", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0 },
      });
      executor.unreachable.add("heartbeat");
      runner.onUserMessage(1, time.now);
      time.now += 4 * HOUR;

      await expect(runner.tick()).rejects.toThrow("heartbeat unreachable");

      const saved = await loadState(join(dir, STATE_FILENAME));
      expect(saved, "the state was written despite the throw").toBeDefined();
      expect(saved?.ticksWithoutUser).toBe(1);
      const log = (await Bun.file(join(dir, "heartbeat.jsonl")).text()).trimEnd();
      expect(log).toContain("tick_fired");
    });
  });
});

describe("what an action reports back", () => {
  test("its log lines are written as the tick's own", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0 },
      });
      executor.results.set("heartbeat", {
        events: [
          { kind: "tool_use", detail: "read a file" },
          { kind: "message_sent", detail: "Autonomous message sent: hello" },
        ],
      });
      runner.onUserMessage(1, time.now);
      time.now += 4 * HOUR;
      await runner.tick();

      const lines = (await Bun.file(join(dir, "heartbeat.jsonl")).text()).trimEnd().split("\n");
      expect(lines.map((l) => JSON.parse(l).kind)).toEqual([
        "tick_fired",
        "tool_use",
        "message_sent",
      ]);
    });
  });

  test("a compaction's turn count becomes the count the next tick decides on", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: {},
      });
      executor.results.set("compaction:idle", { events: [], turnCount: 3 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      expect(runner.snapshot().coveredTurnCount).toBe(3);
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBeUndefined();
    });
  });

  test("a compaction that ran and failed keeps its turn count and waits a window", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: {},
      });
      executor.failing.add("compaction:idle");
      executor.results.set("compaction:idle", { events: [], turnCount: 4 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      expect(runner.snapshot().coveredTurnCount, "nothing was compacted").toBe(0);
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBe("idle");
      expect(executor.calls.filter((c) => c.startsWith("compaction:")).length).toBe(2);
    });
  });

  test("a deep archive that ran and failed is allowed to run again", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      executor.failing.add("deep_archive");
      runner.onUserMessage(10, time.now);
      time.now += 4 * HOUR;
      await runner.tick();
      expect(executor.calls).toContain("deep_archive");

      time.now += 4 * HOUR;
      await runner.tick();
      expect(
        executor.calls.filter((c) => c === "deep_archive").length,
        "a failed archive is not a done archive",
      ).toBe(2);
    });
  });

  test("an archive that says the period is unfinished runs again in it", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      executor.results.set("deep_archive", {
        events: [],
        turnCount: 0,
        deepArchiveDone: false,
      });
      runner.onUserMessage(10, time.now);
      time.now += 4 * HOUR;
      await runner.tick();

      time.now += 4 * HOUR;
      await runner.tick();
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(2);
    });
  });

  test("an archive that says the period is finished does not run again in it", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      executor.results.set("deep_archive", {
        events: [],
        turnCount: 0,
        deepArchiveDone: true,
      });
      runner.onUserMessage(10, time.now);
      time.now += 4 * HOUR;
      await runner.tick();

      time.now += 4 * HOUR;
      await runner.tick();
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(1);
    });
  });

  test("an archive that says nothing keeps the old inference", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 5 },
      });
      runner.onUserMessage(10, time.now);
      time.now += 4 * HOUR;
      await runner.tick();

      time.now += 4 * HOUR;
      await runner.tick();
      expect(executor.calls.filter((c) => c === "deep_archive").length).toBe(1);
    });
  });
});
