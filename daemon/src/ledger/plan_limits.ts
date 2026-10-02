import { shoreLog } from "../log.ts";

import type { Database } from "bun:sqlite";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultPlanLimitPolicy, type PlanLimitPolicyConfig } from "../config/app.ts";
import type { SidecarRequest } from "../llm/types.ts";
import type { ClaudePlanLimit } from "../protocol/ClaudePlanLimit.ts";
import type { ClaudePlanLimitsReport } from "../protocol/ClaudePlanLimitsReport.ts";
import type { ClaudePlanWindow } from "../protocol/ClaudePlanWindow.ts";
import type { PlanLimitWarning } from "../protocol/PlanLimitWarning.ts";
import {
  actionBlocks,
  crossedThresholds,
  levelName,
  recordBudgetWarningThreshold,
  type BudgetOptions,
  type CallBlock,
  type UsageBudgetAction,
  type UsageConfig,
} from "./budget.ts";
import { formatLocalAmPm, toRfc3339, zoneFor } from "./zoned.ts";

const CLAUDE_PLAN_WINDOWS: readonly ClaudePlanWindow[] = ["five_hour", "seven_day"];

export const CLAUDE_PLAN_REFRESH_MS = 5 * 60 * 1000;

export const CLAUDE_PLAN_REPORT_REFRESH_MS = 60 * 1000;

const MINUTE_MS = 60 * 1000;

export interface ClaudePlanReading {
  percent_used: number;
  resets_at: string | null;
}

export interface ClaudePlanPoll {
  subscription_type: string | null;
  five_hour: ClaudePlanReading | null;
  seven_day: ClaudePlanReading | null;
}

export interface ClaudePlanLimitsState extends ClaudePlanPoll {
  version: 1;
  updated_at: string;
  polled_at: string | null;
}

export type PlanLimitWarningEvent = Omit<PlanLimitWarning, "rid">;

export type ClaudePlanFetcher = () => Promise<ClaudePlanPoll | undefined>;

export interface ClaudePlanLimitsOptions {
  cacheDir?: string;
  fetch?: ClaudePlanFetcher;
}

const WINDOW_NAMES: Record<ClaudePlanWindow, string> = {
  five_hour: "Claude 5-hour limit",
  seven_day: "Claude weekly limit",
};

const ACTION_PHRASES: Record<UsageBudgetAction, string> = {
  warn: "warning only",
  block: "Claude calls blocked",
  pause_background: "background work paused",
  pause_heartbeat: "heartbeat paused",
};

let cacheDir: string | undefined;
let fetcher: ClaudePlanFetcher | undefined;
let current: ClaudePlanLimitsState | undefined;
let attemptedAt = Number.NEGATIVE_INFINITY;
let refreshing: Promise<void> | undefined;
let observed: Record<ClaudePlanWindow, number> = { five_hour: 0, seven_day: 0 };
let persisting: Promise<void> = Promise.resolve();

export function claudePlanLimitsPath(dir: string): string {
  return join(dir, "providers", "claude_agent", "plan_limits.json");
}

export function configureClaudePlanLimits(options: ClaudePlanLimitsOptions = {}): void {
  cacheDir = options.cacheDir;
  fetcher = options.fetch;
  current = cacheDir === undefined ? undefined : readClaudePlanLimits(claudePlanLimitsPath(cacheDir));
  attemptedAt = Number.NEGATIVE_INFINITY;
  refreshing = undefined;
  observed = { five_hour: 0, seven_day: 0 };
}

export function claudePlanLimitsState(): ClaudePlanLimitsState | undefined {
  return current;
}

export async function refreshClaudePlanLimits(maxAgeMs: number, now: number = Date.now()): Promise<void> {
  const fetch = fetcher;
  if (fetch === undefined) return;
  if (refreshing === undefined && now - lastAttempt() < maxAgeMs) return;
  refreshing ??= pollClaudePlanLimits(fetch, now).finally(() => {
    refreshing = undefined;
  });
  await refreshing;
}

function lastAttempt(): number {
  const polled = current?.polled_at;
  const at = polled === undefined || polled === null ? Number.NaN : Date.parse(polled);
  return Number.isFinite(at) ? Math.max(attemptedAt, at) : attemptedAt;
}

