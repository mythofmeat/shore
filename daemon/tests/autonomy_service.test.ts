/**
 * Every loaded character's autonomy, and the endpoints the daemon drives it by.
 *
 * The loop itself is covered by `autonomy_runner.test.ts`. What is here is what
 * only exists once there is more than one of them and a clock: registration
 * reading state back off disk, the guard that stops a slow tick being
 * overlapped, and one character's failure not taking the others with it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HeartbeatClockConfig } from "../src/autonomy/heartbeat.ts";
import {
  AutonomyService,
  HEARTBEAT_LOG_FILENAME,
  type RegisterCharacter,
} from "../src/autonomy/service.ts";
import { encodeState, STATE_FILENAME } from "../src/autonomy/state_file.ts";
import type { AutonomyActionResult, AutonomyExecutor } from "../src/autonomy/runner.ts";
import type { CompactionReason } from "../src/autonomy/tick.ts";
import type { KeepaliveEvent, KeepaliveService } from "../src/cache/keepalive.ts";
import type { KeepaliveSnapshot } from "../src/cache/schedule.ts";

const HOUR = 3_600_000;
const START = 1_000_000_000_000;

/**
 * A calendar reading for the activity tracker, deliberately nowhere near the
 * fake wall clock these tests run on. The two are different clocks, and a
 * value that could pass for either would hide them being crossed.
 */
const LOCAL_AT = Date.UTC(2026, 6, 30, 14, 0, 0);

/** Records what it was asked to do, per character, and can be made to hang. */
class SpyExecutor implements AutonomyExecutor {
  readonly calls: string[] = [];
  /** Characters whose actions never resolve, for the in-flight guard. */
  readonly hanging = new Set<string>();
  /** Characters whose actions throw, as an unreachable daemon does. */
  readonly unreachable = new Set<string>();

  async #record(character: string, what: string): Promise<AutonomyActionResult> {
    this.calls.push(`${character}:${what}`);
    if (this.unreachable.has(character)) throw new Error(`${character} unreachable`);
    if (this.hanging.has(character)) await new Promise(() => {});
    return { events: [] };
  }

  runHeartbeatTick(character: string): Promise<AutonomyActionResult> {
    return this.#record(character, "heartbeat");
  }
  runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult> {
    return this.#record(character, `compaction:${reason}`);
  }
  runDeepArchive(character: string): Promise<AutonomyActionResult> {
    return this.#record(character, "deep_archive");
  }
  runDream(character: string): Promise<AutonomyActionResult> {
    return this.#record(character, "dream");
  }
}

function clockConfig(): HeartbeatClockConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleTicks: 100,
    maxSilentMs: 48 * HOUR,
    minWakeIntervalMs: HOUR,
  };
}

function registration(
  character: string,
  dataDir: string,
  config: Partial<RegisterCharacter["config"]> = {},
): RegisterCharacter {
  return {
    character,
    data_dir: dataDir,
    config: {
      autonomyEnabled: true,
      heartbeatEnabled: true,
      compactionEnabled: true,
      minTurns: 4,
      maxTurns: 20,
      idleTriggerSecs: 3600,
      archiveAfterSecs: 86_400,
      maxContextTokens: 0,
      ...config,
    },
    clock: clockConfig(),
  };
}

