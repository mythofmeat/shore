import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { isLoginFolderName, WINDOW_LIMIT_FIELDS, type ProviderEntry, type WindowLimits } from "../config/providers.ts";
import {
  appendTomlArrayTable,
  removeTomlArrayTable,
  setTomlArrayTableValue,
  setTomlValue,
  unsetTomlArrayTableValue,
  unsetTomlValue,
} from "../config/toml_edit.ts";
import {
  claudeAccountRemoved,
  claudeLoginOverview,
  claudeLoginSettings,
  claudeLoginsRoot,
  refreshClaudeAccount,
  renameClaudeAccount,
  rescanClaudeAccounts,
  startClaudeLoginFlow,
  useClaudeAccount,
  type ClaudeLoginReport,
} from "../ledger/plan_limits.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { claudeLoginCommand, DEFAULT_CLAUDE_ACCOUNT } from "../llm/claude_accounts.ts";
import type { SignedIn } from "../llm/claude_sign_in.ts";
import { beginSignIn, cancelSignIn, pendingSignIn, readPastedCode, takeSignIn } from "../llm/sign_in.ts";
import type { CredentialStanding } from "../protocol/CredentialStanding.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import { commitConfigEdits, type ConfigContext } from "./config.ts";
import { busy, invalidRequest, notFound, providerError } from "./errors.ts";

export interface LoginContext {
  config: ConfigContext;
  now?: () => number;
}

export interface LoginTarget {
  provider: string;
  entry: ProviderEntry;
  file: string;
}

export interface LoginChange {
  file: string;
  message: string;
}

type SignInDetail =
  | { kind: "add"; folder: string; staging: string; named: boolean; replaces: string | undefined }
  | { kind: "restore"; folder: string; staging: string; name: string }
  | { kind: "again"; name: string };

const STAGING = ".signing-in";
const REMOVED = ".removed";

const toml = (value: string): string => JSON.stringify(value);
const tomlFloat = (value: number): string => (Number.isInteger(value) ? `${String(value)}.0` : String(value));
const providerPath = (name: string): string[] => ["providers", name];
const keysPath = (name: string): string[] => ["providers", name, "keys"];

function clock(ctx: LoginContext): number {
  return ctx.now?.() ?? Date.now();
}

export function refuseOtherLoginProvider(provider: string): void {
  const owner = claudeLoginSettings().provider;
  if (owner !== provider) throw invalidRequest(`Claude logins are managed on ${owner}, which holds their settings; use \`shore provider ${owner} auth\``);
}

export function loginStanding(login: Pick<ClaudeLoginReport, "signed_out" | "state">): CredentialStanding {
  if (login.signed_out) return "signed_out";
  if (login.state === "ok") return "works";
  if (login.state === "limited") return "over_quota";
  return login.state === "out" ? "invalid" : "not_checked";
}

function findLogin(logins: readonly ClaudeLoginReport[], raw: string): ClaudeLoginReport | undefined {
  const wanted = raw.trim();
  const folded = wanted.toLowerCase();
  return logins.find((login) => login.account.name === wanted)
    ?? logins.find((login) => login.email === wanted)
    ?? logins.find((login) => login.account.name.toLowerCase() === folded)
    ?? logins.find((login) => login.email?.toLowerCase() === folded)
    ?? logins.find((login) => login.account.folder === wanted);
}

function requireLogin(ctx: LoginContext, target: LoginTarget, raw: string): ClaudeLoginReport {
  const { logins } = claudeLoginOverview(clock(ctx));
  const login = findLogin(logins, raw);
  if (login === undefined) throw notFound(`${target.provider} has no login named ${JSON.stringify(raw)}; its logins are ${logins.map((l) => l.account.name).join(", ")}`);
  return login;
}

function requireNewName(logins: readonly ClaudeLoginReport[], name: string, target: LoginTarget): void {
  if (!isLoginFolderName(name)) throw invalidRequest(`login names use letters, digits, ., _, @ and -, starting with a letter or digit: ${JSON.stringify(name)}`);
  if (name.toLowerCase() === DEFAULT_CLAUDE_ACCOUNT) throw invalidRequest(`"${DEFAULT_CLAUDE_ACCOUNT}" is what ${target.provider} calls the daemon's own Claude login; pick another name`);
  const taken = findLogin(logins, name);
  if (taken !== undefined) throw invalidRequest(`${target.provider} already has a login named ${JSON.stringify(taken.account.name)}${taken.email === null ? "" : ` (${taken.email})`}; pick another name, or sign that one in again with \`${claudeLoginCommand(taken.account, target.provider)}\``);
}

