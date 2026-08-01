/**
 * One character's autonomy loop, assembled.
 *
 * The parts are all pinned against the Rust separately — the clock, the tick
 * decision, the log, the state file. What this covers is what only exists once
 * they are put together: the order things run in, the latch that stops a tick
 * firing work the last one is still doing, and the rechecks that keep a
 * character from archiving a conversation the user has just rejoined.
 *
 * Mirrors `tick_character` and its `execute_*_if_still_*` helpers in
 * `crates/daemon/src/autonomy/manager.rs`.
 */

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

/** Records what it was asked to do, and can be told to take time over it. */
class SpyExecutor implements AutonomyExecutor {
  readonly calls: string[] = [];
  /** Runs before each call returns, so a test can move the world mid-tick. */
  onCall: ((name: string) => void) | undefined;
  /** Names that should throw: the daemon could not be reached at all. */
  readonly unreachable = new Set<string>();
  /** Names that should come back having run and failed. */
  readonly failing = new Set<string>();
  /** What each name reports back, for the tick to fold in. */
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

/** Compaction as the only thing a tick can do, so a call list is unambiguous. */
const COMPACTION_ONLY = { heartbeatEnabled: false } as const;

function clockConfig(): HeartbeatClockConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleTicks: 100,
    maxSilentMs: 48 * HOUR,
    minWakeIntervalMs: HOUR,
  };
}

/** A runner over a movable clock and a scratch state file. */
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

/**
 * Tick until the heartbeat fires, advancing an hour at a time.
 *
 * Firing takes two ticks, not one: the clock clears its deadline when it fires,
 * so the next tick only re-arms it and the one after that can fire. Every test
 * that wants a heartbeat has to walk through that, and walking it by hand is
 * where the first draft of this file went wrong.
 */
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
      // A user just spoke: below min turns, nothing idle, nobody to leave
      // alone. The one shape where all four gates are shut.
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
  /** Just the compaction calls, so a firing heartbeat does not muddy the count. */
  const compactions = (executor: SpyExecutor) =>
    executor.calls.filter((c) => c.startsWith("compaction:"));

  test("a second tick does not re-fire compaction", async () => {
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      // What a real compaction reports: the turns it retained. Without it the
      // conversation is still 50 turns long and `max_turns` fires again the
      // moment the latch releases — correctly, since nothing was compacted.
      executor.results.set("compaction:max_turns", { events: [], turnCount: 4 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      expect((await runner.tick()).compaction).toBe("max_turns");
      expect((await runner.tick()).compaction, "already fired").toBeUndefined();
      expect(compactions(executor)).toEqual(["compaction:max_turns"]);
    });
  });

  test("a user message re-arms both triggers", async () => {
    // A character the user has come back to is not mid-idle-period any more,
    // so a trigger that already fired for it must be able to fire again.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      time.now += 60_000;
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      expect((await runner.tick()).compaction).toBe("max_turns");
      expect(compactions(executor)).toEqual(["compaction:max_turns", "compaction:max_turns"]);
    });
  });
});

describe("rechecking before the slow work", () => {
  /**
   * Drive to a tick where the heartbeat fires *and* the archive is due.
   *
   * The archive window is set past the first firing on purpose: if it were due
   * earlier, an ordinary tick would have archived before the heartbeat ever ran
   * and there would be no mid-tick to interrupt.
   */
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
    await runner.tick(); // re-arms
    return built;
  }

  test("a deep archive that is still due actually runs", async () => {
    // The recheck must not re-run the whole decision: that reads the
    // single-flight latch this tick has already taken, so it would refuse
    // every time and the archive would never run at all. The failure is silent
    // — the trigger fires, the latch is taken and released, and nothing
    // happens except that the conversation grows forever.
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
    // The decision was taken before the heartbeat ran, and a heartbeat is an
    // LLM turn with tools — minutes, not milliseconds. Archiving a conversation
    // the user has just rejoined is the failure this exists to stop.
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
    // The realistic case, and the one a user message does not cover: a
    // heartbeat that actually says something resets the activity clock without
    // releasing either latch, because the character talking to itself has not
    // ended the idle period. So the abandon path has to release the latch
    // itself — otherwise nothing compacts or archives again until the user
    // returns, which for a dormant character may be never.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = await archiveDueOnAHeartbeatTick(dir);
      executor.onCall = (name) => {
        if (name === "heartbeat") runner.onAssistantMessage(2, time.now);
      };

      time.now += 6 * HOUR;
      const outcome = await runner.tick();
      expect(outcome.abandoned).toContain("deep_archive");
      expect(executor.calls).not.toContain("deep_archive");

      // The latch is free: quiet again, and it fires.
      executor.onCall = undefined;
      time.now += 6 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);
    });
  });

  test("an abandoned deep archive releases the latch", async () => {
    // Otherwise the next tick is wedged behind a trigger that no longer
    // applies, and nothing archives again for this idle period.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = await archiveDueOnAHeartbeatTick(dir);
      executor.onCall = (name) => {
        if (name === "heartbeat") runner.onUserMessage(2, time.now);
      };
      time.now += 6 * HOUR;
      expect((await runner.tick()).abandoned).toContain("deep_archive");

      // Quiet again, and the trigger is free to fire.
      executor.onCall = undefined;
      time.now += 6 * HOUR;
      expect((await runner.tick()).deepArchive).toBe(true);
      expect(executor.calls).toContain("deep_archive");
    });
  });

});