/** Compaction as the only thing a tick can do, so a count is unambiguous. */
const COMPACTION_ONLY = { heartbeatEnabled: false } as const;

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shore-autonomy-svc-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A character directory under `root`, made because the daemon would have. */
function characterDir(root: string, character: string): string {
  const dir = join(root, character);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function build(now: { value: number } = { value: START }) {
  const executor = new SpyExecutor();
  return { executor, service: new AutonomyService(executor, () => now.value), now };
}

describe("registering", () => {
  test("restores the heartbeat deadline the character left behind", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      await Bun.write(
        join(dir, STATE_FILENAME),
        encodeState({
          ticksWithoutUser: 3,
          nextWakeAt: START + HOUR,
          lastUserAt: START - HOUR,
          coveredTurnCount: 9,
          keepalive: undefined,
        }),
      );

      const { service } = build();
      await service.register(registration("nova", dir));

      const status = service.status("nova");
      expect(status?.ticks_without_user).toBe(3);
      expect(status?.next_wake_at).toBe(START + HOUR);
      expect(status?.covered_turn_count).toBe(9);
    });
  });

  test("a character with nothing on disk starts from defaults", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      expect(service.status("nova")).toEqual({
        character: "nova",
        paused: false,
        heartbeat_state: "Active",
        ticks_without_user: 0,
        covered_turn_count: 0,
        // Echoed straight back off the clock, so a status can show a reload
        // that never arrived rather than the number the daemon meant to send.
        default_interval_ms: HOUR,
        max_idle_ticks: 100,
        min_wake_interval_ms: HOUR,
        max_silent_ms: 48 * HOUR,
        recent_events: [],
      });
    });
  });

  test("reads the heartbeat log back so the CLI sees history, not just this run", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      await Bun.write(
        join(dir, HEARTBEAT_LOG_FILENAME),
        `${JSON.stringify({
          timestamp: "2026-07-30T12:00:00+00:00",
          kind: "message_sent",
          detail: "from a previous run",
        })}\n`,
      );

      const { service } = build();
      await service.register(registration("nova", dir));
      expect(service.log("nova", 10)).toEqual([
        {
          timestamp: "2026-07-30T12:00:00+00:00",
          kind: "message_sent",
          detail: "from a previous run",
        },
      ]);
    });
  });

  test("re-registering writes down where the old runner got to first", async () => {
    // What a config reload does. The in-memory state is the current one, so
    // dropping it would roll the heartbeat deadline back to whatever was on
    // disk when the character loaded.
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      const { service, now } = build();
      await service.register(registration("nova", dir));
      service.onUserMessage("nova", 12, LOCAL_AT);

      now.value += HOUR;
      await service.register(registration("nova", dir));
      expect(service.status("nova")?.covered_turn_count).toBe(0);
      // The reload did not lose the last user message: the reloaded runner read
      // it back from the file the outgoing one wrote.
      const saved = JSON.parse(await Bun.file(join(dir, STATE_FILENAME)).text());
      expect(saved.last_user_at).not.toBeNull();
    });
  });

  test("unregistering persists and stops ticking", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      const { service, executor, now } = build();
      await service.register(registration("nova", dir));
      service.onUserMessage("nova", 50, LOCAL_AT);

      await service.unregister("nova");
      now.value += 2 * HOUR;
      await service.tick();

      expect(executor.calls).toEqual([]);
      expect(service.status("nova")).toBeUndefined();
      expect(await Bun.file(join(dir, STATE_FILENAME)).exists()).toBe(true);
    });
  });
});

describe("ticking", () => {
  test("every registered character gets one", async () => {
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      await service.register(registration("iris", characterDir(root, "iris")));
      service.onUserMessage("nova", 50, LOCAL_AT);
      service.onUserMessage("iris", 50, LOCAL_AT);

      now.value += 2 * HOUR;
      await service.tick();
      expect(executor.calls.filter((c) => c.includes("compaction")).sort()).toEqual([
        "iris:compaction:max_turns",
        "nova:compaction:max_turns",
      ]);
    });
  });

  test("a character mid-tick is passed over, not started again", async () => {
    // Every action is an LLM round trip and can outlast the ten seconds to the
    // next tick. A second would compact a conversation the first is compacting.
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(
        registration("nova", characterDir(root, "nova"), COMPACTION_ONLY),
      );
      service.onUserMessage("nova", 50, LOCAL_AT);
      executor.hanging.add("nova");

      now.value += 2 * HOUR;
      const first = service.tick();
      await Promise.resolve();
      now.value += 2 * HOUR;
      await service.tick();

      expect(executor.calls).toEqual(["nova:compaction:max_turns"]);
      // The hung action never resolves; the point is that nothing else started.
      void first;
    });
  });

  test("one character's unreachable daemon does not stop the others", async () => {
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      await service.register(registration("iris", characterDir(root, "iris")));
      service.onUserMessage("nova", 50, LOCAL_AT);
      service.onUserMessage("iris", 50, LOCAL_AT);
      executor.unreachable.add("nova");

      now.value += 2 * HOUR;
      await service.tick();
      expect(executor.calls).toContain("iris:compaction:max_turns");
    });
  });

  test("a character whose tick threw is ticked again next time", async () => {
    // The guard must release on the failure path too, or one unreachable
    // moment would leave that character unticked until a restart.
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(
        registration("nova", characterDir(root, "nova"), COMPACTION_ONLY),
      );
      service.onUserMessage("nova", 50, LOCAL_AT);
      executor.unreachable.add("nova");

      now.value += 2 * HOUR;
      await service.tick();
      now.value += 2 * HOUR;
      await service.tick();
      expect(executor.calls).toEqual([
        "nova:compaction:max_turns",
        "nova:compaction:max_turns",
      ]);
    });
  });
});

