/**
 * Where a chat turn meets the autonomy loop.
 *
 * The turn is synchronous and registration is not — it reads
 * `autonomy_state.json` off disk — so the first turn for a character arrives
 * before the loop knows that character exists. Everything worth pinning here
 * follows from that:
 *
 * - **`ensureState` returns true exactly once.** It is the only signal the
 *   caller gets to walk the conversation and seed the activity tracker. Twice
 *   double-seeds a heatmap; never leaves it blank for a fortnight.
 * - **Writes queue behind the registration, in order.** An `onUserMessage`
 *   landing after the `onCompactionComplete` that followed it would restart an
 *   idle clock the compaction had just reset.
 * - **`shouldCompactNow` cannot queue.** It answers now and takes a
 *   single-flight latch when it says yes, so before registration it says no —
 *   a compaction one turn late, rather than a latch on a runner that does not
 *   exist and nothing to release it.
 */

import { describe, expect, test } from "bun:test";

import {
  clockConfigFor,
  registrationFor,
  runnerConfigFor,
  TurnAutonomyBridge,
} from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

function configWith(mutate: (app: ReturnType<typeof defaultAppConfig>) => void = () => {}): LoadedConfig {
  const app = defaultAppConfig();
  mutate(app);
  return {
    app,
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: { config: "/c", data: "/d", cache: "/ca", runtime: "/r" },
    rawTable: undefined,
  };
}

/** Records what reached the service, and when it was allowed to. */
function recordingService(registerDelay?: Promise<void>) {
  const calls: string[] = [];
  return {
    calls,
    register: async () => {
      calls.push("register");
      if (registerDelay !== undefined) await registerDelay;
    },
    backfillActivity: (_c: string, stamps: readonly number[], latest: number | undefined) => {
      calls.push(`backfill:${stamps.length}:${String(latest)}`);
    },
    onUserMessage: (_c: string, turns: number, at: number) => {
      calls.push(`user:${turns}:${at}`);
    },
    shouldCompactNow: () => undefined,
    onCompactionComplete: (_c: string, retained: number) => {
      calls.push(`compacted:${retained}`);
    },
    onCompactionFailed: () => {
      calls.push("failed");
    },
  };
}

describe("reading the config a loop runs on", () => {
  test("the loop's gates come from the two sections that own them", () => {
    const config = configWith((app) => {
      app.behavior.autonomy.enabled = true;
      app.behavior.autonomy.heartbeat.enabled = false;
      app.memory.compaction.enabled = true;
      app.memory.compaction.min_turns = 5;
      app.memory.compaction.max_turns = 25;
      app.memory.compaction.max_context_tokens = 123_456;
      app.memory.compaction.idle_trigger = ConfigDuration.fromSecs(900);
      app.memory.compaction.archive_after = ConfigDuration.fromSecs(86_400);
    });

    // Autonomy as a whole and the heartbeat are separate switches: a character
    // can compact on idle without ever speaking unprompted.
    expect(runnerConfigFor(config)).toEqual({
      autonomyEnabled: true,
      heartbeatEnabled: false,
      compactionEnabled: true,
      minTurns: 5,
      maxTurns: 25,
      idleTriggerSecs: 900,
      archiveAfterSecs: 86_400,
      maxContextTokens: 123_456,
    });
  });

  test("the clock's four bounds each come from their own knob", () => {
    const config = configWith((app) => {
      const h = app.behavior.autonomy.heartbeat;
      h.fallback_heartbeat_interval = ConfigDuration.fromSecs(1800);
      h.dormant_after_heartbeat_turns = 4;
      h.dormant_after_idle_time = ConfigDuration.fromSecs(172_800);
      h.minimum_heartbeat_latency = ConfigDuration.fromSecs(600);
    });

    // Four questions, four answers, and swapping any two is silent: a wake
    // interval used as a dormancy bound just makes a character go quiet.
    expect(clockConfigFor(config)).toEqual({
      defaultIntervalMs: 1_800_000,
      maxIdleTicks: 4,
      maxSilentMs: 172_800_000,
      minWakeIntervalMs: 600_000,
    });
  });

  test("state lives under the character's own directory", () => {
    // `autonomy_state.json` and `heartbeat.jsonl` are per character. Pointing
    // at the data root would have every character share one file.
    expect(registrationFor("ada", configWith()).data_dir).toBe("/d/ada");
  });
});

