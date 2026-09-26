import { shoreLog } from "../log.ts";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { toRfc3339 } from "../ledger/zoned.ts";
import { truncateForLog, type DiscoveryResult } from "./discovery.ts";
import {
  NANOGPT_BASE_URL,
  NANOGPT_PROVIDER,
  NANOGPT_USAGE_URL,
} from "./providers/nanogpt_config.ts";

export const NANOGPT_SUBSCRIPTION_TTL_MS = 5 * 60 * 1000;

export type NanoGptWeeklyInputTokens = import("../protocol/NanoGptWeeklyInputTokens.ts").NanoGptWeeklyInputTokens;

export type NanoGptSubscriptionState = import("../protocol/NanoGptSubscriptionState.ts").NanoGptSubscriptionState;

export function nanoGptSubscriptionPath(cacheDir: string): string {
  return join(cacheDir, "providers", NANOGPT_PROVIDER, "subscription.json");
}

export function nanoGptUsageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/(?:subscription|paid)\/v1$/, "/v1");
  if (base === NANOGPT_BASE_URL) return NANOGPT_USAGE_URL;
  if (base.endsWith("/api/v1")) {
    return `${base.slice(0, -"/api/v1".length)}/api/subscription/v1/usage`;
  }
  if (base.endsWith("/v1")) {
    return `${base.slice(0, -"/v1".length)}/subscription/v1/usage`;
  }
  return `${base}/subscription/usage`;
}

export async function fetchNanoGptSubscription(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<DiscoveryResult<NanoGptSubscriptionState>> {
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(nanoGptUsageUrl(baseUrl), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    body = await response.text();
  } catch (e) {
    return { err: { kind: "network", provider: NANOGPT_PROVIDER, message: String(e) } };
  }
  if (!response.ok) {
    return {
      err: {
        kind: "http_status",
        provider: NANOGPT_PROVIDER,
        status: response.status,
        body: truncateForLog(body),
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return {
      err: { kind: "parse", provider: NANOGPT_PROVIDER, message: String(e) },
    };
  }
  const state = asNanoGptSubscription(parsed, toRfc3339(now));
  return state === undefined
    ? {
        err: {
          kind: "parse",
          provider: NANOGPT_PROVIDER,
          message: "subscription response has an invalid shape",
        },
      }
    : { ok: state };
}

export async function readNanoGptSubscription(
  path: string,
): Promise<NanoGptSubscriptionState | undefined> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return decodeSubscription(body, path);
}

export function readNanoGptSubscriptionSync(
  path: string,
): NanoGptSubscriptionState | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return decodeSubscription(body, path);
}

function decodeSubscription(body: string, path: string): NanoGptSubscriptionState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    shoreLog.warn(`NanoGPT subscription cache failed to parse — treating as missing: ${path}`);
    return undefined;
  }
  const state = asNanoGptSubscription(parsed);
  if (state === undefined) {
    shoreLog.warn(`NanoGPT subscription cache failed to parse — treating as missing: ${path}`);
  }
  return state;
}

export async function writeNanoGptSubscription(
  path: string,
  state: NanoGptSubscriptionState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

export function nanoGptSubscriptionFresh(
  state: NanoGptSubscriptionState | undefined,
  now: number = Date.now(),
): boolean {
  if (state === undefined) return false;
  const fetched = Date.parse(state.fetched_at);
  if (!Number.isFinite(fetched)) return false;
  const age = now - fetched;
  return age >= 0 && age < NANOGPT_SUBSCRIPTION_TTL_MS;
}

function asNanoGptSubscription(
  value: unknown,
  fetchedAt?: string,
): NanoGptSubscriptionState | undefined {
  if (!record(value)) return undefined;
  if (typeof value.active !== "boolean") return undefined;
  if (value.state !== "active" && value.state !== "grace" && value.state !== "inactive") {
    return undefined;
  }
  const stamp = fetchedAt ?? value.fetched_at;
  if (typeof stamp !== "string" || !Number.isFinite(Date.parse(stamp))) return undefined;
  const weekly = weeklyTokens(value.weeklyInputTokens);
  const routing = routingHint(value.routing);
  return {
    version: 1,
    fetched_at: stamp,
    active: value.active,
    state: value.state,
    ...(weekly === undefined ? {} : { weeklyInputTokens: weekly }),
    ...(routing === undefined ? {} : { routing }),
  };
}

function weeklyTokens(value: unknown): NanoGptWeeklyInputTokens | undefined {
  if (!record(value)) return undefined;
  const used = nonnegative(value.used);
  const remaining = nonnegative(value.remaining);
  const resetAt = timestamp(value.resetAt);
  if (used === undefined || remaining === undefined || resetAt === undefined) return undefined;
  const stated = nonnegative(value.limit) ?? nonnegative(value.total);
  const limit = stated ?? used + remaining;
  if (!Number.isSafeInteger(limit) || limit < used || limit < remaining) return undefined;
  return { used, remaining, limit, resetAt };
}

function routingHint(value: unknown): { recommendedMode?: string } | undefined {
  if (!record(value)) return undefined;
  return typeof value.recommendedMode === "string"
    ? { recommendedMode: value.recommendedMode }
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isFinite(new Date(value).getTime())) return undefined;
    return toRfc3339(value);
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
