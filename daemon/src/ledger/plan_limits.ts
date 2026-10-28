import { shoreLog } from "../log.ts";

import type { Database } from "bun:sqlite";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { defaultPlanLimitPolicy, type PlanLimitPolicyConfig } from "../config/app.ts";
import {
  assessClaudeAccount,
  claudeLoginCommand,
  decideClaudeAccount,
  DEFAULT_CLAUDE_ACCOUNT,
  discoverClaudeAccounts,
  rankClaudeAccounts,
  type ClaudeAccount,
  type ClaudeAccountStanding,
  type ClaudeLogin,
} from "../llm/claude_accounts.ts";
import { claudeCodeExecutable } from "../llm/providers/claude_code.ts";
import type { SidecarRequest } from "../llm/types.ts";
import type { ClaudeAccountReport } from "../protocol/ClaudeAccountReport.ts";
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
import { required } from "../util/required.ts";

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

export type ClaudePlanCheck =
  | { status: "ok"; poll: ClaudePlanPoll; email?: string }
  | { status: "unavailable"; email?: string }
  | { status: "logged_out" };

type ClaudePlanFetcher = (account: ClaudeAccount) => Promise<ClaudePlanCheck>;

export interface ClaudePlanLimitsOptions {
  cacheDir?: string;
  fetch?: ClaudePlanFetcher;
  home?: string;
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

const CHECKS_AT_ONCE = 2;

const RESCAN_MS = 30_000;

interface AccountPlan {
  account: ClaudeAccount;
  state: ClaudePlanLimitsState | undefined;
  login: ClaudeLogin;
  email: string | undefined;
  attemptedAt: number;
  refreshing: Promise<void> | undefined;
  observed: Record<ClaudePlanWindow, number>;
  persisting: Promise<void>;
}

let cacheDir: string | undefined;
let fetcher: ClaudePlanFetcher | undefined;
let plans: AccountPlan[] = [freshPlan({ name: DEFAULT_CLAUDE_ACCOUNT })];
let switching = false;
let inUse = DEFAULT_CLAUDE_ACCOUNT;
let home: string | undefined;
let scannedAt = Number.NEGATIVE_INFINITY;

function freshPlan(account: ClaudeAccount, state?: ClaudePlanLimitsState): AccountPlan {
  return {
    account,
    state,
    login: "unchecked",
    email: undefined,
    attemptedAt: Number.NEGATIVE_INFINITY,
    refreshing: undefined,
    observed: { five_hour: 0, seven_day: 0 },
    persisting: Promise.resolve(),
  };
}

export function claudePlanLimitsPath(dir: string, account: string = DEFAULT_CLAUDE_ACCOUNT): string {
  return account === DEFAULT_CLAUDE_ACCOUNT
    ? join(dir, "providers", "claude_agent", "plan_limits.json")
    : join(dir, "providers", "claude_agent", "accounts", encodeURIComponent(account), "plan_limits.json");
}

export function claudeAccountInUsePath(dir: string): string {
  return join(dir, "providers", "claude_agent", "account_in_use");
}

export function configureClaudePlanLimits(options: ClaudePlanLimitsOptions = {}): void {
  cacheDir = options.cacheDir;
  fetcher = options.fetch;
  home = options.home;
  plans = [];
  scanClaudeAccounts(Date.now());
  const remembered = cacheDir === undefined ? undefined : readAccountInUse(claudeAccountInUsePath(cacheDir));
  inUse = plans.find((plan) => plan.account.name === remembered)?.account.name ?? required(plans[0]).account.name;
}

function scanClaudeAccounts(now: number): void {
  scannedAt = now;
  const known = new Map(plans.flatMap((plan) => (plan.account.configDir === undefined ? [] : [[plan.account.configDir, plan.account.name] as const])));
  const accounts = discoverClaudeAccounts(home, known);
  switching = accounts.some((account) => account.configDir !== undefined);
  const dir = cacheDir;
  plans = accounts.map((account) =>
    plans.find((plan) => plan.account.name === account.name && plan.account.configDir === account.configDir) ??
      freshPlan(account, dir === undefined ? undefined : readClaudePlanLimits(claudePlanLimitsPath(dir, account.name))));
  if (planOf(inUse) === undefined) inUse = required(plans[0]).account.name;
}

export function rescanClaudeAccounts(now: number = Date.now()): void {
  if (now - scannedAt >= RESCAN_MS) scanClaudeAccounts(now);
}

function readAccountInUse(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") shoreLog.warn(`shore: could not read ${path}: ${String(e)}`);
    return undefined;
  }
}

function planOf(account: string | undefined): AccountPlan | undefined {
  return plans.find((plan) => plan.account.name === (account ?? inUse));
}

export function claudeAccounts(): ClaudeAccount[] {
  return plans.map((plan) => plan.account);
}

export function claudeConfigDirs(): string[] {
  const own = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? homedir(), ".claude");
  return [...new Set([own, ...plans.flatMap((plan) => (plan.account.configDir === undefined ? [] : [plan.account.configDir]))])];
}