function indexOf(target: LoginTarget, name: string): number {
  return target.entry.keys.findIndex((key) => key.name === name);
}

function withEntry(target: LoginTarget, login: ClaudeLoginReport, edit: (text: string, index: number) => string): (text: string) => string {
  const index = indexOf(target, login.account.name);
  return (before) => {
    if (index >= 0) return edit(before, index);
    const folder = login.account.folder;
    const fields: [string, string][] = [["name", toml(login.account.name)], ...(folder === undefined || folder === login.account.name ? [] : [["dir", toml(folder)] as [string, string]])];
    return edit(appendTomlArrayTable(before, keysPath(target.provider), fields, providerPath(target.provider)), target.entry.keys.length);
  };
}

function commit(ctx: LoginContext, target: LoginTarget, edit: (text: string) => string, rejection: string): void {
  commitConfigEdits(ctx.config, [{ file: target.file, edit }], rejection);
}

export function updateLogin(ctx: LoginContext, target: LoginTarget, args: OperationInput<"update_credential">): LoginChange {
  const { provider } = target;
  const login = requireLogin(ctx, target, args.credential);
  const name = login.account.name;
  if (args.secret !== undefined) throw invalidRequest(`${provider} signs in with Claude logins, so "${name}" has no key to replace; sign it in again with \`${claudeLoginCommand(login.account, provider)}\``);
  if (args.warn_on_fallback !== undefined) throw invalidRequest("a Claude login has no fallback warning; logins move on by room left");
  const edits: ((text: string) => string)[] = [];
  const said: string[] = [];
  if (args.enabled === true && indexOf(target, name) >= 0) {
    edits.push((text) => unsetTomlArrayTableValue(text, keysPath(provider), indexOf(target, name), "enabled"));
    said.push("enabled");
  } else if (args.enabled === true) {
    said.push("already enabled");
  }
  if (args.enabled === false) {
    edits.push(withEntry(target, login, (text, index) => setTomlArrayTableValue(text, keysPath(provider), index, "enabled", "false")));
    said.push("disabled: nothing new starts on it");
    if (login.pinned) {
      edits.push((text) => unsetTomlValue(text, [...providerPath(provider), "pin"]).text);
      said.push("no longer pinned");
    }
  }
  let renamed: string | undefined;
  if (args.rename !== undefined) {
    const to = args.rename.trim();
    if (to !== name) {
      if (login.account.configDir === undefined) throw invalidRequest(`"${name}" is the daemon's own Claude login and keeps that name`);
      requireNewName(claudeLoginOverview(clock(ctx)).logins.filter((other) => other.account.name !== name), to, target);
      renamed = to;
      const folder = login.account.folder;
      edits.push((before) => {
        const index = indexOf(target, name);
        if (index < 0) {
          const fields: [string, string][] = [["name", toml(to)], ...(folder === undefined || folder === to ? [] : [["dir", toml(folder)] as [string, string]])];
          return appendTomlArrayTable(before, keysPath(provider), fields, providerPath(provider));
        }
        const named = setTomlArrayTableValue(before, keysPath(provider), index, "name", toml(to));
        return folder === undefined || folder === to
          ? unsetTomlArrayTableValue(named, keysPath(provider), index, "dir")
          : setTomlArrayTableValue(named, keysPath(provider), index, "dir", toml(folder));
      });
      if (login.pinned && args.enabled !== false) edits.push((text) => setTomlValue(text, [...providerPath(provider), "pin"], toml(to)).text);
      said.push(`renamed to "${to}" (earlier usage stays under "${name}")`);
    }
  }
  if (said.length === 0) throw invalidRequest("nothing to change");
  commit(ctx, target, (before) => edits.reduce((text, edit) => edit(text), before), `changing login ${name} of ${provider}`);
  if (renamed !== undefined) renameClaudeAccount(name, renamed);
  rescanClaudeAccounts(clock(ctx), true);
  return { file: target.file, message: `${provider} login "${name}": ${said.join(", ")}` };
}

