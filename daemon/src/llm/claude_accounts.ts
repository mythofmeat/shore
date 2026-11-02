import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudePlanReading } from "../ledger/plan_limits.ts";
import { shoreLog } from "../log.ts";
import { rankByRoom, roomLeft, type Standing, type UsageWindow } from "./credential_room.ts";

export const DEFAULT_CLAUDE_ACCOUNT = "subscription";

export const SESSION_CUTOFF = 0.95;

export const WEEKLY_CUTOFF = 0.98;

export interface ClaudeAccount {
  name: string;
  configDir?: string;
  email?: string;
  folder?: string;
  missing?: boolean;
}

export interface ClaudeLoginEntry {
  name: string;
  dir?: string;
}

export interface ClaudeLoginLimits {
  session?: number;
  weekly?: number;
}

export interface ClaudeLoginSetting extends ClaudeLoginEntry {
  enabled: boolean;
  limits: ClaudeLoginLimits;
}

export interface ClaudeLoginSettings {
  provider: string;
  pin?: string;
  logins: readonly ClaudeLoginSetting[];
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

function byName(a: ClaudeAccount, b: ClaudeAccount): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function loginFolderOf(entry: ClaudeLoginEntry): string | undefined {
  return entry.dir ?? (entry.name === DEFAULT_CLAUDE_ACCOUNT ? undefined : entry.name);
}

export function discoverClaudeAccounts(
  home?: string,
  known: ReadonlyMap<string, string> = new Map(),
  entries: readonly ClaudeLoginEntry[] = [],
): ClaudeAccount[] {
  const root = claudeAccountsRoot(home);
  let folders: string[];
  try {
    folders = readdirSync(root).filter((folder) => !folder.startsWith(".")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") shoreLog.warn(`shore: could not list Claude accounts in ${root}: ${String(e)}`);
    folders = [];
  }
  const bound = new Map(entries.flatMap((entry) => {
    const folder = loginFolderOf(entry);
    return folder === undefined ? [] : [[folder, entry.name] as const];
  }));
  const found = new Map<string, ClaudeAccount>();
  for (const folder of folders) {
    const configDir = join(root, folder);
    if (!isDirectory(configDir)) continue;
    const email = signedInEmail(configDir);
    const name = bound.get(folder) ?? email ?? known.get(configDir) ?? folder;
    const twin = found.get(name);
    if (twin !== undefined) {
      shoreLog.warn(`shore: ${configDir} and ${String(twin.configDir)} are both signed in as ${name}; using the first`);
      continue;
    }
    found.set(name, { name, configDir, folder, ...(email === undefined ? {} : { email }) });
  }
  const signedIn = found.size;
  for (const entry of entries) {
    const folder = loginFolderOf(entry);
    if (folder === undefined || found.has(entry.name) || [...found.values()].some((account) => account.folder === folder)) continue;
    found.set(entry.name, { name: entry.name, configDir: join(root, folder), folder, missing: true });
  }
  const accounts = [...found.values()];
  if (signedIn === 0) accounts.push({ name: DEFAULT_CLAUDE_ACCOUNT });
  return accounts.sort(byName);
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_.@+%=:,/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function claudeLoginCommand(account: ClaudeAccount, provider = "claude_agent"): string {
  return `shore provider ${provider} auth ${shellWord(account.name)} --login`;
}

export type ClaudeLogin = "ok" | "logged_out" | "unavailable" | "unchecked" | { error: string };

export interface ClaudeAccountStanding {
  account: ClaudeAccount;
  login: ClaudeLogin;
  five_hour: ClaudePlanReading | null;
  seven_day: ClaudePlanReading | null;
}

export interface Assessment {
  account: ClaudeAccount;
  name: string;
  standing: Standing;
}

export function claudeUsageWindows(standing: Pick<ClaudeAccountStanding, "five_hour" | "seven_day">, limits: ClaudeLoginLimits = {}): UsageWindow[] {
  return [
    { window: "five_hour", label: "session", reading: standing.five_hour, cutoff: limits.session ?? SESSION_CUTOFF, own: limits.session !== undefined, longest: false },
    { window: "seven_day", label: "weekly", reading: standing.seven_day, cutoff: limits.weekly ?? WEEKLY_CUTOFF, own: limits.weekly !== undefined, longest: true },
  ];
}

export function assessClaudeAccount(standing: ClaudeAccountStanding, now: number, limits: ClaudeLoginLimits = {}): Assessment {
  const { account, login } = standing;
  const assessed = (result: Standing): Assessment => ({ account, name: account.name, standing: result });
  if (account.missing === true) return assessed({ state: "out", reason: "not signed in yet" });
  if (login === "logged_out") return assessed({ state: "out", reason: "not logged in" });
  if (login === "unavailable") return assessed({ state: "out", reason: "its login has no Claude plan limits" });
  return assessed(roomLeft(claudeUsageWindows(standing, limits), now, typeof login === "object" ? `couldn't check: ${login.error}` : "not checked yet"));
}

export function rankClaudeAccounts(assessments: readonly Assessment[], current: string | undefined): Assessment[] {
  return rankByRoom(assessments, current);
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
  const best = ranked[0]?.standing.state === "ok" ? ranked[0] : undefined;
  const cur = assessments.find((a) => a.name === current)?.standing;
  if (cur?.state === "unknown") return { reason: `"${String(current)}" ${cur.reason}` };
  if (cur?.state === "ok") return { reason: `"${String(current)}" still has room (${cur.reason})` };
  if (best?.standing.state !== "ok") {
    const next = ranked.find((a) => a.standing.state === "limited" && a.standing.availableAt !== null);
    if (next?.standing.state !== "limited" || next.standing.availableAt === null) return { reason: "no Claude account can be used right now" };
    return { reason: `every Claude account is at a limit; "${next.name}" frees up first, in ${inWords(next.standing.availableAt - now)}` };
  }
  const leaving =
    cur?.state === "limited"
      ? `"${String(current)}" is at a limit (${cur.reason})`
      : cur?.state === "out"
        ? `"${String(current)}" can't be used: ${cur.reason}`
        : "no Claude account was in use";
  const why = best.standing.resetsAt === null
    ? "no account with room has started its week yet"
    : `its week resets soonest, in ${inWords(best.standing.resetsAt - now)}`;
  return { to: best.account, reason: `${leaving}; "${best.name}" is next: ${why}` };
}
