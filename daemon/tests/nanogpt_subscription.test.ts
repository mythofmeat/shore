import { required } from "../src/util/required.ts";

import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import {
  NANOGPT_SUBSCRIPTION_TTL_MS,
  fetchNanoGptSubscription,
  nanoGptSubscriptionFresh,
  nanoGptSubscriptionPath,
  nanoGptUsageUrl,
  readNanoGptSubscription,
  writeNanoGptSubscription,
  type NanoGptSubscriptionState,
} from "../src/llm/nanogpt_subscription.ts";
import { requestUrl } from "./support/fetch.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = Date.parse("2026-09-04T06:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.length = 0;
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(testTmp("shore-nanogpt-subscription-"));
  cleanups.push(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function response(body: unknown, calls: Array<{ url: string; authorization: string }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: requestUrl(url), authorization: headers.authorization ?? "" });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

test("the usage endpoint follows the NanoGPT base URL", () => {
  expect(nanoGptUsageUrl("https://nano-gpt.com/api/v1")).toBe(
    "https://nano-gpt.com/api/subscription/v1/usage",
  );
  expect(nanoGptUsageUrl("https://proxy.test/api/v1/")).toBe(
    "https://proxy.test/api/subscription/v1/usage",
  );
});

test.each(["subscription", "paid"])("%s routing still queries the subscription usage endpoint", async (mode) => {
  const calls: Array<{ url: string; authorization: string }> = [];
  await fetchNanoGptSubscription(
    `https://proxy.test/api/${mode}/v1/`, "fixture-key", response({ active: false }, calls), NOW,
  );
  expect(calls).toEqual([{
    url: "https://proxy.test/api/subscription/v1/usage", authorization: "Bearer fixture-key",
  }]);
});

test("the live weekly token shape is normalized for the local cache", async () => {
  const calls: Array<{ url: string; authorization: string }> = [];
  const got = await fetchNanoGptSubscription(
    "https://nano-gpt.com/api/v1",
    "sk-nano-test",
    response({
      active: true,
      state: "active",
      weeklyInputTokens: {
        used: 12_000_000,
        remaining: 48_000_000,
        resetAt: NOW + 86_400_000,
      },
      routing: { recommendedMode: "subscription" },
    }, calls),
    NOW,
  );
  expect(calls).toEqual([{
    url: "https://nano-gpt.com/api/subscription/v1/usage",
    authorization: "Bearer sk-nano-test",
  }]);
  expect(required("ok" in got ? got.ok.weeklyInputTokens : undefined)).toEqual({
    used: 12_000_000,
    remaining: 48_000_000,
    limit: 60_000_000,
    resetAt: "2026-09-05T06:00:00+00:00",
  });
});

test("an inactive account is valid even when it has no quota block", async () => {
  const got = await fetchNanoGptSubscription(
    "https://nano-gpt.com/api/v1",
    "k",
    response({ active: false, state: "inactive", graceUntil: null }, []),
    NOW,
  );
  expect(got).toEqual({
    ok: {
      version: 1,
      fetched_at: "2026-09-04T06:00:00+00:00",
      active: false,
      state: "inactive",
    },
  });
});

test("transport and malformed payload failures do not become inactive readings", async () => {
  const reject = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  const unavailable = await fetchNanoGptSubscription(
    "https://nano-gpt.com/api/v1",
    "k",
    reject,
    NOW,
  );
  expect("err" in unavailable ? unavailable.err.kind : "ok").toBe("network");

  const malformed = await fetchNanoGptSubscription(
    "https://nano-gpt.com/api/v1",
    "k",
    response({ active: true, state: "surprise" }, []),
    NOW,
  );
  expect("err" in malformed ? malformed.err.kind : "ok").toBe("parse");
});

test("the state cache round-trips and expires at the five-minute boundary", async () => {
  const dir = await scratch();
  const path = nanoGptSubscriptionPath(dir);
  const state: NanoGptSubscriptionState = {
    version: 1,
    fetched_at: "2026-09-04T06:00:00.000Z",
    active: true,
    state: "active",
    weeklyInputTokens: {
      used: 1,
      remaining: 59_999_999,
      limit: 60_000_000,
      resetAt: "2026-09-07T00:00:00.000Z",
    },
  };
  await writeNanoGptSubscription(path, state);
  expect(await readNanoGptSubscription(path)).toEqual(state);
  expect(nanoGptSubscriptionFresh(state, NOW + NANOGPT_SUBSCRIPTION_TTL_MS - 1)).toBe(true);
  expect(nanoGptSubscriptionFresh(state, NOW + NANOGPT_SUBSCRIPTION_TTL_MS)).toBe(false);
});
