import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import fixture from "./keepalive_captures/cache_keepalive_walks.json";
import {
  CacheKeepalive,
  type CacheKeepaliveAction,
  type KeepaliveSnapshot,
} from "../src/cache/schedule.ts";

interface WireSnapshot {
  model: string;
  interval_ms: number;
  last_warm_at_ms: number;
  last_active_at_ms: number;
}

interface Step {
  op: string;
  at_ms?: number;
  model?: string;
  interval_ms?: number | null;
  snapshot?: WireSnapshot;
  expect?: string | boolean | WireSnapshot | null;
}

interface Case {
  name: string;
  max_pings: number;
  steps: Step[];
}

const cases = (fixture as { cases: Case[] }).cases;

function toSnapshot(w: WireSnapshot): KeepaliveSnapshot {
  return {
    model: w.model,
    interval: w.interval_ms,
    last_warm_at: w.last_warm_at_ms,
    last_active_at: w.last_active_at_ms,
  };
}

test("each boundary case decides what it says it should", () => {
  expect(cases.length).toBeGreaterThan(0);

  for (const c of cases) {
    const ka = new CacheKeepalive(c.max_pings);
    let restored: CacheKeepalive | undefined;

    c.steps.forEach((step, i) => {
      const where = `${c.name} step ${i} (${step.op})`;
      switch (step.op) {
        case "set_interval":
          ka.setInterval(step.interval_ms ?? undefined, required(step.model), step.at_ms);
          break;
        case "warm":
          ka.onCacheWarmed(required(step.model), required(step.at_ms));
          break;
        case "ping_succeeded":
          ka.onPingSucceeded(required(step.at_ms));
          break;
        case "ping_failed":
          ka.onPingFailed(required(step.at_ms));
          break;
        case "invalidate":
          ka.onCacheInvalidated();
          break;
        case "tick":
          expect(ka.tick(required(step.at_ms)), where).toBe(
            step.expect as CacheKeepaliveAction,
          );
          break;
        case "snapshot": {
          const got = ka.snapshot();
          const want = step.expect as WireSnapshot | null;
          if (want === null) {
            expect(got, where).toBeUndefined();
          } else {
            expect(got, where).toEqual(toSnapshot(want));
          }
          break;
        }
        case "restore": {
          restored = new CacheKeepalive(c.max_pings);
          const armed = restored.restore(
            toSnapshot(required(step.snapshot)),
            required(step.at_ms),
          );
          expect(armed, where).toBe(step.expect as boolean);
          break;
        }
        case "restored_tick":
          expect(required(restored).tick(required(step.at_ms)), where).toBe(
            step.expect as CacheKeepaliveAction,
          );
          break;
        default:
          throw new Error(`${where}: unknown op`);
      }
    });
  }
});

const HOUR = 3_600_000;
const MAX_PINGS = 12;
const INTERVAL = 55 * 60_000;

function armedKeepalive(now = 0): CacheKeepalive {
  const ka = new CacheKeepalive(MAX_PINGS);
  ka.setInterval(INTERVAL, "opus", now);
  ka.onCacheWarmed("opus", now);
  return ka;
}

describe("an armed keepalive", () => {
  test("pings once the interval has elapsed, and not before", () => {
    const ka = armedKeepalive(0);
    expect(ka.tick(INTERVAL - 1)).toBe("none");
    expect(ka.tick(INTERVAL)).toBe("ping");
  });

  test("keeps saying ping until something answers, since a tick is not an answer", () => {
    const ka = armedKeepalive(0);
    expect(ka.tick(INTERVAL)).toBe("ping");
    expect(ka.tick(INTERVAL + 1)).toBe("ping");
  });

  test("re-arms from the moment the ping succeeded, not from the deadline it missed", () => {
    const ka = armedKeepalive(0);
    ka.onPingSucceeded(INTERVAL * 2);
    expect(ka.tick(INTERVAL * 2)).toBe("none");
    expect(ka.tick(INTERVAL * 3)).toBe("ping");
  });

  test("stops entirely once it has sent every ping it was allowed", () => {
    const ka = armedKeepalive(0);
    for (let sent = 1; sent <= MAX_PINGS; sent += 1) {
      expect(ka.tick(sent * INTERVAL), `ping ${sent}`).toBe("ping");
      ka.onPingSucceeded(sent * INTERVAL);
    }
    expect(ka.tick((MAX_PINGS + 1) * INTERVAL)).toBe("none");
    expect(ka.tick((MAX_PINGS + 2) * INTERVAL)).toBe("none");
  });

  test("a failed ping is retried without spending the count", () => {
    const ka = new CacheKeepalive(1);
    ka.setInterval(INTERVAL, "opus", 0);
    ka.onCacheWarmed("opus", 0);
    expect(ka.tick(INTERVAL)).toBe("ping");
    ka.onPingFailed(INTERVAL);
    expect(ka.pingsSent).toBe(0);
    expect(ka.tick(required(ka.nextPingAt))).toBe("ping");
  });
});

