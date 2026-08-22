import { describe, expect, test } from "bun:test";

import { buildKeepalivePing } from "../src/cache/keepalive.ts";

describe("a keepalive ping", () => {
  test("is an ordinary request, with the cadence left off the wire", () => {
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
    expect(ping).toMatchObject({ sdk: "anthropic", model: "m", api_key: "k" });
  });

  test("asks for as little output as it can, since only the prefix matters", () => {
    const ping = buildKeepalivePing({
      sdk: "anthropic",
      model: "m",
      api_key: "k",
      messages: [],
      max_tokens: 4096,
      replay_prior_thinking: "all",
      keepalive_interval_ms: 60_000,
    });
    expect(ping.max_tokens).toBeLessThanOrEqual(4096);
    expect(ping.max_tokens).toBeGreaterThan(0);
  });
});