export function removeLogin(ctx: LoginContext, target: LoginTarget, credential: string): LoginChange {
  const { provider } = target;
  const login = requireLogin(ctx, target, credential);
  const name = login.account.name;
  const { configDir, folder } = login.account;
  if (configDir === undefined || folder === undefined) {
    throw invalidRequest(`"${name}" is the daemon's own Claude login, kept outside ${claudeLoginsRoot()}, so shore leaves it alone; sign it out on the daemon's machine with \`claude auth logout\``);
  }
  if (login.busy) throw busy(`"${name}" is in use by a reply or check right now; remove it once that's finished, or disable it first so nothing new starts on it`);
  cancelSignIn(provider, name);
  const now = clock(ctx);
  const aside = join(claudeLoginsRoot(), REMOVED, `${folder}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
  const moved = login.account.missing !== true && existsSync(configDir);
  if (moved) {
    mkdirSync(dirname(aside), { recursive: true, mode: 0o700 });
    renameSync(configDir, aside);
  }
  const index = indexOf(target, name);
  try {
    commit(ctx, target, (before) => {
      const unpinned = login.pinned ? unsetTomlValue(before, [...providerPath(provider), "pin"]).text : before;
      return index < 0 ? unpinned : removeTomlArrayTable(unpinned, keysPath(provider), index);
    }, `removing login ${name} from ${provider}`);
  } catch (e) {
    if (moved) renameSync(aside, configDir);
    throw e;
  }
  if (moved) rmSync(join(aside, ".credentials.json"), { force: true });
  const next = claudeAccountRemoved(name, now);
  const { logins } = claudeLoginOverview(now);
  const own = logins.find((other) => other.account.configDir === undefined);
  const after = own === undefined
    ? next === undefined || !login.in_use ? "" : `; calls now go to "${next}"`
    : `; no logins are left in ${claudeLoginsRoot()}, so ${provider} uses the daemon's own Claude login`;
  const kept = moved ? `, and the rest of its folder moved to ${aside}` : "";
  return { file: target.file, message: `Removed ${provider} login "${name}": its saved sign-in is deleted${kept}${login.pinned ? ", and it's no longer pinned" : ""}${after}` };
}

export function pinLogin(ctx: LoginContext, target: LoginTarget, credential: string | null): LoginChange {
  const { provider } = target;
  if (credential === null) {
    commit(ctx, target, (before) => unsetTomlValue(before, [...providerPath(provider), "pin"]).text, `unpinning ${provider}`);
    return { file: target.file, message: `${provider} picks its login automatically again: one with room, preferring the one whose week resets soonest` };
  }
  const login = requireLogin(ctx, target, credential);
  const name = login.account.name;
  if (!login.enabled) throw invalidRequest(`"${name}" is disabled; enable it before pinning it`);
  if (login.signed_out) throw invalidRequest(`"${name}" isn't signed in; sign it in first with \`${claudeLoginCommand(login.account, provider)}\``);
  commit(ctx, target, withEntry(target, login, (text) => setTomlValue(text, [...providerPath(provider), "pin"], toml(name)).text), `pinning ${provider} to ${name}`);
  rescanClaudeAccounts(clock(ctx), true);
  useClaudeAccount(name, `pinned to "${name}"`);
  return { file: target.file, message: `${provider} now uses only "${name}"; at its limit, or when Claude refuses it, calls fail instead of moving to another login. A reply already running stays on the login it started on` };
}

function windowOf(raw: string): keyof WindowLimits | undefined {
  switch (raw.trim().toLowerCase()) {
    case "session":
    case "five_hour":
      return "session";
    case "weekly":
    case "seven_day":
      return "weekly";
    default:
      return undefined;
  }
}

export function limitLogin(ctx: LoginContext, target: LoginTarget, args: OperationInput<"set_credential_limit">): LoginChange {
  const { provider } = target;
  const login = requireLogin(ctx, target, args.credential);
  const name = login.account.name;
  if (args.cost_usd !== undefined && args.cost_usd !== null) throw invalidRequest(`a Claude login runs on its plan, so it has no spending to limit; limit its session or weekly window instead`);
  const windows = args.windows ?? [];
  if (windows.length === 0) throw invalidRequest("say which window to limit: session or weekly");
  const edits: ((text: string, index: number) => string)[] = [];
  const said: string[] = [];
  for (const { window, limit } of windows) {
    const which = windowOf(window);
    if (which === undefined) throw notFound(`a Claude login has session and weekly windows, not ${JSON.stringify(window)}`);
    const field = WINDOW_LIMIT_FIELDS[which];
    if (limit === null) {
      edits.push((text, index) => unsetTomlArrayTableValue(text, keysPath(provider), index, field));
      said.push(`no ${which} limit of its own`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0 || limit > 1) throw invalidRequest(`a limit is a share of the window, above 0% and at most 100%: ${String(limit)}`);
    edits.push((text, index) => setTomlArrayTableValue(text, keysPath(provider), index, field, tomlFloat(limit)));
    said.push(`${which} limit ${String(Math.round(limit * 100))}%`);
  }
  commit(ctx, target, withEntry(target, login, (before, index) => edits.reduce((text, edit) => edit(text, index), before)), `limiting login ${name} of ${provider}`);
  rescanClaudeAccounts(clock(ctx), true);
  const others = claudeLoginOverview(clock(ctx)).logins.some((other) => other.account.name !== name && other.enabled && !other.signed_out);
  const past = settingLimit(ctx, target, name)
    ? login.pinned || !others ? "; past a limit its calls are refused" : "; past a limit calls move on to a login with room, or are refused if none has any"
    : "; shore moves off it near the end of a window when another login has room";
  return { file: target.file, message: `${provider} login "${name}": ${said.join(", ")}${past}` };
}

function settingLimit(ctx: LoginContext, target: LoginTarget, name: string): boolean {
  const limits = ctx.config.config.providers.get(target.provider)?.keys.find((key) => key.name === name)?.windowLimits;
  return limits?.session !== undefined || limits?.weekly !== undefined;
}

export async function testLogin(ctx: LoginContext, target: LoginTarget, credential: string): Promise<OperationResult<"test_credential">> {
  const login = requireLogin(ctx, target, credential);
  const name = login.account.name;
  await refreshClaudeAccount(name, clock(ctx));
  const fresh = requireLogin(ctx, target, name);
  const standing = loginStanding(fresh);
  return { provider: target.provider, credential: name, ok: standing === "works", standing, detail: fresh.detail, model_count: null };
}

function nextFolder(logins: readonly ClaudeLoginReport[], provider: string): string {
  const root = claudeLoginsRoot();
  for (let n = 1; ; n += 1) {
    const folder = `login-${String(n)}`;
    if (!existsSync(join(root, folder)) && !existsSync(join(root, STAGING, folder)) && findLogin(logins, folder) === undefined && pendingSignIn(provider, folder) === undefined) return folder;
  }
}

function stagingFor(folder: string): string {
  const root = claudeLoginsRoot();
  const parent = join(root, STAGING);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, folder);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });
  return staging;
}

