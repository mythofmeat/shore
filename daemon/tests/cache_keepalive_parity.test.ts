/**
 * Cross-language parity for the cache keepalive.
 *
 * The unit tests in `cache_keepalive.test.ts` were translated from the Rust
 * alongside the implementation, so they cannot catch a mistake made in both
 * halves of the translation at once. This can: the fixture was *generated* by
 * running pseudo-random event walks through the real Rust state machine and
 * recording what it decided. This replays those walks against the TypeScript
 * port and demands the same answer at every observable point.
 *
 * The Rust that generated it — `crates/daemon/src/cache_keepalive.rs` — is gone,
 * deleted when the schedule, the clock, and the ping moved to this side. So the
 * fixture is frozen: it is the last word on what the daemon did, not something
 * to regenerate when a diff appears.
 *
 * What a failure here means: the two implementations disagree about when to
 * ping. If TypeScript pings where Rust would not, that ping lands on a prefix
 * Rust knew was cold and pays a full cache write. That is the failure mode the
 * whole subsystem exists to prevent, so treat a diff here as a defect until
 * proven otherwise — not as a fixture that needs regenerating.
 */

import { expect, test } from "bun:test";

import fixture from "./keepalive_fixtures/cache_keepalive_parity.json";
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

/**
 * The steps where the port pings and the Rust did not, keyed `case:step`.
 *
 * #27 anchors the ping deadline on the last *confirmed* warm of the prefix a
 * ping sends, rather than on the last event claiming to be a warm:
 *
 *     nextPingAt = min(now + interval, prefixWarmAt + interval)
 *
 * The fixture's `warm` op is the ledger funnel's signal — "a real call ran on
 * this model" — which is precisely the claim the clamp declines to trust. It
 * has no op for the *other* half of a real turn, the body being cached
 * afterwards, because the Rust had nothing that distinguished them. So a replay
 * of a bare `warm` leaves the anchor where the last ping put it, and the ping
 * comes due earlier than the Rust scheduled it.
 *
 * **This diverges in the safe direction, and only in it.** The port pings
 * *sooner*, never later, and never re-arms something invalidation or the idle
 * ceiling had stood down — the clamp can only lower `nextPingAt`. An early ping
 * costs one cheap read; a late one is the cold write this whole subsystem
 * exists to prevent, and eight of the eleven cold pings in #27's evidence came
 * from a deadline that had slid exactly this way.
 *
 * Every other step is still compared strictly, including every `ping` the Rust
 * expected: a port that failed to ping where the Rust did would be scheduling
 * *later*, and that is a defect however it is arrived at.
 *
 * All six listed steps are the same shape, checked one by one rather than
 * assumed: a `ping_succeeded` sets the anchor, one or more bare `warm`s follow
 * that the clamp declines to trust, and a tick falls in the gap between the two
 * deadlines. None of them is a ping into an invalidated or idle-ceilinged
 * schedule — the clamp cannot produce one, since it only ever lowers a
 * `nextPingAt` that was already set.
 *
 * `walk_32:18` is worth naming: its warm is on the *target* model and is still
 * clamped. That is the second mechanism #27 describes — same model, different
 * prefix — which the earlier `4ee6bb7f` model guard could not catch, and which
 * accounts for the three cold pings that fix left behind.
 */
const PINGS_EARLIER: ReadonlySet<string> = new Set([
  "walk_02:24",
  "walk_09:28",
  "walk_32:18",
  "walk_37:20",
  "walk_37:21",
  "walk_37:29",
]);

/** The fixture's snapshot shape → the port's. */
function toSnapshot(w: WireSnapshot): KeepaliveSnapshot {
  return {
    model: w.model,
    interval: w.interval_ms,
    last_warm_at: w.last_warm_at_ms,
    last_active_at: w.last_active_at_ms,
  };
}

test("cross-language keepalive decision parity", () => {
  expect(cases.length).toBeGreaterThan(0);

  for (const c of cases) {
    const ka = new CacheKeepalive(c.max_idle_ms);
    // `restore` opens a fresh keepalive; the `restored_tick`s that follow probe
    // it, mirroring how the Rust generator built the tail.
    let restored: CacheKeepalive | undefined;

    c.steps.forEach((step, i) => {
      const where = `${c.name} step ${i} (${step.op})`;
      switch (step.op) {
        case "set_interval":
          ka.setInterval(step.interval_ms ?? undefined, step.model!, step.at_ms);
          break;
        case "warm":
          ka.onCacheWarmed(step.model!, step.at_ms!);
          break;
        case "ping_succeeded":
          ka.onPingSucceeded(step.at_ms!);
          break;
        case "ping_failed":
          ka.onPingFailed(step.at_ms!);
          break;
        case "invalidate":
          ka.onCacheInvalidated();
          break;
        case "tick": {
          if (PINGS_EARLIER.has(`${c.name}:${i}`)) {
            // Asserted in both directions: the Rust's answer is still what the
            // fixture holds, and ours is the one the clamp produces. A step
            // that stopped diverging would fail here rather than pass quietly.
            expect(step.expect, where).toBe("none");
            expect(ka.tick(step.at_ms!), where).toBe("ping");
            break;
          }
          expect(ka.tick(step.at_ms!), where).toBe(
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
            toSnapshot(step.snapshot!),
            step.at_ms!,
          );
          expect(armed, where).toBe(step.expect as boolean);
          break;
        }
        case "restored_tick":
          expect(restored!.tick(step.at_ms!), where).toBe(
            step.expect as CacheKeepaliveAction,
          );
          break;
        default:
          throw new Error(`${where}: unknown op`);
      }
    });
  }
});
