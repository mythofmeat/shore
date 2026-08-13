import { describe, expect, test } from "bun:test";

import { CallStore } from "../src/call_store.ts";

function record(
  store: CallStore,
  url: string,
  seq: number,
  headers: [string, string][],
): void {
  store.recordHttpCall({
    call_id: `c${seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 7, 11, 11, seq)),
    character: "Rhia",
    call_type: "message",
    rid: null,
    method: "POST",
    url,
    status: 200,
    status_text: "OK",
    duration_ms: 10,
    error: null,
    request_headers: [],
    request_body: null,
    response_headers: headers,
    response_body: null,
  });
}

const QUOTA: [string, string][] = [
  ["anthropic-ratelimit-requests-limit", "10000"],
  ["anthropic-ratelimit-requests-remaining", "9999"],
  ["anthropic-ratelimit-requests-reset", "2026-08-11T11:19:18Z"],
  ["anthropic-ratelimit-input-tokens-limit", "10000000"],
  ["anthropic-ratelimit-input-tokens-remaining", "9993000"],
];

describe("latestRateLimits", () => {
  test("reports the newest reading per provider host", () => {
    const store = CallStore.openInMemory();
    record(store, "https://api.anthropic.com/v1/messages", 1, [
      ...QUOTA.filter(([k]) => !k.endsWith("requests-remaining")),
      ["anthropic-ratelimit-requests-remaining", "5"],
    ]);
    record(store, "https://api.anthropic.com/v1/messages", 2, QUOTA);

    const readings = store.latestRateLimits();
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      host: "api.anthropic.com",
      requests_remaining: 9999,
      requests_limit: 10000,
      input_tokens_remaining: 9_993_000,
      resets_at: "2026-08-11T11:19:18Z",
    });
  });

  test("hosts that send no quota headers are left out entirely", () => {
    const store = CallStore.openInMemory();
    record(store, "https://api.openai.com/v1/chat/completions", 1, [
      ["content-type", "application/json"],
    ]);
    record(store, "https://api.anthropic.com/v1/messages", 2, QUOTA);

    const hosts = store.latestRateLimits().map((r) => r.host);
    expect(hosts).toEqual(["api.anthropic.com"]);
  });

  test("an empty store reports nothing rather than failing", () => {
    expect(CallStore.openInMemory().latestRateLimits()).toEqual([]);
  });
});