describe("what the daemon reports", () => {
  test("a user message re-arms the triggers that already fired", async () => {
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      service.onUserMessage("nova", 50, LOCAL_AT);
      now.value += 2 * HOUR;
      await service.tick();

      service.onUserMessage("nova", 50, LOCAL_AT);
      now.value += 2 * HOUR;
      await service.tick();
      expect(executor.calls.filter((c) => c.startsWith("nova:compaction")).length).toBe(2);
    });
  });

  test("a compaction the daemon ran reaches the turn count a tick decides on", async () => {
    // The handler's post-turn compaction is not one a tick asked for, so this
    // side would otherwise never hear about it and keep compacting a
    // conversation that is already short.
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      service.onUserMessage("nova", 50, LOCAL_AT);
      service.onCompactionComplete("nova", 4);
      expect(service.status("nova")?.covered_turn_count).toBe(4);
    });
  });

  test("notifying a character nobody registered is ignored, not an error", async () => {
    const { service } = build();
    expect(() => service.onUserMessage("ghost", 1, LOCAL_AT)).not.toThrow();
    expect(service.setPaused("ghost", true)).toBeUndefined();
    expect(service.log("ghost", 10)).toEqual([]);
  });
});

describe("the surface the daemon drives", () => {
  // These ran over `/v1/autonomy/*` until that hop was deleted. The service is
  // the same object either way; what the HTTP layer added was JSON validation
  // and a status code, and both are gone with it — an unknown character is now
  // `undefined` from a typed call rather than a 404 body.
  //
  // One test did not survive the move, deliberately. It asserted that a missing
  // `local_ms` was a 400 rather than a `NaN` in the record, because the bodies
  // were hand-mirrored Rust structs and a field renamed on one side only would
  // arrive as `undefined`. In one process there is no body to mirror and the
  // parameter is `number`, so the case it guarded cannot be constructed.

  test("pause round-trips, and reports the state it set", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));

      expect(service.setPaused("nova", true)).toBe(true);
      expect(service.setPaused("nova", false)).toBe(false);
    });
  });

  test("the log reads back the events a tick wrote", async () => {
    await inTempDir(async (root) => {
      const { service, now } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      service.onUserMessage("nova", 1, LOCAL_AT);

      // Two hours and two ticks: the clock arms on one and fires on the next.
      now.value += 2 * HOUR;
      await service.tick();
      now.value += 2 * HOUR;
      await service.tick();

      expect(service.log("nova", 10).map((e) => e.kind)).toContain("tick_fired");
    });
  });

  test("the activity tracker fills from live messages and from history", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));

      const nineAM = Date.UTC(2026, 6, 30, 9, 0, 0);
      service.backfillActivity("nova", [nineAM, nineAM + 24 * HOUR], START - HOUR);
      service.onUserMessage("nova", 1, nineAM + 48 * HOUR);

      const report = service.activityStats("nova", nineAM);
      expect(report?.messageCount, "two backfilled and one live").toBe(3);
      // Densities, not counts: every message landed at 09:00, so that hour
      // holds all of the mass and the other twenty-three hold none.
      expect(report?.stats.hourHistogram[9]).toBe(1);
      expect(report?.stats.hourHistogram.filter((d) => d > 0).length).toBe(1);
    });
  });

  test("the compaction question is answered and the latch taken", async () => {
    await inTempDir(async (root) => {
      const { service, executor, now } = build();
      await service.register(
        registration("nova", characterDir(root, "nova"), COMPACTION_ONLY),
      );
      service.onUserMessage("nova", 50, LOCAL_AT);

      expect(service.shouldCompactNow("nova", 50, 0)).toBe(true);

      now.value += 3 * HOUR;
      await service.tick();
      expect(executor.calls, "the tick sees the latch the caller took").toEqual([]);

      // And the failure gives it back.
      service.onCompactionFailed("nova");
      now.value += 3 * HOUR;
      await service.tick();
      expect(executor.calls).toEqual(["nova:compaction:max_turns"]);
    });
  });

  test("a character nobody registered is told not to compact", () => {
    // Not an error: the caller asks on every generation, and a character that
    // has not been registered yet has nothing to compact anyway. Matches the
    // Rust, where a `with_state` miss fell through to `false`. The endpoint
    // spelled that `{compact: false}` with a 200; here it is `undefined`, and
    // `handler/deps.ts` is what coalesces it.
    const { service } = build();
    expect(service.shouldCompactNow("ghost", 500, 0)).toBeUndefined();
  });

  test("the debug commands force the heartbeat and report what they found", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));

      expect(service.forceHeartbeatNow("nova")).toBe(false);

      expect(service.forceHeartbeatState("nova", "dormant")).toBe(true);
      expect(service.forceHeartbeatNow("nova")).toBe(true);
      expect(service.status("nova")?.heartbeat_state).toBe("Dormant");

      expect(service.forceHeartbeatState("nova", "active")).toBe(true);
      expect(service.status("nova")?.heartbeat_state).toBe("Active");
    });
  });

  test("the debug commands answer nothing for a character that is not loaded", () => {
    const { service } = build();
    expect(service.forceHeartbeatNow("ghost")).toBeUndefined();
    expect(service.forceHeartbeatState("ghost", "active")).toBe(false);
  });

  test("unregistering leaves nothing to ask about", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova")));
      await service.unregister("nova");
      expect(service.status("nova")).toBeUndefined();
    });
  });
});