async function pollClaudePlanLimits(fetch: ClaudePlanFetcher, now: number): Promise<void> {
  attemptedAt = now;
  const seen = { ...observed };
  let poll: ClaudePlanPoll | undefined;
  try {
    poll = await fetch();
  } catch (e) {
    shoreLog.warn(`shore: could not read Claude plan limits: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (poll === undefined) return;
  const stamp = toRfc3339(now);
  const prior = current;
  const newer = (window: ClaudePlanWindow): ClaudePlanReading | null =>
    observed[window] === seen[window] ? poll[window] : prior?.[window] ?? null;
  current = {
    version: 1,
    updated_at: stamp,
    polled_at: stamp,
    subscription_type: poll.subscription_type,
    five_hour: newer("five_hour"),
    seven_day: newer("seven_day"),
  };
  await persist();
}

export function observeClaudeRateLimit(info: SDKRateLimitInfo, now: number = Date.now()): void {
  const window = CLAUDE_PLAN_WINDOWS.find((name) => name === info.rateLimitType);
  if (window === undefined) return;
  const reported = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? info.utilization : undefined;
  const percent = info.status === "rejected" ? Math.max(1, reported ?? 1) : reported;
  if (percent === undefined || percent < 0) return;
  const prior = current;
  const resets_at = info.resetsAt === undefined ? prior?.[window]?.resets_at ?? null : claudePlanInstant(info.resetsAt);
  const reading = { percent_used: percent, resets_at };
  observed[window] += 1;
  current = {
    version: 1,
    updated_at: toRfc3339(now),
    polled_at: prior?.polled_at ?? null,
    subscription_type: prior?.subscription_type ?? null,
    five_hour: window === "five_hour" ? reading : prior?.five_hour ?? null,
    seven_day: window === "seven_day" ? reading : prior?.seven_day ?? null,
  };
  void persist();
}

export function claudePlanInstant(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? toRfc3339(value * 1000) : null;
  if (typeof value !== "string") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? toRfc3339(instant) : null;
}

function persist(): Promise<void> {
  const dir = cacheDir;
  const state = current;
  if (dir === undefined || state === undefined) return persisting;
  persisting = persisting
    .then(() => writeClaudePlanLimits(claudePlanLimitsPath(dir), state))
    .catch((e: unknown) => {
      shoreLog.warn(`shore: could not cache Claude plan limits: ${String(e)}`);
    });
  return persisting;
}

export async function writeClaudePlanLimits(path: string, state: ClaudePlanLimitsState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

export function readClaudePlanLimits(path: string): ClaudePlanLimitsState | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      shoreLog.warn(`shore: could not read the Claude plan limits cache ${path}: ${String(e)}`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const state = asClaudePlanLimitsState(parsed);
  if (state === undefined) {
    shoreLog.warn(`Claude plan limits cache failed to parse — treating as missing: ${path}`);
  }
  return state;
}

function asClaudePlanLimitsState(value: unknown): ClaudePlanLimitsState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const updated = value.updated_at;
  const polled = value.polled_at;
  const subscription = value.subscription_type;
  if (typeof updated !== "string" || !Number.isFinite(Date.parse(updated))) return undefined;
  if (polled !== null && (typeof polled !== "string" || !Number.isFinite(Date.parse(polled)))) return undefined;
  if (subscription !== null && typeof subscription !== "string") return undefined;
  const five_hour = asReading(value.five_hour);
  const seven_day = asReading(value.seven_day);
  if (five_hour === undefined || seven_day === undefined) return undefined;
  return { version: 1, updated_at: updated, polled_at: polled, subscription_type: subscription, five_hour, seven_day };
}

function asReading(value: unknown): ClaudePlanReading | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const percent = value.percent_used;
  const resets = value.resets_at;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return undefined;
  if (resets !== null && (typeof resets !== "string" || !Number.isFinite(Date.parse(resets)))) return undefined;
  return { percent_used: percent, resets_at: resets };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyFor(config: UsageConfig | undefined, window: ClaudePlanWindow): PlanLimitPolicyConfig {
  return config?.plan_limits?.[window] ?? defaultPlanLimitPolicy();
}

function liveReading(reading: ClaudePlanReading | null, now: number): ClaudePlanReading | undefined {
  if (reading === null) return undefined;
  if (reading.resets_at !== null && Date.parse(reading.resets_at) <= now) return { percent_used: 0, resets_at: null };
  return reading;
}

function planLimit(window: ClaudePlanWindow, reading: ClaudePlanReading, policy: PlanLimitPolicyConfig): ClaudePlanLimit {
  const [thresholds, crossed] = crossedThresholds(policy.warn_fractions, reading.percent_used);
  const over = reading.percent_used >= policy.limit_fraction;
  return {
    window,
    percent_used: reading.percent_used,
    resets_at: reading.resets_at,
    status: levelName(over, crossed),
    warning_thresholds: thresholds,
    crossed_warn_at: crossed,
    limit_at: policy.limit_fraction,
    action: policy.limit_action,
    over_limit: over,
  };
}

export function claudePlanLimitsReport(
  config: UsageConfig | undefined,
  now: number = Date.now(),
  state: ClaudePlanLimitsState | undefined = current,
): ClaudePlanLimitsReport | undefined {
  if (state === undefined) return undefined;
  const windows = CLAUDE_PLAN_WINDOWS.flatMap((window) => {
    const reading = liveReading(state[window], now);
    return reading === undefined ? [] : [planLimit(window, reading, policyFor(config, window))];
  });
  if (windows.length === 0) return undefined;
  return { updated_at: state.updated_at, subscription_type: state.subscription_type, windows };
}

export function runsOnClaudePlan(request: Pick<SidecarRequest, "sdk">): boolean {
  return request.sdk === "claude_agent";
}

export function claudePlanBlockFor(request: SidecarRequest, now: number = Date.now()): CallBlock | undefined {
  const context = request.context;
  if (!runsOnClaudePlan(request) || context === undefined) return undefined;
  const report = claudePlanLimitsReport(context.usage, now);
  const limit = report?.windows.find((item) => item.over_limit && actionBlocks(item.action, context.call_type));
  return limit === undefined ? undefined : planBlock(limit, zoneFor(context.usage?.timezone ?? "local"));
}

function planBlock(limit: ClaudePlanLimit, zone: string): CallBlock {
  const name = WINDOW_NAMES[limit.window];
  const standing = `is at ${percentOf(limit.percent_used)}% (limit ${percentOf(limit.limit_at)}%, ${ACTION_PHRASES[limit.action]})`;
  const resets = limit.resets_at;
  return {
    budget_name: name,
    scope: "plan",
    ...(resets === null ? {} : { reset_at: resets }),
    message: `Shore plan limit "${name}" ${standing}${resets === null ? "" : `; resets at ${resets}`}`,
    summary: `${name} ${standing}${resets === null ? "" : `; resets ${formatLocalAmPm(resets, zone)}`}`,
  };
}

export function newlyCrossedPlanLimitWarnings(
  db: Database,
  config: UsageConfig | undefined,
  now: number,
  opts: BudgetOptions = {},
): PlanLimitWarningEvent[] {
  const report = claudePlanLimitsReport(config, now);
  if (report === undefined) return [];
  const zone = zoneFor("local", opts.localZone);
  const events: PlanLimitWarningEvent[] = [];
  for (const limit of report.windows) {
    const resets = limit.resets_at;
    if (resets === null) continue;
    const name = WINDOW_NAMES[limit.window];
    const window = windowKey(resets);
    const reached = limit.over_limit ? [...limit.crossed_warn_at, limit.limit_at] : limit.crossed_warn_at;
    const fresh = reached.filter((threshold) => recordBudgetWarningThreshold(db, name, "plan", window, threshold, now));
    if (fresh.length === 0) continue;
    const display = formatLocalAmPm(resets, zone);
    const standing = limit.over_limit
      ? ` (limit ${percentOf(limit.limit_at)}%, ${ACTION_PHRASES[limit.action]})`
      : "";
    events.push({
      window: limit.window,
      limit: name,
      message: `${name} is at ${percentOf(limit.percent_used)}%${standing}; resets at ${display}.`,
      percent_used: limit.percent_used,
      crossed_warn_at: fresh,
      limit_at: limit.limit_at,
      over_limit: limit.over_limit,
      resets_at: resets,
      resets_at_display: display,
    });
  }
  return events;
}

function windowKey(resetsAt: string): string {
  return toRfc3339(Math.round(Date.parse(resetsAt) / MINUTE_MS) * MINUTE_MS);
}

function percentOf(fraction: number): number {
  return Math.round(fraction * 100);
}
