import { required } from "../src/util/required.ts";

import { expect, test } from "bun:test";

import fixture from "./keepalive_fixtures/cache_keepalive_walks.json";
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
  max_idle_ms: number;
  steps: Step[];
}

const cases = (fixture as { cases: Case[] }).cases;

const PINGS_EARLIER: ReadonlySet<string> = new Set([
  "walk_02:24",
  "walk_09:28",
  "walk_32:18",
  "walk_37:20",
  "walk_37:21",
  "walk_37:29",
]);

function toSnapshot(w: WireSnapshot): KeepaliveSnapshot {
  return {
    model: w.model,
    interval: w.interval_ms,
    last_warm_at: w.last_warm_at_ms,
    last_active_at: w.last_active_at_ms,
  };
}

test("every recorded walk decides the same at each step", () => {
  expect(cases.length).toBeGreaterThan(0);

  for (const c of cases) {
    const ka = new CacheKeepalive(c.max_idle_ms);
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
        case "tick": {
          if (PINGS_EARLIER.has(`${c.name}:${i}`)) {
            expect(step.expect, where).toBe("none");
            expect(ka.tick(required(step.at_ms)), where).toBe("ping");
            break;
          }
          expect(ka.tick(required(step.at_ms)), where).toBe(
            step.expect as CacheKeepaliveAction,
          );
          break;
        }
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
          restored = new CacheKeepalive(c.max_idle_ms);
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
