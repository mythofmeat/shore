import { shoreLog } from "../log.ts";

import type { Database } from "bun:sqlite";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultPlanLimitPolicy, type PlanLimitPolicyConfig } from "../config/app.ts";
import {
  assessClaudeAccount,
  claudeAccountsRoot,
  claudeLoginCommand,
  claudeUsageWindows,
  decideClaudeAccount,
  DEFAULT_CLAUDE_ACCOUNT,
  discoverClaudeAccounts,
  rankClaudeAccounts,
  type Assessment,
  type ClaudeAccount,
  type ClaudeAccountStanding,
  type ClaudeLogin,
  type ClaudeLoginEntry,
  type ClaudeLoginSetting,
  type ClaudeLoginSettings,
} from "../llm/claude_accounts.ts";
import { usedFraction, type Standing } from "../llm/credential_room.ts";
import type { SignInFlow } from "../llm/claude_sign_in.ts";
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

const NO_SETTINGS: ClaudeLoginSettings = { provider: "claude_agent", logins: [] };

export interface ClaudePlanLimitsOptions {
  cacheDir?: string;
  fetch?: ClaudePlanFetcher;
  home?: string;
  settings?: () => ClaudeLoginSettings;
  signIn?: (configDir: string | undefined) => Promise<SignInFlow>;
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
let settingsOf: () => ClaudeLoginSettings = () => NO_SETTINGS;
let scannedEntries = "";
let signInStarter: ClaudePlanLimitsOptions["signIn"];
const holds = new Map<string, number>();

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
  settingsOf = options.settings ?? (() => NO_SETTINGS);
  signInStarter = options.signIn;
  plans = [];
  holds.clear();
  scanClaudeAccounts(Date.now());
  const remembered = cacheDir === undefined ? undefined : readAccountInUse(claudeAccountInUsePath(cacheDir));
  inUse = plans.find((plan) => plan.account.name === remembered)?.account.name ?? required(plans[0]).account.name;
}

export function claudeLoginsRoot(): string {
  return claudeAccountsRoot(home);
}

export function claudeLoginSettings(): ClaudeLoginSettings {
  return settingsOf();
}

export function startClaudeLoginFlow(configDir: string | undefined): Promise<SignInFlow> {
  return signInStarter === undefined ? Promise.reject(new Error("this daemon can't sign Claude logins in")) : signInStarter(configDir);
}

function entriesKey(entries: readonly ClaudeLoginEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.name, entry.dir ?? null]));
}

function scanClaudeAccounts(now: number): void {
  scannedAt = now;
  const entries = settingsOf().logins;
  scannedEntries = entriesKey(entries);
  const known = new Map(plans.flatMap((plan) => (plan.account.configDir === undefined ? [] : [[plan.account.configDir, plan.account.name] as const])));
  const accounts = discoverClaudeAccounts(home, known, entries);
  switching = accounts.some((account) => account.configDir !== undefined);
  const dir = cacheDir;
  plans = accounts.map((account) => {
    const kept = plans.find((plan) => plan.account.name === account.name && plan.account.configDir === account.configDir);
    if (kept === undefined) return freshPlan(account, dir === undefined || account.missing === true ? undefined : readClaudePlanLimits(claudePlanLimitsPath(dir, account.name)));
    kept.account = account;
    return kept;
  });
  if (planOf(inUse) === undefined) inUse = required(plans[0]).account.name;
}

export function rescanClaudeAccounts(now: number = Date.now(), force = false): void {
  if (force || now - scannedAt >= RESCAN_MS || entriesKey(settingsOf().logins) !== scannedEntries) scanClaudeAccounts(now);
}

function holdKey(account: Pick<ClaudeAccount, "configDir">): string {
  return account.configDir ?? "";
}

export function holdClaudeAccount(account: Pick<ClaudeAccount, "configDir">): () => void {
  const key = holdKey(account);
  holds.set(key, (holds.get(key) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holds.get(key) ?? 1) - 1;
    if (left <= 0) holds.delete(key);
    else holds.set(key, left);
  };
}