describe("a keepalive with nothing to keep warm", () => {
  test("does nothing when no interval is configured", () => {
    const ka = new CacheKeepalive(MAX_PINGS);
    ka.setInterval(undefined, "opus", 0);
    ka.onCacheWarmed("opus", 0);
    expect(ka.tick(10 * HOUR)).toBe("none");
    expect(ka.snapshot()).toBeUndefined();
  });

  test("does nothing until a turn has actually warmed the cache", () => {
    const ka = new CacheKeepalive(MAX_PINGS);
    ka.setInterval(INTERVAL, "opus", 0);
    expect(ka.tick(10 * HOUR)).toBe("none");
  });

  test("forgets everything when the cache is invalidated", () => {
    const ka = armedKeepalive(0);
    ka.onCacheInvalidated();
    expect(ka.tick(10 * HOUR)).toBe("none");
    expect(ka.snapshot()).toBeUndefined();
  });

  test("switching model invalidates, so a ping never warms the wrong prefix", () => {
    const ka = armedKeepalive(0);
    ka.setInterval(INTERVAL, "sonnet", 0);
    expect(ka.snapshot()).toBeUndefined();
    expect(ka.tick(10 * HOUR)).toBe("none");
  });

  test("a warm for a model that is not the target is ignored", () => {
    const ka = new CacheKeepalive(MAX_PINGS);
    ka.setInterval(INTERVAL, "opus", 0);
    ka.onCacheWarmed("sonnet", 0);
    expect(ka.tick(10 * HOUR)).toBe("none");
  });
});

describe("a ping that fails", () => {
  test("backs off rather than retrying on the next tick", () => {
    const ka = armedKeepalive(0);
    ka.tick(INTERVAL);
    ka.onPingFailed(INTERVAL);
    expect(ka.tick(INTERVAL)).toBe("none");
  });

  test("backs off further each time, so a dead provider is not hammered", () => {
    const ka = armedKeepalive(0);
    let previous = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const at = INTERVAL;
      ka.onPingFailed(at);
      const wait = required(ka.nextPingAt) - at;
      expect(wait, `attempt ${attempt}`).toBeGreaterThan(previous);
      previous = wait;
    }
  });

  test("gives up once the warmth it was protecting has expired anyway", () => {
    const ka = armedKeepalive(0);
    ka.onPingFailed(10 * HOUR);
    expect(ka.snapshot()).toBeUndefined();
    expect(ka.tick(10 * HOUR)).toBe("none");
  });
});

describe("a keepalive restored from a snapshot", () => {
  test("comes back armed when the warmth it recorded is still good", () => {
    const ka = armedKeepalive(0);
    const snap = required(ka.snapshot());
    const restored = new CacheKeepalive(MAX_PINGS);
    expect(restored.restore(snap, INTERVAL - 1)).toBe(true);
    expect(restored.tick(INTERVAL)).toBe("ping");
  });

  test("refuses when the warmth it recorded has already lapsed", () => {
    const ka = armedKeepalive(0);
    const snap = required(ka.snapshot());
    const restored = new CacheKeepalive(MAX_PINGS);
    expect(restored.restore(snap, INTERVAL)).toBe(false);
    expect(restored.tick(INTERVAL)).toBe("none");
  });

  test("round-trips: a snapshot restored and re-snapshotted is the same snapshot", () => {
    const ka = armedKeepalive(0);
    const snap = required(ka.snapshot());
    const restored = new CacheKeepalive(MAX_PINGS);
    restored.restore(snap, 1);
    expect(restored.snapshot()).toEqual(snap);
  });
});

describe("over a long randomised run of events", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`the invariants hold for seed ${seed}`, () => {
      let state = seed * 2654435761;
      const rand = (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
      };

      const ka = new CacheKeepalive(MAX_PINGS);
      let now = 0;

      for (let step = 0; step < 300; step += 1) {
        now += rand(2 * HOUR) + 1;
        switch (rand(6)) {
          case 0:
            ka.setInterval(rand(2) === 0 ? INTERVAL : undefined, "opus", now);
            break;
          case 1:
            ka.onCacheWarmed("opus", now);
            break;
          case 2:
            ka.onPingSucceeded(now);
            break;
          case 3:
            ka.onPingFailed(now);
            break;
          case 4:
            ka.onCacheInvalidated();
            break;
          default:
            break;
        }

        const where = `seed ${seed} step ${step}`;
        const action = ka.tick(now);
        expect(["none", "ping"], where).toContain(action);

        if (action === "ping") {
          expect(ka.interval, `${where}: a ping needs a cadence`).toBeDefined();
          expect(ka.nextPingAt, `${where}: a ping only fires once it is due`).toBeDefined();
          expect(required(ka.nextPingAt), `${where}: a ping is never early`).toBeLessThanOrEqual(now);
        }

        if (ka.interval === undefined) {
          expect(action, `${where}: no cadence means no ping`).toBe("none");
        }

        if (ka.pingsSent >= MAX_PINGS) {
          expect(action, `${where}: a spent count means no ping`).toBe("none");
        }

        const snap = ka.snapshot();
        if (snap !== undefined) {
          expect(snap.interval, `${where}: a snapshot carries a real cadence`).toBeGreaterThan(0);
          expect(snap.last_warm_at, `${where}: a snapshot is not from the future`).toBeLessThanOrEqual(now);
        }
      }
    });
  }
});
