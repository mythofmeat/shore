import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudePlanReading } from "../ledger/plan_limits.ts";
import { shoreLog } from "../log.ts";

export const DEFAULT_CLAUDE_ACCOUNT = "subscription";

export const SESSION_CUTOFF = 0.95;

export const WEEKLY_CUTOFF = 0.98;

export interface ClaudeAccount {
  name: string;
  configDir?: string;
  email?: string;
}

export function claudeAccountsRoot(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".claude-accounts");
}

function signedInEmail(configDir: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: unknown } };
    const email = config.oauthAccount?.emailAddress;
    return typeof email === "string" && email !== "" ? email : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function discoverClaudeAccounts(home?: string, known: ReadonlyMap<string, string> = new Map()): ClaudeAccount[] {
  const root = claudeAccountsRoot(home);
  let folders: string[];
  try {
    folders = readdirSync(root).filter((folder) => !folder.startsWith(".")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") shoreLog.warn(`shore: could not list Claude accounts in ${root}: ${String(e)}`);
    folders = [];
  }
  const found = new Map<string, ClaudeAccount>();
  for (const folder of folders) {
    const configDir = join(root, folder);
    if (!isDirectory(configDir)) continue;
    const email = signedInEmail(configDir);
    const name = email ?? known.get(configDir) ?? folder;
    const twin = found.get(name);
    if (twin !== undefined) {
      shoreLog.warn(`shore: ${configDir} and ${String(twin.configDir)} are both signed in as ${name}; using the first`);
      continue;
    }
    found.set(name, { name, configDir, ...(email === undefined ? {} : { email }) });
  }
  return found.size === 0 ? [{ name: DEFAULT_CLAUDE_ACCOUNT }] : [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function claudeLoginCommand(account: ClaudeAccount, user: string, claude = "claude"): string {
  const dir = account.configDir === undefined ? "" : `env CLAUDE_CONFIG_DIR=${account.configDir} `;
  return `sudo -u ${user} ${dir}${claude} auth login`;
}

export type ClaudeLogin = "ok" | "logged_out" | "unavailable" | "unchecked" | { error: string };

export interface ClaudeAccountStanding {
  account: ClaudeAccount;
  login: ClaudeLogin;
  five_hour: ClaudePlanReading | null;
  seven_day: ClaudePlanReading | null;
}

interface Limit {
  window: "five_hour" | "seven_day";
  reading: ClaudePlanReading;
  cutoff: number;
}

export type Assessment =
  | { account: ClaudeAccount; state: "ok"; weekResets: number | null; room: number; reason: string }
  | { account: ClaudeAccount; state: "limited"; reason: string; availableAt: number | null }
  | { account: ClaudeAccount; state: "out"; reason: string }
  | { account: ClaudeAccount; state: "unknown"; reason: string };

const WINDOW_LABELS = { five_hour: "session", seven_day: "weekly" } as const;

function used(reading: ClaudePlanReading, now: number): number {
  if (reading.resets_at !== null && Date.parse(reading.resets_at) <= now) return 0;
  return Math.min(Math.max(reading.percent_used, 0), 1);
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

function resetTime(reading: ClaudePlanReading): number | null {
  if (reading.resets_at === null) return null;
  const at = Date.parse(reading.resets_at);
  return Number.isFinite(at) ? at : null;
}

export function assessClaudeAccount(standing: ClaudeAccountStanding, now: number): Assessment {
  const { account, login } = standing;
  if (login === "logged_out") return { account, state: "out", reason: "not logged in" };
  if (login === "unavailable") return { account, state: "out", reason: "its login has no Claude plan limits" };
  const limits: Limit[] = [];
  if (standing.five_hour !== null) limits.push({ window: "five_hour", reading: standing.five_hour, cutoff: SESSION_CUTOFF });
  if (standing.seven_day !== null) limits.push({ window: "seven_day", reading: standing.seven_day, cutoff: WEEKLY_CUTOFF });
  if (limits.length === 0) {
    return { account, state: "unknown", reason: typeof login === "object" ? `couldn't check: ${login.error}` : "not checked yet" };
  }
  const over = limits.filter((limit) => used(limit.reading, now) >= limit.cutoff);
  if (over.length > 0) {
    const resets = over.map((limit) => resetTime(limit.reading));
    return {
      account,
      state: "limited",
      reason: over.map((limit) => `${WINDOW_LABELS[limit.window]} ${percent(used(limit.reading, now))} ≥ ${percent(limit.cutoff)}`).join(", "),
      availableAt: resets.every((at) => at !== null) ? Math.max(...resets) : null,
    };
  }
  const week = standing.seven_day === null ? null : resetTime(standing.seven_day);
  return {
    account,
    state: "ok",
    weekResets: week !== null && week > now ? week : null,
    room: Math.min(...limits.map((limit) => limit.cutoff - used(limit.reading, now))),
    reason: limits.map((limit) => `${WINDOW_LABELS[limit.window]} ${percent(used(limit.reading, now))}`).join(" · "),
  };
}

const STATE_ORDER = { ok: 0, limited: 1, unknown: 2, out: 3 } as const;

function minute(at: number | null): number {
  return at === null ? Infinity : Math.floor(at / 60_000);
}

export function rankClaudeAccounts(assessments: readonly Assessment[], current: string | undefined): Assessment[] {
  const isCurrent = (a: Assessment): number => Number(a.account.name === current);
  const freeAt = (a: Assessment): number => (a.state === "limited" ? minute(a.availableAt) : Infinity);
  return assessments
    .map((a, i) => ({ a, i }))
    .sort(({ a, i }, { a: b, i: j }) => {
      const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (byState !== 0) return byState;
      if (a.state === "ok" && b.state === "ok") {
        const ra = minute(a.weekResets);
        const rb = minute(b.weekResets);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return isCurrent(b) - isCurrent(a) || b.room - a.room || i - j;
      }
      const fa = freeAt(a);
      const fb = freeAt(b);
      return fa === fb ? i - j : fa < fb ? -1 : 1;
    })
    .map(({ a }) => a);
}

export interface AccountDecision {
  to?: ClaudeAccount;
  reason: string;
}

function inWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(rest)}m`;
  return `${String(rest)}m`;
}

export function decideClaudeAccount(assessments: readonly Assessment[], current: string | undefined, now: number): AccountDecision {
  const ranked = rankClaudeAccounts(assessments, current);
  const best = ranked[0]?.state === "ok" ? ranked[0] : undefined;
  const cur = assessments.find((a) => a.account.name === current);
  if (cur?.state === "unknown") return { reason: `"${String(current)}" ${cur.reason}` };
  if (cur?.state === "ok") return { reason: `"${String(current)}" still has room (${cur.reason})` };
  if (best?.state !== "ok") {
    const next = ranked.find((a) => a.state === "limited" && a.availableAt !== null);
    if (next?.state !== "limited" || next.availableAt === null) return { reason: "no Claude account can be used right now" };
    return { reason: `every Claude account is at a limit; "${next.account.name}" frees up first, in ${inWords(next.availableAt - now)}` };
  }
  const leaving =
    cur?.state === "limited"
      ? `"${String(current)}" is at a limit (${cur.reason})`
      : cur?.state === "out"
        ? `"${String(current)}" can't be used: ${cur.reason}`
        : "no Claude account was in use";
  const why = best.weekResets === null
    ? "no account with room has started its week yet"
    : `its week resets soonest, in ${inWords(best.weekResets - now)}`;
  return { to: best.account, reason: `${leaving}; "${best.account.name}" is next: ${why}` };
}
