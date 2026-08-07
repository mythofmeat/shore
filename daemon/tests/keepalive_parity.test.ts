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

import { buildKeepalivePing, type PingNowOutcome } from "../src/autonomy/keepalive.ts";

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
  "./rust_fixtures/keepalive_parity.json",
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
