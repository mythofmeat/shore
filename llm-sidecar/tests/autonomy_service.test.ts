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
import { createSidecarHandler } from "../src/server.ts";

const HOUR = 3_600_000;
const START = 1_000_000_000_000;

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
      dreamingEnabled: false,
      minimumInactiveMs: HOUR,
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
        ticks_without_user: 0,
        covered_turn_count: 0,
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
      service.onUserMessage("nova", 12);

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
      service.onUserMessage("nova", 50);

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
      service.onUserMessage("nova", 50);
      service.onUserMessage("iris", 50);

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
      service.onUserMessage("nova", 50);
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
      service.onUserMessage("nova", 50);
      service.onUserMessage("iris", 50);
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
      service.onUserMessage("nova", 50);
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
      service.onUserMessage("nova", 50);
      now.value += 2 * HOUR;
      await service.tick();

      service.onUserMessage("nova", 50);
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
      service.onUserMessage("nova", 50);
      service.onCompactionComplete("nova", 4);
      expect(service.status("nova")?.covered_turn_count).toBe(4);
    });
  });

  test("notifying a character nobody registered is ignored, not an error", async () => {
    const { service } = build();
    expect(() => service.onUserMessage("ghost", 1)).not.toThrow();
    expect(service.setPaused("ghost", true)).toBeUndefined();
    expect(service.log("ghost", 10)).toEqual([]);
  });
});

describe("the endpoints", () => {
  /** A handler over its own service, so nothing here starts a clock. */
  function handler() {
    const { service, executor, now } = build();
    return { post: postTo(createSidecarHandler({ autonomy: service })), service, executor, now };
  }

  const postTo =
    (fetch: ReturnType<typeof createSidecarHandler>) =>
    (path: string, body: unknown): Promise<Response> =>
      fetch(
        new Request(`http://sidecar${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

  test("register, notify, read back", async () => {
    await inTempDir(async (root) => {
      const { post } = handler();
      const dir = characterDir(root, "nova");

      expect(await (await post("/v1/autonomy/register", registration("nova", dir))).json()).toEqual({
        ok: true,
      });
      await post("/v1/autonomy/user-message", { character: "nova", turn_count: 12 });
      await post("/v1/autonomy/compaction-complete", { character: "nova", turn_count: 4 });

      const status = await (await post("/v1/autonomy/status", { character: "nova" })).json();
      expect(status).toMatchObject({ character: "nova", paused: false, covered_turn_count: 4 });
    });
  });

  test("pausing answers with the state it landed in", async () => {
    await inTempDir(async (root) => {
      const { post } = handler();
      await post("/v1/autonomy/register", registration("nova", characterDir(root, "nova")));

      expect(
        await (await post("/v1/autonomy/pause", { character: "nova", paused: true })).json(),
      ).toEqual({ paused: true });
      expect(
        await (await post("/v1/autonomy/pause", { character: "nova", paused: false })).json(),
      ).toEqual({ paused: false });
    });
  });

  test("asking about a character that is not loaded is a 404, not a 500", async () => {
    // The CLI can ask about a character that has not spoken since the daemon
    // started, which is an ordinary answer rather than a failure.
    const { post } = handler();
    expect((await post("/v1/autonomy/status", { character: "ghost" })).status).toBe(404);
    expect((await post("/v1/autonomy/pause", { character: "ghost", paused: true })).status).toBe(
      404,
    );
  });

  test("the log reads back the events a tick wrote", async () => {
    await inTempDir(async (root) => {
      const { post, service, now } = handler();
      await post("/v1/autonomy/register", registration("nova", characterDir(root, "nova")));
      await post("/v1/autonomy/user-message", { character: "nova", turn_count: 1 });

      // Two hours and two ticks: the clock arms on one and fires on the next.
      now.value += 2 * HOUR;
      await service.tick();
      now.value += 2 * HOUR;
      await service.tick();

      const body = (await (
        await post("/v1/autonomy/log", { character: "nova", limit: 10 })
      ).json()) as { events: { kind: string }[] };
      expect(body.events.map((e) => e.kind)).toContain("tick_fired");
    });
  });

  test("unregistering leaves nothing to ask about", async () => {
    await inTempDir(async (root) => {
      const { post } = handler();
      await post("/v1/autonomy/register", registration("nova", characterDir(root, "nova")));
      await post("/v1/autonomy/unregister", { character: "nova" });
      expect((await post("/v1/autonomy/status", { character: "nova" })).status).toBe(404);
    });
  });
});