describe("the abandonment guard", () => {
  test("a trip is written to the log", async () => {
    // The only way to tell dormancy from an ordinary "not yet": it had a
    // deadline, the tick declined, and the deadline is gone afterwards.
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
      await driveToHeartbeat(runner, time); // uses up the single allowance

      // The character schedules its own next wake, the way `set_next_wake`
      // does. That matters: the guard only *logs* when it refuses a deadline
      // that was actually armed. Refusing to arm one in the first place — what
      // happens on the bootstrap path — is silent, because there is nothing
      // there to distinguish from an ordinary "not yet".
      runner.clock.schedule(2 * HOUR, time.now);
      time.now += 2 * HOUR;
      expect((await runner.tick()).heartbeat, "the guard has tripped").toBe("none");

      expect(runner.log.recent(20).some((e) => e.kind === "dormant")).toBe(true);
      expect(runner.clock.nextWakeAt, "and the deadline is cleared").toBeUndefined();
    });
  });

  test("an ordinary not-yet tick says nothing", async () => {
    // Most ticks return "none" because the deadline has not arrived. Logging
    // those as dormancy would bury the one entry that means something under a
    // hundred that do not — the ring only holds a hundred.
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir, config: {} });
      runner.onUserMessage(1, time.now);
      time.now += 60_000;

      expect((await runner.tick()).heartbeat).toBe("none");
      expect(runner.log.recent(20).some((e) => e.kind === "dormant")).toBe(false);
    });
  });

  test("the user coming back is written to the log too", async () => {
    // The other half of the pair, and the one the log would be misleading
    // without: `dormant` says the character gave up, and only `wake` says
    // anybody came back. Mirrors the `was_idle` arm of `notify_user_message`.
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
    // Every message would otherwise log one, and a `wake` line on a
    // conversation nobody left says nothing at all.
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
      // The floor holds however far past a ceiling the conversation is: a short
      // conversation is not worth the call whatever the config says.
      expect(runner.shouldCompactNow(3, 1_000_000), "under min turns").toBe(false);
    });
  });

  test("a zero ceiling is an off switch, not an always-on one", async () => {
    // What a bare `>=` against an unset config would give, and the reason the
    // tick decision spells the same guard out.
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

  test("saying yes takes the latch, so the next tick does not compact too", async () => {
    // The whole reason this is asked here rather than decided by the daemon
    // from config it also holds: one latch, one owner. Two would have the
    // handler and the tick compacting the same conversation at once.
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
      // The idle trigger only: `max_turns` has no time in it, so it would fire
      // on the very next tick and say nothing about the retry window.
      const { runner, executor, time } = build({
        dir,
        config: { ...COMPACTION_ONLY, maxTurns: 0, maxContextTokens: 100 },
      });
      runner.onUserMessage(50, time.now);
      expect(runner.shouldCompactNow(50, 100)).toBe(true);

      runner.onCompactionFailed(time.now);

      // A full idle window, not the next tick ten seconds later: the failure
      // moved the activity clock, so the retry waits rather than spins.
      time.now += 30_000;
      await runner.tick();
      expect(executor.calls, "not straight away").toEqual([]);

      time.now += 3 * HOUR;
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
    // All three mark the state dirty. Without that the next persist writes the
    // pre-force snapshot and the debug command silently does nothing across a
    // restart — which is the case somebody reaches for it in.
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
    // A character asking for a moment in a year would otherwise disable its own
    // heartbeat; one asking for a second would hammer it.
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
    // The two are different numbers and the tracker only ever sees one of
    // them: `stats` buckets by hour of day, so a message recorded against the
    // heartbeat's clock lands in whatever hour UTC happened to be in.
    await inTempDir(async (dir) => {
      const { runner, time } = build({ dir });
      const nineAM = Date.UTC(2026, 6, 30, 9, 0, 0);

      runner.onUserMessage(1, time.now);
      runner.recordUserActivity(nineAM);

      const { stats, messageCount } = runner.activityStats(time.now, nineAM);
      expect(messageCount).toBe(1);
      // A density: the one message it has puts all the mass on its own hour.
      // Recorded against `time.now` instead, it would land on whatever hour
      // that is — 03:00 UTC, not 09:00.
      expect(stats.hourHistogram[9]).toBe(1);
      expect(stats.computedAt, "the TTL runs on the wall clock").toBe(time.now);
    });
  });

  test("backfilling seeds the silence anchor as well as the histogram", async () => {
    // Without the anchor `lastUserAt` stays unset, which reads as "nobody to
    // disturb" — and dreaming would sweep a conversation the user left an hour
    // ago. Mirrors `seed_last_user_at_if_unset` on the Rust's backfill path.
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
    // Registration order is not guaranteed against the first live message, and
    // the seed is explicitly "if unset" on the Rust side for the same reason.
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
    // The two flags look redundant until this path exists. `deepArchiveDone`
    // tracks the idle period rather than the latch, so a compaction — which is
    // not the user coming back — must not let the archive run a second time
    // over a conversation it has already archived.
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
    // The sequence that separates the two flags: archive, report the
    // compaction (which frees the latch), then let the character speak into
    // the silence. If an assistant message released `deepArchiveDone`, the
    // archive would run again over a conversation already archived — and go on
    // doing so every time the character spoke, for as long as the user stayed
    // away.
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
      expect((await runner.tick()).compaction).toBe("max_turns");
      expect(executor.calls.filter((c) => c.startsWith("compaction:")).length).toBe(2);
    });
  });
});

