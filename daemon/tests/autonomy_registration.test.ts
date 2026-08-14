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

function recordingService(registerDelay?: Promise<void>) {
  const calls: string[] = [];
  const stamps: number[] = [];
  return {
    calls,
    stamps,
    register: async () => {
      calls.push("register");
      if (registerDelay !== undefined) await registerDelay;
    },
    backfillActivity: (_c: string, at: readonly number[], latest: number | undefined) => {
      stamps.push(...at);
      calls.push(`backfill:${at.length}:${String(latest)}`);
    },
    onUserMessage: (_c: string, turns: number, at: number) => {
      calls.push(`user:${turns}:${at}`);
    },
    onAssistantMessage: (_c: string, turns: number) => {
      calls.push(`assistant:${turns}`);
    },
    setCompactionConfig: (_c: string, cfg: { maxTurns: number }) => {
      calls.push(`compaction:${cfg.maxTurns}`);
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

    expect(clockConfigFor(config)).toEqual({
      defaultIntervalMs: 1_800_000,
      maxIdleTicks: 4,
      maxSilentMs: 172_800_000,
      minWakeIntervalMs: 600_000,
    });
  });

  test("state lives under the character's own directory", () => {
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
    const bridge = new TurnAutonomyBridge(service, () => 7, "UTC");

    bridge.ensureState("ada", configWith());
    bridge.onUserMessage("ada", 1);
    bridge.onAssistantMessage("ada", 2);
    bridge.onCompactionComplete("ada", 2);
    bridge.onCompactionFailed("ada");

    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual([
      "register",
      "user:1:7",
      "assistant:2",
      "compacted:2",
      "failed",
    ]);
  });

  test("the character's own turn is one of them", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    const bridge = new TurnAutonomyBridge(service);

    bridge.ensureState("ada", configWith());
    bridge.onAssistantMessage("ada", 9);

    expect(service.calls).toEqual(["register"]);
    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "assistant:9"]);
  });

  test("the user's timestamp is when they spoke, not when the queue drained", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    let clock = 100;
    const bridge = new TurnAutonomyBridge(service, () => clock, "UTC");

    bridge.ensureState("ada", configWith());
    bridge.onUserMessage("ada", 1);
    clock = 999_999;

    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "user:1:100"]);
  });

  test("an update for a character nobody registered is dropped, not raised", () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);

    expect(() => bridge.onUserMessage("ghost", 1)).not.toThrow();
    expect(service.calls).toEqual([]);
  });
});

describe("the hour the tracker is told a message landed in", () => {
  const NOON_UTC = Date.UTC(2026, 7, 15, 12, 0, 0);
  const hourOf = (naive: number): number => new Date(naive).getUTCHours();

  test("is the user's wall clock, not UTC", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service, () => NOON_UTC, "Australia/Sydney");
    bridge.ensureState("ada", configWith());

    bridge.onUserMessage("ada", 1);

    await bridge.settled("ada");
    const at = Number(service.calls[1]?.split(":")[2]);
    expect(hourOf(at)).toBe(22);
  });

  test("and a backfilled one is shifted the same way", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service, () => 0, "Australia/Sydney");
    bridge.ensureState("ada", configWith());

    bridge.backfillActivity("ada", [new Date(NOON_UTC)]);

    await bridge.settled("ada");
    expect(service.stamps.map(hourOf)).toEqual([22]);
  });

  test("but the silence clock is still seeded with the real instant", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service, () => 0, "Australia/Sydney");
    bridge.ensureState("ada", configWith());

    bridge.backfillActivity("ada", [new Date(NOON_UTC)]);

    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", `backfill:1:${String(NOON_UTC)}`]);
  });
});

describe("seeding the activity tracker", () => {
  test("the latest user turn is the newest, not the last in the list", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);
    bridge.ensureState("ada", configWith());

    bridge.backfillActivity("ada", [new Date(5000), new Date(9000), new Date(1000)]);

    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "backfill:3:9000"]);
  });
});

describe("a config reload", () => {
  test("reaches every character the bridge has taken up, and no one else", async () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);
    bridge.ensureState("ada", configWith());
    bridge.ensureState("nova", configWith());

    const asked: string[] = [];
    bridge.reloadConfig((name) => {
      asked.push(name);
      return configWith((app) => {
        app.memory.compaction.max_turns = name === "ada" ? 11 : 22;
      });
    });

    await bridge.settled("ada");
    await bridge.settled("nova");
    expect(asked.sort()).toEqual(["ada", "nova"]);
    expect(service.calls.filter((c) => c.startsWith("compaction"))).toEqual([
      "compaction:11",
      "compaction:22",
    ]);
  });

  test("tells nobody when nothing is registered", () => {
    const service = recordingService();
    const bridge = new TurnAutonomyBridge(service);

    bridge.reloadConfig(() => configWith());
    expect(service.calls).toEqual([]);
  });

  test("waits for a registration still in flight", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(slow);
    const bridge = new TurnAutonomyBridge(service);

    bridge.ensureState("ada", configWith());
    bridge.reloadConfig(() => configWith((app) => (app.memory.compaction.max_turns = 3)));

    expect(service.calls).toEqual(["register"]);
    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "compaction:3"]);
  });
});

describe("the question that cannot wait", () => {
  test("is no while the character is still registering", () => {
    const bridge = new TurnAutonomyBridge(recordingService());
    bridge.ensureState("ada", configWith());

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