export function claudeAccountBusy(account: Pick<ClaudeAccount, "configDir">): boolean {
  return (holds.get(holdKey(account)) ?? 0) > 0;
}

export function renameClaudeAccount(from: string, to: string): void {
  const plan = planOf(from);
  if (plan === undefined || from === to) return;
  plan.account = { ...plan.account, name: to };
  if (inUse === from) useClaudeAccount(to, `"${from}" was renamed`);
  void persist(plan);
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
  return [...new Set([own, ...plans.flatMap((plan) => (plan.account.configDir === undefined || plan.account.missing === true ? [] : [plan.account.configDir]))])];
}

export function claudeAccountInUse(): ClaudeAccount {
  const plan = planOf(inUse);
  if (plan !== undefined && plan.account.missing !== true) return plan.account;
  return (plans.find((other) => other.account.missing !== true) ?? required(plans[0])).account;
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

function settingOf(settings: ClaudeLoginSettings, name: string): ClaudeLoginSetting | undefined {
  return settings.logins.find((login) => login.name === name);
}

function unusable(plan: AccountPlan, settings: ClaudeLoginSettings): string | undefined {
  if (plan.account.missing === true) return "not signed in yet";
  if (settingOf(settings, plan.account.name)?.enabled === false) return "disabled";
  return undefined;
}

function assessAll(settings: ClaudeLoginSettings, now: number): Assessment[] {
  return plans.map((plan) => {
    const reason = unusable(plan, settings);
    if (reason !== undefined) return { account: plan.account, name: plan.account.name, standing: { state: "out", reason } };
    return assessClaudeAccount(standingOf(plan), now, settingOf(settings, plan.account.name)?.limits);
  });
}

export function claudeAccountOrder(now: number = Date.now()): ClaudeAccount[] {
  rescanClaudeAccounts(now);
  const settings = settingsOf();
  if (settings.pin !== undefined) {
    const pinned = plans.find((plan) => plan.account.name === settings.pin);
    if (pinned === undefined || unusable(pinned, settings) !== undefined) return [];
    useClaudeAccount(pinned.account.name, `pinned to "${pinned.account.name}"`);
    return [pinned.account];
  }
  const only = plans.length === 1 ? required(plans[0]) : undefined;
  if (only !== undefined) return unusable(only, settings) === undefined ? [only.account] : [];
  const assessments = assessAll(settings, now);
  const decision = decideClaudeAccount(assessments, inUse, now);
  if (decision.to !== undefined) useClaudeAccount(decision.to.name, decision.reason);
  const current = plans.find((plan) => plan.account.name === inUse);
  const rest = rankClaudeAccounts(assessments, inUse)
    .filter((a) => a.name !== inUse && (a.standing.state === "ok" || a.standing.state === "unknown"))
    .map((a) => a.account);
  return current === undefined || unusable(current, settings) !== undefined ? rest : [current.account, ...rest];
}

export function nextClaudeAccount(refused: ReadonlySet<string>, now: number = Date.now()): ClaudeAccount | undefined {
  return claudeAccountOrder(now).find((account) => !refused.has(account.name));
}

export function claudeAccountRemoved(name: string, now: number = Date.now()): string | undefined {
  if (inUse === name) {
    const others = assessAll(settingsOf(), now).filter((a) => a.name !== name && a.account.missing !== true);
    const best = rankClaudeAccounts(others, undefined).find((a) => a.standing.state !== "out") ?? others[0];
    if (best !== undefined) useClaudeAccount(best.name, `"${name}" was removed`);
  }
  rescanClaudeAccounts(now, true);
  return inUse === name ? undefined : inUse;
}

export function noClaudeLoginReason(): string {
  const settings = settingsOf();
  const provider = settings.provider;
  if (settings.pin !== undefined) {
    const pinned = plans.find((plan) => plan.account.name === settings.pin);
    const why = pinned === undefined ? "there's no such login" : unusable(pinned, settings) ?? "it can't be used";
    return `${provider} is pinned to the Claude login "${settings.pin}", but ${why}. Sign it in with \`shore provider ${provider} auth ${settings.pin} --login\`, or go back to choosing with \`shore provider ${provider} use --auto\``;
  }
  const reasons = assessAll(settings, Date.now()).map((a) => `"${a.name}": ${a.standing.reason}`);
  return `no Claude login can be used (${reasons.join("; ")}). Sign one in with \`shore provider ${provider} auth --add NAME\``;
}

export function claudeAccountSignedOut(name: string): void {
  const plan = planOf(name);
  if (plan !== undefined) plan.login = "logged_out";
}

export function claudeAccountsFreeAt(now: number = Date.now()): string | undefined {
  const settings = settingsOf();
  const assessments = assessAll(settings, now).filter((a) => settings.pin === undefined || a.name === settings.pin);
  if (assessments.some((a) => a.standing.state === "ok" || a.standing.state === "unknown")) return undefined;
  const free = assessments.flatMap((a) => (a.standing.state === "limited" && a.standing.availableAt !== null ? [a.standing.availableAt] : []));
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
  const due = plans.filter((plan) => plan.account.missing !== true && (plan.refreshing !== undefined || now - lastAttempt(plan) >= maxAgeMs));
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

export async function refreshClaudeAccount(name: string, now: number = Date.now()): Promise<ClaudeLogin> {
  rescanClaudeAccounts(now, true);
  const plan = planOf(name);
  const fetch = fetcher;
  if (plan === undefined) return "unchecked";
  if (plan.account.missing === true) return "logged_out";
  if (fetch === undefined) return plan.login;
  plan.refreshing ??= pollClaudePlanLimits(plan, fetch, now).finally(() => {
    plan.refreshing = undefined;
  });
  await plan.refreshing;
  return plan.login;
}

async function pollClaudePlanLimits(plan: AccountPlan, fetch: ClaudePlanFetcher, now: number): Promise<void> {
  plan.attemptedAt = now;
  const seen = { ...plan.observed };
  let check: ClaudePlanCheck;
  const release = holdClaudeAccount(plan.account);
  try {
    check = await fetch(plan.account);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    plan.login = { error: message };
    shoreLog.warn(`shore: could not read Claude plan limits${switching ? ` for ${plan.account.name}` : ""}: ${message}`);
    return;
  } finally {
    release();
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

function signedOut(plan: AccountPlan): boolean {
  return plan.login === "logged_out" || plan.account.missing === true;
}

function accountReport(plan: AccountPlan, now: number): ClaudeAccountReport {
  const settings = settingsOf();
  const reason = unusable(plan, settings);
  const assessed = reason === undefined
    ? assessClaudeAccount(standingOf(plan), now, settingOf(settings, plan.account.name)?.limits).standing
    : { state: "out" as const, reason };
  return {
    name: plan.account.name,
    in_use: plan.account.name === inUse,
    state: assessed.state,
    detail: assessed.reason,
    email: plan.email ?? plan.account.email ?? null,
    subscription_type: plan.state?.subscription_type ?? null,
    windows: CLAUDE_PLAN_WINDOWS.flatMap((window) => {
      const reading = liveReading(plan.state?.[window] ?? null, now);
      return reading === undefined ? [] : [{ window, percent_used: reading.percent_used, resets_at: reading.resets_at }];
    }),
    ...(signedOut(plan) ? { login_command: claudeLoginCommand(plan.account, settings.provider) } : {}),
  };
}

export interface ClaudeLoginWindow {
  window: ClaudePlanWindow;
  label: string;
  percent_used: number;
  resets_at: string | null;
  limit: number;
  limit_set: boolean;
  at_limit: boolean;
}

export interface ClaudeLoginReport {
  account: ClaudeAccount;
  email: string | null;
  plan: string | null;
  enabled: boolean;
  pinned: boolean;
  in_use: boolean;
  busy: boolean;
  signed_out: boolean;
  state: Standing["state"];
  detail: string;
  checked_at: string | null;
  login_command?: string;
  windows: ClaudeLoginWindow[];
}

export interface ClaudeLoginOverview {
  logins: ClaudeLoginReport[];
  reason: string;
}

export function claudeLoginOverview(now: number = Date.now()): ClaudeLoginOverview {
  rescanClaudeAccounts(now, true);
  const settings = settingsOf();
  const assessments = assessAll(settings, now);
  const pinned = settings.pin === undefined ? undefined : plans.find((plan) => plan.account.name === settings.pin);
  const reason = settings.pin === undefined
    ? decideClaudeAccount(assessments, inUse, now).reason
    : pinned === undefined || unusable(pinned, settings) !== undefined ? noClaudeLoginReason() : `pinned to "${settings.pin}"`;
  return {
    reason: plans.length === 1 && settings.pin === undefined ? `"${inUse}" is the only Claude login` : reason,
    logins: plans.map((plan) => {
      const setting = settingOf(settings, plan.account.name);
      const standing = assessClaudeAccount(standingOf(plan), now, setting?.limits).standing;
      const windows = claudeUsageWindows({ five_hour: plan.state?.five_hour ?? null, seven_day: plan.state?.seven_day ?? null }, setting?.limits);
      return {
        account: plan.account,
        email: plan.email ?? plan.account.email ?? null,
        plan: plan.state?.subscription_type ?? null,
        enabled: setting?.enabled !== false,
        pinned: settings.pin === plan.account.name,
        in_use: plan.account.name === inUse,
        busy: claudeAccountBusy(plan.account),
        signed_out: signedOut(plan),
        state: standing.state,
        detail: standing.reason,
        checked_at: plan.state?.updated_at ?? null,
        ...(signedOut(plan) ? { login_command: claudeLoginCommand(plan.account, settings.provider) } : {}),
        windows: windows.flatMap((window): ClaudeLoginWindow[] => {
          const name = CLAUDE_PLAN_WINDOWS.find((id) => id === window.window);
          if (name === undefined) return [];
          const reading = liveReading(plan.state?.[name] ?? null, now) ?? (window.own ? { percent_used: 0, resets_at: null } : undefined);
          if (reading === undefined) return [];
          return [{
            window: name, label: window.label, percent_used: reading.percent_used, resets_at: reading.resets_at,
            limit: window.cutoff, limit_set: window.own, at_limit: usedFraction(reading, now) >= window.cutoff,
          }];
        }),
      };
    }),
  };
}

export function runsOnClaudePlan(request: Pick<SidecarRequest, "sdk">): boolean {
  return request.sdk === "claude_agent";
}

export function claudePlanBlockFor(request: SidecarRequest, now: number = Date.now()): CallBlock | undefined {
  const context = request.context;
  if (!runsOnClaudePlan(request) || context === undefined) return undefined;
  const zone = zoneFor(context.usage?.timezone ?? "local");
  const own = loginLimitBlock(context.api_key_name, now, zone);
  if (own !== undefined) return own;
  const report = claudePlanLimitsReport(context.usage, now, context.api_key_name);
  const limit = report?.windows.find((item) => item.over_limit && actionBlocks(item.action, context));
  return limit === undefined ? undefined : planBlock(limit, zone, report?.account);
}

function loginLimitBlock(account: string | undefined, now: number, zone: string): CallBlock | undefined {
  const plan = planOf(account);
  if (plan === undefined) return undefined;
  const limits = settingOf(settingsOf(), plan.account.name)?.limits;
  if (limits === undefined) return undefined;
  const name = plan.account.name;
  for (const window of claudeUsageWindows({ five_hour: plan.state?.five_hour ?? null, seven_day: plan.state?.seven_day ?? null }, limits)) {
    if (!window.own || window.reading === null) continue;
    const used = usedFraction(window.reading, now);
    if (used < window.cutoff) continue;
    const resets = window.reading.resets_at;
    const standing = `has used ${percentOf(used)}% of its ${window.label} window, and its limit is ${percentOf(window.cutoff)}%`;
    return {
      budget_name: `${name} ${window.label} limit`,
      scope: "plan",
      login_limit: true,
      api_key: name,
      ...(resets === null ? {} : { reset_at: resets }),
      message: `Claude login "${name}" ${standing}${resets === null ? "" : `; it resets at ${resets}`}`,
      summary: `Claude login ${name} ${standing}${resets === null ? "" : `; resets ${formatLocalAmPm(resets, zone)}`}`,
    };
  }
  return undefined;
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