describe("pausing", () => {
  test("stops the heartbeat and nothing else", async () => {
    // A paused character still compacts and still archives. Pause is a switch
    // on speaking, not on housekeeping.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({ dir, config: {} });
      runner.onUserMessage(50, time.now);
      time.now += 4 * HOUR;
      runner.pause();

      const outcome = await runner.tick();
      expect(outcome.heartbeat).toBe("none");
      expect(executor.calls).toEqual(["compaction:max_turns"]);
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
    // Nothing else moved: no user, no compaction. But the clock consumed its
    // deadline and bumped its idle count, and a restart that did not know that
    // would fire again immediately and count the same tick twice.
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

      // And the restored deadline is honoured rather than reset.
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
    // Deliberate: an unreachable daemon is the loop's problem, not the tick's,
    // and swallowing it here would mean the next tick fires the same broken
    // work with nothing having reported why.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: {},
      });
      executor.unreachable.add("compaction:max_turns");
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;

      await expect(runner.tick()).rejects.toThrow("compaction:max_turns unreachable");
      expect(executor.calls, "dreaming never ran").not.toContain("dream");
    });
  });

  test("the latch releases, so one bad moment does not wedge compaction", async () => {
    // Nothing ran, so the single-flight latch has nothing to protect. Held, it
    // would stop compaction until the user came back — which for an idle
    // character is exactly the wait that made compaction due.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { idleTriggerSecs: 0 },
      });
      executor.unreachable.add("compaction:max_turns");
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await expect(runner.tick()).rejects.toThrow();

      executor.unreachable.clear();
      expect((await runner.tick()).compaction).toBe("max_turns");
    });
  });

  test("what the tick decided before the throw still reaches disk", async () => {
    // The clock advanced and a `tick_fired` line was written before the
    // heartbeat was attempted. Losing those to the throw would leave a deadline
    // that exists only in memory, and a restart would forget the wake entirely.
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
    // A heartbeat's tool uses and its message all happen on the far side. The
    // log a person reads is here, so the daemon has to say what it did.
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
    // The idle trigger is off so `max_turns` is the only thing that can fire,
    // which is what makes this about the count and nothing else.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { idleTriggerSecs: 0 },
      });
      executor.results.set("compaction:max_turns", { events: [], turnCount: 4 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      expect(runner.snapshot().coveredTurnCount).toBe(4);
      // 4 is under `maxTurns`, so nothing fires again — where a tick that
      // ignored the count would still be looking at 50 and compact forever.
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBeUndefined();
    });
  });

  test("a compaction that ran and failed keeps its turn count and waits a window", async () => {
    // Mirrors `notify_compaction_failed`: the latch releases so it can retry,
    // and the activity clock moves to now so the retry waits a full idle window
    // rather than firing again ten seconds later.
    await inTempDir(async (dir) => {
      const { runner, executor, time } = build({
        dir,
        config: { idleTriggerSecs: 0 },
      });
      executor.failing.add("compaction:max_turns");
      executor.results.set("compaction:max_turns", { events: [], turnCount: 4 });
      runner.onUserMessage(50, time.now);
      time.now += 2 * HOUR;
      await runner.tick();

      expect(runner.snapshot().coveredTurnCount, "nothing was compacted").toBe(0);
      // Still 50 turns, so `max_turns` fires again.
      time.now += 2 * HOUR;
      expect((await runner.tick()).compaction).toBe("max_turns");
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
});
