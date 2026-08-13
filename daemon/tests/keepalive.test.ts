/**
 * Recorded cases for keepalive.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";

import { buildKeepalivePing, type PingNowOutcome } from "../src/cache/keepalive.ts";

/**
 * `restore` and `drain_reply` used to live here too. Both endpoints were
 * retired once `heartbeat.jsonl` and `autonomy_state.json` moved to this side —
 * ping outcomes now go straight to the heartbeat log and schedules are read off
 * the service — so there is no longer a boundary for them to be pinned across.
 * Removing them is a contract ceasing to exist, not a fixture being updated to
 * match a change.
 */
interface KeepaliveFixture {
  character_scoped: { character: string };
  ping_now_reply: PingNowOutcome;
}

const fixturePath = new URL(
  "./rust_fixtures/keepalive.json",
  import.meta.url,
);
const wire = (await Bun.file(fixturePath).json()) as KeepaliveFixture;

const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

function assertKeys<T>(value: unknown, declared: Array<keyof T & string>, what: string) {
  expect(keysOf(value), what).toEqual([...declared].sort());
}

describe("the fixture is real", () => {
  test("a silently unreadable fixture must not pass", () => {
    expect(Object.keys(wire)).toHaveLength(2);
  });
});

describe("requests the daemon sends", () => {
  test("disarm and ping-now name a character and nothing else", () => {
    assertKeys<{ character: string }>(wire.character_scoped, ["character"], "CharacterScoped");
  });

  test("the prefix push is an ordinary request plus a cadence", () => {
    // Not in the fixture as a body of its own: it is a flattened `LlmRequest`
    // plus `context`, both already pinned by `wire.json`. What is new is
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
