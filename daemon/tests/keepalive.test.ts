import { describe, expect, test } from "bun:test";

import { buildKeepalivePing, type PingNowOutcome } from "../src/cache/keepalive.ts";

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
    expect(wire.ping_now_reply.reason).toBe("no_prefix");
  });
});