export function claudeAccountInUse(): ClaudeAccount {
  return required(planOf(inUse)).account;
}

export function claudeAccountNamed(name: string | undefined): ClaudeAccount | undefined {
  return name === undefined ? undefined : planOf(name)?.account;
}

export function claudePlanLimitsState(account?: string): ClaudePlanLimitsState | undefined {
  return planOf(account)?.state;
}

export function claudePlanLimitsKnown(): boolean {
  return switching || planOf(inUse)?.state !== undefined;
}

function standingOf(plan: AccountPlan): ClaudeAccountStanding {
  return {
    account: plan.account,
    login: plan.login,
    five_hour: plan.state?.five_hour ?? null,
    seven_day: plan.state?.seven_day ?? null,
  };
}

export function claudeAccountOrder(now: number = Date.now()): ClaudeAccount[] {
  rescanClaudeAccounts(now);
  if (plans.length === 1) return [required(plans[0]).account];
  const assessments = plans.map((plan) => assessClaudeAccount(standingOf(plan), now));
  const decision = decideClaudeAccount(assessments, inUse, now);
  if (decision.to !== undefined) useClaudeAccount(decision.to.name, decision.reason);
  const rest = rankClaudeAccounts(assessments, inUse)
    .filter((a) => a.account.name !== inUse && (a.state === "ok" || a.state === "unknown"))
    .map((a) => a.account);
  return [claudeAccountInUse(), ...rest];
}

export function nextClaudeAccount(refused: ReadonlySet<string>, now: number = Date.now()): ClaudeAccount | undefined {
  return claudeAccountOrder(now).find((account) => !refused.has(account.name));
}

export function claudeAccountSignedOut(name: string): void {
  const plan = planOf(name);
  if (plan !== undefined) plan.login = "logged_out";
}

export function claudeAccountsFreeAt(now: number = Date.now()): string | undefined {
  const assessments = plans.map((plan) => assessClaudeAccount(standingOf(plan), now));
  if (assessments.some((a) => a.state === "ok" || a.state === "unknown")) return undefined;
  const free = assessments.flatMap((a) => (a.state === "limited" && a.availableAt !== null ? [a.availableAt] : []));
  return free.length === 0 ? undefined : toRfc3339(Math.min(...free));
}

