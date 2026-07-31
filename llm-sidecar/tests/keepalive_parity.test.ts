/**
 * Cross-language shape parity for the `/v1/keepalive/*` control bodies.
 *
 * These are Rust structs in `crates/daemon/src/ledger/client.rs` and TypeScript
 * interfaces in `src/autonomy/keepalive.ts`, written to match by hand. Nothing
 * checked that they did, and the exposure here is worse than for the provider
 * wire: a renamed field on a provider request usually breaks something loudly,
 * while a renamed field on one of these fails **silently, in the allowing
 * direction**.
 *
 * That is not hypothetical. During the port a daemon sending
 * `keepalive_interval_ms` met a sidecar reading `keepalive_interval_secs`. No
 * error anywhere: the key was absent, so the cadence was `undefined`, so
 * keepalive was off, so nothing ever pinged. The only symptom was a character
 * that quietly stopped warming its cache.
 *
 * The lock closes in both directions, as in `wire_parity.test.ts`:
 *
 *   - Rust renames a field → the fixture changes → the key assertions below
 *     fail, because the fixture carries a key this side never declared.
 *   - Someone adds that key here → `tsc` rejects it, because the lists are
 *     typed `Array<keyof T>` and the interface does not have it yet.
 *
 * Requests are generated from the real Rust structs, because the daemon sends
 * them. Replies are literals in the same fixture, asserted on the Rust side to
 * deserialize (`keepalive_replies_parse`) and asserted here to match what this
 * side actually produces — the split mirrors `call_complete`.
 */

import { describe, expect, test } from "bun:test";

import {
  buildKeepalivePing,
  type KeepaliveDrain,
  type KeepaliveRestore,
  type KeepaliveSchedule,
  type PingNowOutcome,
} from "../src/autonomy/keepalive.ts";

interface KeepaliveFixture {
  character_scoped: { character: string };
  restore: KeepaliveRestore;
  restore_reply: { rearmed: boolean };
  drain_reply: KeepaliveDrain;
  ping_now_reply: PingNowOutcome;
}

const fixturePath = new URL(
  "../../crates/daemon/tests/fixtures/keepalive_parity.json",
  import.meta.url,
);
const wire = (await Bun.file(fixturePath).json()) as KeepaliveFixture;

const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

function assertKeys<T>(value: unknown, declared: Array<keyof T & string>, what: string) {
  expect(keysOf(value), what).toEqual([...declared].sort());
}

describe("the fixture is real", () => {
  test("a silently unreadable fixture must not pass", () => {
    expect(Object.keys(wire)).toHaveLength(5);
  });
});

describe("requests the daemon sends", () => {
  test("disarm, drain, and ping-now name a character and nothing else", () => {
    assertKeys<{ character: string }>(wire.character_scoped, ["character"], "CharacterScoped");
  });

  test("restore carries a whole schedule plus the ceiling", () => {
    // Flattened: the schedule's fields sit alongside `max_idle_secs` rather
    // than nested, because the sidecar destructures the rest into a snapshot.
    assertKeys<KeepaliveRestore>(
      wire.restore,
      ["character", "model", "interval", "last_warm_at", "last_active_at", "max_idle_secs"],
      "KeepaliveRestore",
    );
    // Milliseconds on both timestamps and the cadence. Seconds here would read
    // as a schedule ~1000x stale, fail the staleness guard, and stop re-arming
    // after every restart — silently, because declining to re-arm is the safe
    // path and therefore says nothing.
    expect(wire.restore.interval).toBe(3_300_000);
    expect(wire.restore.last_warm_at).toBeGreaterThan(1_700_000_000_000);
    // The ceiling stays in seconds: it is `cache_keepalive_max`, which the
    // daemon already sends as seconds on every CallContext.
    expect(wire.restore.max_idle_secs).toBe(43_200);
  });

  test("the prefix push is an ordinary request plus a cadence", () => {
    // Not in the fixture as a body of its own: it is a flattened `LlmRequest`
    // plus `context`, both already pinned by `wire_parity.json`. What is new is
    // the cadence key, and that `buildKeepalivePing` strips it before the body
    // reaches a provider — asserted in `keepalive_service.test.ts`.
    const ping = buildKeepalivePing({
      sdk: "anthropic",
      model: "m",
      api_key: "k",
      messages: [],
      max_tokens: 8,
      replay_prior_thinking: "all",
      keepalive_interval_ms: 3_300_000,
    });
    expect("keepalive_interval_ms" in ping).toBe(false);
  });
});

describe("replies the sidecar sends", () => {
  test("restore reports whether it took the schedule up", () => {
    assertKeys<{ rearmed: boolean }>(wire.restore_reply, ["rearmed"], "RestoreKeepaliveReply");
  });

  test("drain carries events and schedules", () => {
    assertKeys<KeepaliveDrain>(wire.drain_reply, ["events", "schedules"], "KeepaliveDrain");

    const event = wire.drain_reply.events[0];
    expect(event, "the census carries an event").toBeDefined();
    assertKeys<NonNullable<typeof event>>(
      event,
      ["character", "outcome", "detail", "at"],
      "KeepaliveEvent",
    );
    // `character` routes the event to a heartbeat log; `detail` is the line
    // itself. The daemon drops an event it cannot attribute.
    expect(event!.outcome).toBe("cold");

    const schedule = wire.drain_reply.schedules[0];
    expect(schedule, "the census carries a schedule").toBeDefined();
    assertKeys<KeepaliveSchedule>(
      schedule,
      ["character", "model", "interval", "last_warm_at", "last_active_at"],
      "KeepaliveSchedule",
    );
  });

  test("ping-now reports a machine-readable cause, not just prose", () => {
    assertKeys<PingNowOutcome>(
      wire.ping_now_reply,
      ["status", "cold", "reason", "detail"],
      "PingNowOutcome",
    );
    // The daemon branches on `reason` to decide whether to rebuild the body
    // from disk and push before asking again. Matching the prose instead would
    // make a reworded log line change control flow.
    expect(wire.ping_now_reply.reason).toBe("no_prefix");
  });
});