function dropStaging(detail: SignInDetail): void {
  if (detail.kind !== "again") rmSync(detail.staging, { recursive: true, force: true });
}

async function stagedFlow(folder: string, detail: (staging: string) => SignInDetail) {
  const staging = stagingFor(folder);
  try {
    return { flow: await startClaudeLoginFlow(staging), detail: detail(staging) };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

function startFailure(e: unknown): Error {
  return providerError(`Couldn't start signing in: ${e instanceof Error ? e.message : String(e)}`);
}

export async function startLoginSignIn(ctx: LoginContext, target: LoginTarget, args: OperationInput<"start_sign_in">): Promise<OperationResult<"start_sign_in">> {
  const { provider } = target;
  const now = clock(ctx);
  rescanClaudeAccounts(now, true);
  const { logins } = claudeLoginOverview(now);
  const requested = args.credential?.trim() ?? "";
  let credential: string;
  let start: () => Promise<{ flow: Awaited<ReturnType<typeof startClaudeLoginFlow>>; detail: SignInDetail }>;
  if (args.add === true) {
    if (requested !== "" && pendingSignIn(provider, requested) === undefined) {
      requireNewName(logins, requested, target);
      if (existsSync(join(claudeLoginsRoot(), requested))) throw invalidRequest(`${join(claudeLoginsRoot(), requested)} is already there, so a new login can't use that name`);
    }
    credential = requested === "" ? nextFolder(logins, provider) : requested;
    const replaces = logins.find((login) => login.account.configDir === undefined && !login.signed_out)?.account.name;
    start = () => stagedFlow(credential, (staging) => ({ kind: "add", folder: credential, staging, named: requested !== "", replaces }));
  } else {
    if (requested === "") throw invalidRequest(`name the login to sign in, or add a new one with \`shore provider ${provider} auth --add NAME\``);
    const login = findLogin(logins, requested);
    if (login === undefined) throw notFound(`${provider} has no login named ${JSON.stringify(requested)}; add it with \`shore provider ${provider} auth --add ${requested}\``);
    credential = login.account.name;
    const { folder, configDir } = login.account;
    start = login.account.missing === true && folder !== undefined
      ? () => stagedFlow(folder, (staging) => ({ kind: "restore", folder, staging, name: credential }))
      : async () => ({ flow: await startClaudeLoginFlow(configDir), detail: { kind: "again", name: credential } });
  }
  const { pending } = await beginSignIn(provider, credential, start, dropStaging, now).catch((e: unknown) => {
    throw startFailure(e);
  });
  return {
    provider,
    credential,
    url: pending.flow.url,
    expires_at: toRfc3339(pending.expiresAt),
    message: `Open this link, sign in to the Claude account for "${credential}", and paste back the code it shows`,
  };
}

function describeSignedIn(name: string, signedIn: SignedIn): string {
  const who = [signedIn.email === name ? undefined : signedIn.email, signedIn.plan].filter((part) => part !== undefined).join(", ");
  return `Signed in "${name}"${who === "" ? "" : ` (${who})`}`;
}

export async function finishLoginSignIn(ctx: LoginContext, target: LoginTarget, args: OperationInput<"finish_sign_in">): Promise<LoginChange> {
  const { provider } = target;
  const credential = args.credential.trim();
  const waiting = pendingSignIn<SignInDetail>(provider, credential);
  if (waiting === undefined) throw notFound(`no sign-in is waiting for "${credential}"; it may have timed out. Start again with \`shore provider ${provider} auth\``);
  const pasted = readPastedCode(args.code);
  if (pasted === undefined) throw invalidRequest("that isn't the whole code; the page shows one long code with a # in the middle. Paste all of it");
  if (pasted.state !== waiting.flow.state) throw invalidRequest("that code is from a different sign-in. Open the link from this sign-in, and paste the code that page shows");
  const taken = takeSignIn<SignInDetail>(provider, credential);
  if (taken === undefined) throw notFound(`the sign-in for "${credential}" just ended; start again if it isn't signed in`);
  let signedIn: SignedIn;
  try {
    signedIn = await taken.flow.submit(pasted.code, pasted.state);
  } catch (e) {
    taken.cleanup();
    throw providerError(`Claude didn't accept that code (${e instanceof Error ? e.message : String(e)}), and nothing changed. A code works once and soon expires, so sign in again`);
  }
  const now = clock(ctx);
  const detail = taken.detail;
  const notes: string[] = [];
  let name: string;
  if (detail.kind === "again") {
    name = detail.name;
  } else {
    const final = join(claudeLoginsRoot(), detail.folder);
    if (detail.kind === "add" && signedIn.email !== undefined) {
      const twin = claudeLoginOverview(now).logins.find((login) => login.email?.toLowerCase() === signedIn.email?.toLowerCase() && login.account.configDir !== undefined);
      if (twin !== undefined) {
        taken.cleanup();
        throw invalidRequest(`that was ${signedIn.email}, which is already the login "${twin.account.name}", so nothing was added. To add another login, sign in to a different Claude account; a private browser window helps if the page signs you straight in`);
      }
    }
    if (existsSync(final)) {
      taken.cleanup();
      throw invalidRequest(`${final} appeared while you were signing in, so nothing was added; pick another name`);
    }
    renameSync(detail.staging, final);
    if (detail.kind === "restore") {
      name = detail.name;
    } else {
      name = detail.named ? detail.folder : signedIn.email ?? detail.folder;
      if (detail.named) {
        const fields: [string, string][] = [["name", toml(detail.folder)]];
        try {
          commit(ctx, target, (before) => appendTomlArrayTable(before, keysPath(provider), fields, providerPath(provider)), `naming login ${detail.folder}`);
        } catch (e) {
          name = signedIn.email ?? detail.folder;
          notes.push(`it goes by its email because shore couldn't save the name: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (detail.replaces !== undefined) notes.push(`${provider} now uses the logins in ${claudeLoginsRoot()} instead of the daemon's own Claude login`);
    }
  }
  rescanClaudeAccounts(now, true);
  await refreshClaudeAccount(name, now);
  return { file: target.file, message: `${describeSignedIn(name, signedIn)}${notes.length === 0 ? "" : `; ${notes.join("; ")}`}` };
}

export function cancelLoginSignIn(target: LoginTarget, credential: string): OperationResult<"cancel_sign_in"> {
  const ended = cancelSignIn(target.provider, credential.trim());
  return { provider: target.provider, credential, message: ended ? `Stopped signing in "${credential}"; nothing changed` : `No sign-in was waiting for "${credential}"` };
}