export function useClaudeAccount(name: string, reason: string): void {
  if (name === inUse || planOf(name) === undefined) return;
  shoreLog.info(`shore: Claude account ${inUse} → ${name}: ${reason}`);
  inUse = name;
  const dir = cacheDir;
  if (dir === undefined) return;
  const path = claudeAccountInUsePath(dir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${name}\n`);
    renameSync(`${path}.tmp`, path);
  } catch (e) {
    shoreLog.warn(`shore: could not remember the Claude account in use: ${String(e)}`);
  }
}

export async function refreshClaudePlanLimits(maxAgeMs: number, now: number = Date.now()): Promise<void> {
  const fetch = fetcher;
  if (fetch === undefined) return;
  rescanClaudeAccounts(now);
  const due = plans.filter((plan) => plan.refreshing !== undefined || now - lastAttempt(plan) >= maxAgeMs);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const plan = required(due[next++]);
      plan.refreshing ??= pollClaudePlanLimits(plan, fetch, now).finally(() => {
        plan.refreshing = undefined;
      });
      await plan.refreshing;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, due.length) }, worker));
}

function lastAttempt(plan: AccountPlan): number {
  const polled = plan.state?.polled_at;
  const at = polled === undefined || polled === null ? Number.NaN : Date.parse(polled);
  return Number.isFinite(at) ? Math.max(plan.attemptedAt, at) : plan.attemptedAt;
}

async function pollClaudePlanLimits(plan: AccountPlan, fetch: ClaudePlanFetcher, now: number): Promise<void> {
  plan.attemptedAt = now;
  const seen = { ...plan.observed };
  let check: ClaudePlanCheck;
  try {
    check = await fetch(plan.account);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    plan.login = { error: message };
    shoreLog.warn(`shore: could not read Claude plan limits${switching ? ` for ${plan.account.name}` : ""}: ${message}`);
    return;
  }
  plan.login = check.status;
  if (check.status !== "logged_out") plan.email = check.email;
  if (check.status !== "ok") return;
  const poll = check.poll;
  const stamp = toRfc3339(now);
  const prior = plan.state;
  const newer = (window: ClaudePlanWindow): ClaudePlanReading | null =>
    plan.observed[window] === seen[window] ? poll[window] : prior?.[window] ?? null;
  plan.state = {
    version: 1,
    updated_at: stamp,
    polled_at: stamp,
    subscription_type: poll.subscription_type,
    five_hour: newer("five_hour"),
    seven_day: newer("seven_day"),
  };
  await persist(plan);
}

export function observeClaudeRateLimit(info: SDKRateLimitInfo, account?: string, now: number = Date.now()): void {
  const window = CLAUDE_PLAN_WINDOWS.find((name) => name === info.rateLimitType);
  if (window === undefined) return;
  const plan = planOf(account);
  if (plan === undefined) return;
  const reported = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? info.utilization : undefined;
  const percent = info.status === "rejected" ? Math.max(1, reported ?? 1) : reported;
  if (percent === undefined || percent < 0) return;
  const prior = plan.state;
  const resets_at = info.resetsAt === undefined ? prior?.[window]?.resets_at ?? null : claudePlanInstant(info.resetsAt);
  const reading = { percent_used: percent, resets_at };
  plan.observed[window] += 1;
  plan.login = "ok";
  plan.state = {
    version: 1,
    updated_at: toRfc3339(now),
    polled_at: prior?.polled_at ?? null,
    subscription_type: prior?.subscription_type ?? null,
    five_hour: window === "five_hour" ? reading : prior?.five_hour ?? null,
    seven_day: window === "seven_day" ? reading : prior?.seven_day ?? null,
  };
  void persist(plan);
}

export function claudePlanInstant(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? toRfc3339(value * 1000) : null;
  if (typeof value !== "string") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? toRfc3339(instant) : null;
}

function persist(plan: AccountPlan): Promise<void> {
  const dir = cacheDir;
  const state = plan.state;
  if (dir === undefined || state === undefined) return plan.persisting;
  plan.persisting = plan.persisting
    .then(() => writeClaudePlanLimits(claudePlanLimitsPath(dir, plan.account.name), state))
    .catch((e: unknown) => {
      shoreLog.warn(`shore: could not cache Claude plan limits: ${String(e)}`);
    });
  return plan.persisting;
}

async function writeClaudePlanLimits(path: string, state: ClaudePlanLimitsState): Promise<void> {
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
  account?: string,
): ClaudePlanLimitsReport | undefined {
  const plan = planOf(claudeAccountNamed(account)?.name);
  if (plan === undefined) return undefined;
  const state = plan.state;
  const windows = state === undefined ? [] : CLAUDE_PLAN_WINDOWS.flatMap((window) => {
    const reading = liveReading(state[window], now);
    return reading === undefined ? [] : [planLimit(window, reading, policyFor(config, window))];
  });
  if (!switching) {
    if (state === undefined || windows.length === 0) return undefined;
    return { updated_at: state.updated_at, subscription_type: state.subscription_type, windows, accounts: [] };
  }
  const updated = plans.flatMap((other) => (other.state === undefined ? [] : [other.state.updated_at])).sort().at(-1);
  return {
    updated_at: state?.updated_at ?? updated ?? toRfc3339(now),
    subscription_type: state?.subscription_type ?? null,
    windows,
    account: plan.account.name,
    accounts: plans.map((other) => accountReport(other, now)),
  };
}

function accountReport(plan: AccountPlan, now: number): ClaudeAccountReport {
  const assessment = assessClaudeAccount(standingOf(plan), now);
  return {
    name: plan.account.name,
    in_use: plan.account.name === inUse,
    state: assessment.state,
    detail: assessment.reason,
    email: plan.email ?? plan.account.email ?? null,
    subscription_type: plan.state?.subscription_type ?? null,
    windows: CLAUDE_PLAN_WINDOWS.flatMap((window) => {
      const reading = liveReading(plan.state?.[window] ?? null, now);
      return reading === undefined ? [] : [{ window, percent_used: reading.percent_used, resets_at: reading.resets_at }];
    }),
    ...(plan.login === "logged_out" ? { login_command: claudeLoginCommand(plan.account, daemonUser(), claudeBinary()) } : {}),
  };
}

function daemonUser(): string {
  const name = process.env.USER ?? process.env.LOGNAME ?? userInfo().username;
  return name === "" || name === "unknown" ? `'#${String(process.getuid?.() ?? 0)}'` : name;
}

function claudeBinary(): string {
  try {
    return claudeCodeExecutable() ?? "claude";
  } catch {
    return "claude";
  }
}

export function runsOnClaudePlan(request: Pick<SidecarRequest, "sdk">): boolean {
  return request.sdk === "claude_agent";
}

export function claudePlanBlockFor(request: SidecarRequest, now: number = Date.now()): CallBlock | undefined {
  const context = request.context;
  if (!runsOnClaudePlan(request) || context === undefined) return undefined;
  const report = claudePlanLimitsReport(context.usage, now, context.api_key_name);
  const limit = report?.windows.find((item) => item.over_limit && actionBlocks(item.action, context));
  return limit === undefined ? undefined : planBlock(limit, zoneFor(context.usage?.timezone ?? "local"), report?.account);
}

function limitName(window: ClaudePlanWindow, account: string | undefined): string {
  return account === undefined ? WINDOW_NAMES[window] : `${WINDOW_NAMES[window]} (${account})`;
}

function planBlock(limit: ClaudePlanLimit, zone: string, account: string | undefined): CallBlock {
  const name = limitName(limit.window, account);
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
    const name = limitName(limit.window, report.account);
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