describe("taking up a character", () => {
  test("says yes once and no afterwards", () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);
    const config = configWith();

    expect(bridge.ensureState("ada", config)).toBe(true);
    expect(bridge.ensureState("ada", config)).toBe(false);
    expect(bridge.ensureState("ada", config)).toBe(false);
    // The return is the caller's only cue to seed the activity tracker, so a
    // second yes re-seeds a heatmap that already has counts in it.
    expect(service.calls.filter((c) => c === "register")).toEqual(["register"]);
  });

  test("a second turn during a slow registration does not start another", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    const bridge = new TurnAutonomyBridge(service);
    const config = configWith();

    bridge.ensureState("ada", config);
    // Still reading state off disk. A second registration here would replace
    // the first, shutting down a runner mid-tick.
    expect(bridge.ensureState("ada", config)).toBe(false);

    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register"]);
  });

  test("different characters register separately", () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);

    expect(bridge.ensureState("ada", configWith())).toBe(true);
    expect(bridge.ensureState("nova", configWith())).toBe(true);
    expect(service.calls.length).toBe(2);
  });

  test("a failed registration is a warning, not a failed turn", async () => {
    const bridge = new TurnAutonomyBridge({
      ...recordingService(),
      register: () => Promise.reject(new Error("state file is unreadable")),
    });

    expect(bridge.ensureState("ada", configWith())).toBe(true);
    // The turn itself is fine; what is lost is autonomy for one character.
    await expect(bridge.settled("ada")).resolves.toBeUndefined();
  });
});

describe("updates that can wait", () => {
  test("are held until the registration finishes", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    const bridge = new TurnAutonomyBridge(service, () => 1000);

    bridge.ensureState("ada", configWith());
    bridge.onUserMessage("ada", 3);

    // Running early would notify a character the loop has not created.
    expect(service.calls).toEqual(["register"]);
    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "user:3:1000"]);
  });

  test("arrive in the order the turn made them", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    const bridge = new TurnAutonomyBridge(service, () => 7);

    bridge.ensureState("ada", configWith());
    bridge.onUserMessage("ada", 1);
    bridge.onCompactionComplete("ada", 2);
    bridge.onCompactionFailed("ada");

    release();
    await bridge.settled("ada");
    // A user message landing after the compaction that followed it restarts an
    // idle clock the compaction had just reset.
    expect(service.calls).toEqual(["register", "user:1:7", "compacted:2", "failed"]);
  });

  test("the user's timestamp is when they spoke, not when the queue drained", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    let clock = 100;
    const bridge = new TurnAutonomyBridge(service, () => clock);

    bridge.ensureState("ada", configWith());
    bridge.onUserMessage("ada", 1);
    clock = 999_999;

    release();
    await bridge.settled("ada");
    // Read after the await, this would be the moment a disk read finished.
    expect(service.calls).toEqual(["register", "user:1:100"]);
  });

  test("an update for a character nobody registered is dropped, not raised", () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);

    expect(() => bridge.onUserMessage("ghost", 1)).not.toThrow();
    expect(service.calls).toEqual([]);
  });
});

describe("seeding the activity tracker", () => {
  test("the latest user turn is the newest, not the last in the list", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);
    bridge.ensureState("ada", configWith());

    // The walk reads the active conversation first and the archived segments
    // after it, so the list runs newest-block-then-older-blocks. Taking the
    // last element seeds the silence clock from the oldest surviving turn and
    // makes a busy character look abandoned.
    bridge.backfillActivity("ada", [new Date(5000), new Date(9000), new Date(1000)]);

    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "backfill:3:9000"]);
  });
});

describe("the question that cannot wait", () => {
  test("is no while the character is still registering", () => {
    const bridge = new TurnAutonomyBridge(recordingService());
    bridge.ensureState("ada", configWith());

    // A latch taken on a runner that does not exist is a latch nothing
    // releases; a compaction one turn late is a compaction one turn late.
    expect(bridge.shouldCompactNow("ada", 20, 100_000)).toBe(false);
  });

  test("is the service's answer once there is one", () => {
    const bridge = new TurnAutonomyBridge({
      ...recordingService(),
      shouldCompactNow: () => true,
    });
    bridge.ensureState("ada", configWith());

    expect(bridge.shouldCompactNow("ada", 20, 100_000)).toBe(true);
  });
});