describe("the keepalive's two halves", () => {
  /**
   * Both were lost in `001c594d`, silently and in the allowing direction.
   *
   * That commit moved `heartbeat.jsonl` and `autonomy_state.json` to this side
   * and deleted the daemon code that drove `/v1/keepalive/{drain,restore}` — but
   * left the endpoints standing with nothing calling them. Ping outcomes went on
   * accumulating in a ring buffer that no longer had a reader, and the persisted
   * schedule was written on every save and read on every load without anything
   * ever acting on it. Pings kept firing and kept being billed, so the only
   * symptom was a heartbeat log that had quietly stopped mentioning them.
   *
   * These pin the two joins that replaced the round trip.
   */

  /** A keepalive stub with only the surface `attachKeepalive` uses. */
  function fakeKeepalive() {
    const schedules = new Map<string, KeepaliveSnapshot | undefined>();
    let sink: ((e: KeepaliveEvent) => void) | undefined;
    return {
      schedules,
      emit(e: KeepaliveEvent) {
        sink?.(e);
      },
      service: {
        onEvent(fn: (e: KeepaliveEvent) => void) {
          sink = fn;
        },
        scheduleFor: (c: string) => schedules.get(c),
        restore: (c: string, snapshot: KeepaliveSnapshot) => {
          schedules.set(c, snapshot);
          return true;
        },
      } as unknown as KeepaliveService,
    };
  }

  const snapshot = (over: Partial<KeepaliveSnapshot> = {}): KeepaliveSnapshot => ({
    model: "claude-opus-4-6",
    interval: 3_300_000,
    last_warm_at: START,
    last_active_at: START - 60_000,
    ...over,
  });

  test("a ping's outcome reaches the character's heartbeat log", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      const { service } = build();
      const ka = fakeKeepalive();
      service.attachKeepalive(ka.service);
      await service.register(registration("nova", dir));

      ka.emit({
        character: "nova",
        outcome: "cold",
        detail: "Cache refresh ping (COLD — wrote cache, disarmed)",
        at: START + 5_000,
      });
      await service.tick();
      await service.unregister("nova");

      const lines = (await Bun.file(join(dir, HEARTBEAT_LOG_FILENAME)).text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const ping = lines.find((l) => l.kind === "dormant_ping");
      expect(ping, "the ping is in the log").toBeDefined();
      expect(ping.detail).toContain("COLD");
      // Stamped when the ping fired, not when the log was written. The daemon's
      // drain could only ever say the latter.
      expect(ping.timestamp).toBe(new Date(START + 5_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"));
    });
  });

  test("an event for a character nobody registered is dropped, not thrown", async () => {
    await inTempDir(async (root) => {
      const { service } = build();
      const ka = fakeKeepalive();
      service.attachKeepalive(ka.service);
      await service.register(registration("nova", characterDir(root, "nova")));

      expect(() =>
        ka.emit({ character: "ghost", outcome: "sent", detail: "ping", at: START }),
      ).not.toThrow();
    });
  });

  test("the live schedule reaches the state file on tick", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      const { service } = build();
      const ka = fakeKeepalive();
      service.attachKeepalive(ka.service);
      await service.register(registration("nova", dir, COMPACTION_ONLY));

      ka.schedules.set("nova", snapshot());
      await service.tick();
      await service.unregister("nova");

      const saved = JSON.parse(await Bun.file(join(dir, STATE_FILENAME)).text());
      expect(saved.keepalive_model).toBe("claude-opus-4-6");
      // Milliseconds. Seconds here would read as a schedule ~1000x stale on the
      // next restore and stop re-arming for good.
      expect(saved.keepalive_interval_ms).toBe(3_300_000);
    });
  });

  test("a schedule that goes away clears the persisted copy", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      const { service } = build();
      const ka = fakeKeepalive();
      service.attachKeepalive(ka.service);
      await service.register(registration("nova", dir, COMPACTION_ONLY));

      ka.schedules.set("nova", snapshot());
      await service.tick();
      // Disarmed: keepalive off, or the prefix was invalidated. Leaving the old
      // copy behind would re-arm against a dead prefix after a restart.
      ka.schedules.set("nova", undefined);
      await service.tick();
      await service.unregister("nova");

      const saved = JSON.parse(await Bun.file(join(dir, STATE_FILENAME)).text());
      expect(saved.keepalive_model ?? null).toBeNull();
      expect(saved.keepalive_interval_ms ?? null).toBeNull();
    });
  });

  test("registering offers the persisted schedule back", async () => {
    await inTempDir(async (root) => {
      const dir = characterDir(root, "nova");
      await Bun.write(
        join(dir, STATE_FILENAME),
        encodeState({
          ticksWithoutUser: 0,
          nextWakeAt: START + HOUR,
          lastUserAt: START,
          coveredTurnCount: 0,
          keepalive: {
            model: "claude-opus-4-6",
            intervalMs: 3_300_000,
            lastWarmAt: START,
            lastActiveAt: START - 60_000,
          },
        }),
      );

      const { service } = build();
      const ka = fakeKeepalive();
      service.attachKeepalive(ka.service);
      await service.register(registration("nova", dir));

      // Handed over in the wire spelling, which is what the keepalive speaks.
      expect(ka.schedules.get("nova")).toEqual(snapshot());
    });
  });

  test("no keepalive attached is not a crash", async () => {
    // Unit tests build a bare AutonomyService; it must tick without one.
    await inTempDir(async (root) => {
      const { service } = build();
      await service.register(registration("nova", characterDir(root, "nova"), COMPACTION_ONLY));
      await expect(service.tick()).resolves.toBeUndefined();
    });
  });
});
