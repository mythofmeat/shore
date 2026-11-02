import { afterEach, describe, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectableRequest } from "../src/browser/workspace.ts";
import type { ConfigContext } from "../src/commands/config.ts";
import {
  addCredential, cancelSignIn, finishSignIn, orderCredentials, providerDetail, removeCredential, selectCredential, setCredentialLimit, startSignIn, testCredential, updateCredential,
  type ProviderAdminContext,
} from "../src/commands/provider_admin.ts";
import { loadConfig } from "../src/config/loader.ts";
import { claudeLoginSettingsOf, ProviderRegistry } from "../src/config/providers.ts";
import { claudeAccountOrder, configureClaudePlanLimits, holdClaudeAccount, noClaudeLoginReason, observeClaudeRateLimit, rescanClaudeAccounts, type ClaudePlanCheck } from "../src/ledger/plan_limits.ts";
import { claudeAccountsRoot, type ClaudeAccount } from "../src/llm/claude_accounts.ts";
import { startClaudeSignIn, type SignInFlow } from "../src/llm/claude_sign_in.ts";
import { claudeAgentEnvironment } from "../src/llm/providers/claude_agent.ts";
import { closeSignIns } from "../src/llm/sign_in.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

afterEach(() => {
  closeSignIns();
  configureClaudePlanLimits();
});

const CONFIG = "[providers.claude_agent]\ndiscover = false\n";

interface World {
  ctx: ProviderAdminContext;
  session: ConfigContext;
  configPath: string;
  home: string;
  root: string;
  started: (string | undefined)[];
  closed: string[];
  signingInAs: { email: string };
}

async function world(toml: string = CONFIG, checks: Record<string, ClaudePlanCheck> = {}): Promise<World> {
  const base = await mkdtemp(testTmp("shore-logins-"));
  const configPath = join(base, "config", "config.toml");
  await mkdir(join(base, "config"), { recursive: true });
  await writeFile(configPath, toml);
  const env = { XDG_CONFIG_HOME: base, XDG_DATA_HOME: join(base, "data-home"), XDG_CACHE_HOME: join(base, "cache-home"), XDG_RUNTIME_DIR: join(base, "run-home") };
  const loaded = loadConfig(configPath, { env, onWarn: () => {} });
  const session: ConfigContext = {
    config: loaded, configPath, characterName: undefined, activeModel: undefined, env,
    runtime: { reloadRuntimeConfig: () => {}, adoptGlobalConfig: () => {}, notifyPromptSnapshotRefreshed: () => {} },
  };
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const started: (string | undefined)[] = [];
  const closed: string[] = [];
  const signingInAs = { email: "work@example.com" };
  let flows = 0;
  const signIn = (configDir: string | undefined): Promise<SignInFlow> => {
    started.push(configDir);
    flows += 1;
    const state = `state-${String(flows)}`;
    return Promise.resolve({
      url: `https://claude.example/authorize?state=${state}`,
      state,
      submit: (code: string) => {
        if (code === "refused") return Promise.reject(new Error("Request failed with status code 400"));
        if (configDir !== undefined) {
          writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: signingInAs.email } }));
          writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "secret-token" } }));
        }
        return Promise.resolve({ email: signingInAs.email, plan: "pro" });
      },
      close: () => { closed.push(state); },
    });
  };
  configureClaudePlanLimits({
    home, cacheDir: loaded.dirs.cache,
    settings: () => claudeLoginSettingsOf(session.config.providers),
    fetch: (account: ClaudeAccount) => Promise.resolve(checks[account.name] ?? { status: "ok", poll: { subscription_type: "pro", five_hour: { percent_used: 0.1, resets_at: null }, seven_day: { percent_used: 0.2, resets_at: null } } }),
    signIn,
  });
  return { ctx: { config: session, confidential: true }, session, configPath, home, root: claudeAccountsRoot(home), started, closed, signingInAs };
}

function signedIn(w: World, folder: string, email: string): void {
  const dir = join(w.root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "secret-token" } }));
  rescanClaudeAccounts(Date.now(), true);
}

const logins = (w: World) => providerDetail(w.ctx, { provider: "claude_agent" }).credentials;
const order = () => claudeAccountOrder().map((account) => account.name);

describe("signing a login in", () => {
  test("a new login stays out of use until it's signed in, then keeps the name it was given, with its email beside it, at once", async () => {
    const w = await world();
    signedIn(w, "keysmash", "old@example.com");
    const started = await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    expect(started.url).toBe("https://claude.example/authorize?state=state-1");
    expect(logins(w).map((login) => login.name)).toEqual(["old@example.com"]);
    expect(order()).toEqual(["old@example.com"]);

    const finished = await finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-1" });
    expect(finished.message).toContain("work@example.com");
    expect(finished.provider.credentials.find((login) => login.name === "work")).toMatchObject({ kind: "login", hint: "work@example.com", plan: "pro", standing: "works" });
    expect(order()).toContain("work");
    expect(statSync(join(w.root, "work")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(w.root, ".signing-in"))).toEqual([]);
    expect(await readFile(w.configPath, "utf8")).toContain('[[providers.claude_agent.keys]]\nname = "work"\n');
    expect(await readFile(w.configPath, "utf8")).not.toContain("secret-token");
  });

  test("a login left unnamed goes by its email and writes nothing to the config", async () => {
    const w = await world();
    const started = await startSignIn(w.ctx, { provider: "claude_agent", add: true });
    const finished = await finishSignIn(w.ctx, { provider: "claude_agent", credential: started.credential, code: "the-code#state-1" });
    expect(finished.provider.credentials.map((login) => login.name)).toEqual(["work@example.com"]);
    expect(await readFile(w.configPath, "utf8")).toBe(CONFIG);
  });

  test("starting again while a sign-in waits for its code picks up the same one", async () => {
    const w = await world();
    const first = await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    const second = await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    expect(second.url).toBe(first.url);
    expect(w.started).toHaveLength(1);
  });

  test("a code that isn't whole, or is from another sign-in, is refused without ending the sign-in", async () => {
    const w = await world();
    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    expect(await outcomeOf(finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "half-a-code" }))).toThrow("isn't the whole code");
    expect(await outcomeOf(finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-99" }))).toThrow("different sign-in");
    expect(w.closed).toEqual([]);
    const finished = await finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "https://platform.example/oauth/code/callback?code=the-code&state=state-1" });
    expect(finished.provider.credentials.map((login) => login.name)).toEqual(["work"]);
  });

  test("a sign-in that's stopped, or whose code Claude refuses, leaves no login and no files behind", async () => {
    const w = await world();
    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    cancelSignIn(w.ctx, { provider: "claude_agent", credential: "work" });
    expect(w.closed).toEqual(["state-1"]);
    expect(existsSync(join(w.root, "work"))).toBe(false);
    expect(readdirSync(join(w.root, ".signing-in"))).toEqual([]);

    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    expect(await outcomeOf(finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "refused#state-2" }))).toThrow("didn't accept that code");
    expect(existsSync(join(w.root, "work"))).toBe(false);
    expect(readdirSync(join(w.root, ".signing-in"))).toEqual([]);
    expect(await readFile(w.configPath, "utf8")).toBe(CONFIG);
    expect(await outcomeOf(finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-2" }))).toThrow("no sign-in is waiting");
  });

  test("signing in to a Claude account that's already a login adds nothing", async () => {
    const w = await world();
    signedIn(w, "keysmash", "work@example.com");
    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    expect(await outcomeOf(finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-1" }))).toThrow("already the login");
    expect(existsSync(join(w.root, "work"))).toBe(false);
  });

  test("a signed-out login signs back in where it is, and shore can't be sent outside its logins folder", async () => {
    const w = await world();
    mkdirSync(join(w.root, "expired"), { recursive: true });
    await startSignIn(w.ctx, { provider: "claude_agent", credential: "expired" });
    expect(w.started).toEqual([join(w.root, "expired")]);
    const finished = await finishSignIn(w.ctx, { provider: "claude_agent", credential: "expired", code: "the-code#state-1" });
    expect(finished.provider.credentials.map((login) => login.name)).toEqual(["work@example.com"]);

    for (const name of ["../outside", "a/b", ".hidden", "..", "subscription"]) {
      expect(await outcomeOf(startSignIn(w.ctx, { provider: "claude_agent", credential: name, add: true }))).toThrow();
    }
    expect(w.started).toHaveLength(1);
    for (const key of [{ name: "x", dir: "../outside" }, { name: "../outside" }, { name: "x", dir: "a/b" }, { name: ".signing-in" }]) {
      expect(() => ProviderRegistry.fromSection({ claude_agent: { keys: [key] } })).toThrow("must name a folder");
    }
  });

  test("a login the config names but whose folder is gone shows as signed out, gets no calls, and signs back in to the same folder", async () => {
    const w = await world(`${CONFIG}\n[[providers.claude_agent.keys]]\nname = "work"\nweekly_limit = 0.5\n`);
    signedIn(w, "other", "other@example.com");
    expect(logins(w).find((login) => login.name === "work")).toMatchObject({ standing: "signed_out", login_command: "shore provider claude_agent auth work --login" });
    expect(order()).toEqual(["other@example.com"]);
    expect(existsSync(join(w.root, "work"))).toBe(false);

    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work" });
    expect(existsSync(join(w.root, "work"))).toBe(false);
    const finished = await finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-1" });
    expect(finished.provider.credentials.find((login) => login.name === "work")).toMatchObject({ standing: "works", hint: "work@example.com" });
    expect(existsSync(join(w.root, "work", ".credentials.json"))).toBe(true);
    expect((await readFile(w.configPath, "utf8")).match(/name = "work"/g)).toHaveLength(1);
  });

  test("a pin on a login that can't be used stops calls, and the refusal says how to get going again", async () => {
    const w = await world(`${CONFIG}pin = "work"\n\n[[providers.claude_agent.keys]]\nname = "work"\n`);
    signedIn(w, "other", "other@example.com");
    expect(order()).toEqual([]);
    expect(noClaudeLoginReason()).toContain('pinned to the Claude login "work"');
    expect(noClaudeLoginReason()).toContain("auth work --login");
    expect(noClaudeLoginReason()).toContain("use --auto");
  });

  test("a sign-in code stays out of the browser's request history", () => {
    const request = inspectableRequest({ type: "command", name: "finish_sign_in", args: { provider: "claude_agent", credential: "work", code: "the-code#state" } });
    expect(JSON.stringify(request)).not.toContain("the-code");
  });

  test("the Agent SDK's own Claude Code offers a sign-in that returns its code here, without opening a browser", async () => {
    const base = await mkdtemp(testTmp("shore-logins-real-"));
    const configDir = join(base, "login");
    const bin = join(base, "bin");
    await mkdir(configDir, { recursive: true });
    await mkdir(bin, { recursive: true });
    const opener = join(bin, "xdg-open");
    await writeFile(opener, `#!/bin/sh\ntouch ${join(base, "browser-opened")}\n`, { mode: 0o755 });
    const env = claudeAgentEnvironment(undefined, "", configDir);
    const flow = await startClaudeSignIn(query, { ...env, HOME: base, PATH: `${bin}:${env.PATH ?? ""}`, BROWSER: opener });
    try {
      const url = new URL(flow.url);
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("state")).toBe(flow.state);
      expect(url.searchParams.get("redirect_uri")).not.toContain("localhost");
      expect(existsSync(join(base, "browser-opened"))).toBe(false);
    } finally {
      flow.close();
    }
  }, 60_000);
});

describe("choosing a login", () => {
  test("a pin holds until --auto, by name or email, and a pin's login must be able to work", async () => {
    const w = await world(CONFIG, { out: { status: "logged_out" } });
    signedIn(w, "a", "a@example.com");
    signedIn(w, "b", "b@example.com");
    await startSignIn(w.ctx, { provider: "claude_agent", credential: "work", add: true });
    await finishSignIn(w.ctx, { provider: "claude_agent", credential: "work", code: "the-code#state-1" });

    const pinned = selectCredential(w.ctx, { provider: "claude_agent", credential: "WORK@example.com" });
    expect(pinned.provider.pinned).toBe("work");
    expect(pinned.provider.credentials.find((login) => login.name === "work")).toMatchObject({ pinned: true, in_use: true });
    expect(order()).toEqual(["work"]);

    selectCredential(w.ctx, { provider: "claude_agent", credential: null });
    expect(order().length).toBeGreaterThan(1);

    expect(() => selectCredential(w.ctx, { provider: "claude_agent", credential: "nobody" })).toThrow("no login named");
    mkdirSync(join(w.root, "out"));
    expect(await testCredential(w.ctx, { provider: "claude_agent", credential: "out" })).toMatchObject({ ok: false, standing: "signed_out" });
    expect(() => selectCredential(w.ctx, { provider: "claude_agent", credential: "out" })).toThrow("isn't signed in");
    await updateCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com", enabled: false });
    expect(() => selectCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" })).toThrow("is disabled");
  });

  test("pinning a login named by its email ties the setting to its folder", async () => {
    const w = await world();
    signedIn(w, "keysmash", "a@example.com");
    signedIn(w, "other", "b@example.com");
    selectCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    const text = await readFile(w.configPath, "utf8");
    expect(text).toContain('name = "a@example.com"\ndir = "keysmash"');
    expect(text).toContain('pin = "a@example.com"');
    expect(providerDetail(w.ctx, { provider: "claude_agent" }).pinned).toBe("a@example.com");
    expect(order()).toEqual(["a@example.com"]);
  });

  test("a disabled login gets no calls, and disabling the pinned one unpins it", async () => {
    const w = await world();
    signedIn(w, "a", "a@example.com");
    signedIn(w, "b", "b@example.com");
    selectCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    const disabled = await updateCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com", enabled: false });
    expect(disabled.provider.pinned).toBeNull();
    expect(disabled.provider.credentials.find((login) => login.name === "a@example.com")?.enabled).toBe(false);
    expect(order()).toEqual(["b@example.com"]);

    await updateCredential(w.ctx, { provider: "claude_agent", credential: "b@example.com", enabled: false });
    expect(order()).toEqual([]);

    await updateCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com", enabled: true });
    expect(order()).toEqual(["a@example.com"]);
  });

  test("renaming a login keeps its folder, its pin and the fact that it's in use", async () => {
    const w = await world();
    signedIn(w, "keysmash", "a@example.com");
    signedIn(w, "other", "b@example.com");
    selectCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    const renamed = await updateCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com", rename: "personal" });
    expect(renamed.provider.pinned).toBe("personal");
    expect(renamed.provider.credentials.find((login) => login.name === "personal")).toMatchObject({ hint: "a@example.com", in_use: true });
    expect(existsSync(join(w.root, "keysmash"))).toBe(true);
    expect(order()).toEqual(["personal"]);
    expect(await outcomeOf(updateCredential(w.ctx, { provider: "claude_agent", credential: "personal", rename: "b@example.com" }))).toThrow("already has a login");
  });

  test("logins have no order or keys of their own", async () => {
    const w = await world();
    expect(() => orderCredentials(w.ctx, { provider: "claude_agent", order: ["a"] })).toThrow("no order of logins");
    expect(await outcomeOf(addCredential(w.ctx, { provider: "claude_agent", secret: "sk-0123456789abcdef" }))).toThrow("signs in with Claude logins");
  });
});

describe("limits", () => {
  test("a login's limits are written as fractions, replace the switch points for that login alone, and move it aside at once", async () => {
    const w = await world();
    signedIn(w, "a", "a@example.com");
    signedIn(w, "b", "b@example.com");
    observeClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.6, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, "a@example.com");
    observeClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.6, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, "b@example.com");
    expect(order()).toEqual(["a@example.com", "b@example.com"]);

    const limited = setCredentialLimit(w.ctx, { provider: "claude_agent", credential: "a@example.com", windows: [{ window: "session", limit: 0.8 }, { window: "weekly", limit: 0.5 }] });
    expect(limited.message).toContain("weekly limit 50%");
    expect(await readFile(w.configPath, "utf8")).toContain("session_limit = 0.8\nweekly_limit = 0.5");
    const a = limited.provider.credentials.find((login) => login.name === "a@example.com");
    expect(a?.standing).toBe("over_quota");
    expect(a?.windows.find((window) => window.label === "weekly")).toMatchObject({ limit: 0.5, limit_set: true, at_limit: true });
    expect(limited.provider.credentials.find((login) => login.name === "b@example.com")?.windows.find((window) => window.label === "weekly")).toMatchObject({ limit: 0.98, limit_set: false, at_limit: false });
    expect(order()).toEqual(["b@example.com"]);

    setCredentialLimit(w.ctx, { provider: "claude_agent", credential: "a@example.com", windows: [{ window: "weekly", limit: null }] });
    expect(order()).toContain("a@example.com");
  });

  test("nonsense limits are refused, a login has no spend limit, and a key has no windows", async () => {
    const w = await world("[providers.claude_agent]\ndiscover = false\n\n[providers.openrouter]\ndiscover = false\n");
    signedIn(w, "a", "a@example.com");
    for (const limit of [0, -1, 1.5]) {
      expect(() => setCredentialLimit(w.ctx, { provider: "claude_agent", credential: "a@example.com", windows: [{ window: "weekly", limit }] })).toThrow("at most 100%");
    }
    expect(() => setCredentialLimit(w.ctx, { provider: "claude_agent", credential: "a@example.com", windows: [{ window: "monthly", limit: 0.5 }] })).toThrow("session and weekly");
    expect(() => setCredentialLimit(w.ctx, { provider: "claude_agent", credential: "a@example.com", cost_usd: 5 })).toThrow("no spending to limit");
    expect(() => setCredentialLimit(w.ctx, { provider: "openrouter", credential: "k", windows: [{ window: "weekly", limit: 0.5 }] })).toThrow("only a Claude login");
    expect(() => ProviderRegistry.fromSection({ openrouter: { keys: [{ name: "k", weekly_limit: 0.5 }] } })).toThrow("only a login");
    expect(() => ProviderRegistry.fromSection({ claude_agent: { keys: [{ name: "k", weekly_limit: 50 }] } })).toThrow("at most 1");
  });
});

describe("removing a login", () => {
  test("removing the login in use moves calls to the next, deletes its saved sign-in and keeps the rest of its folder aside", async () => {
    const w = await world();
    signedIn(w, "a", "a@example.com");
    signedIn(w, "b", "b@example.com");
    selectCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    const removed = removeCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    expect(removed.message).toContain('calls now go to "b@example.com"');
    expect(removed.provider.pinned).toBeNull();
    expect(removed.provider.credentials.map((login) => [login.name, login.in_use])).toEqual([["b@example.com", true]]);
    expect(existsSync(join(w.root, "a"))).toBe(false);
    const [aside] = readdirSync(join(w.root, ".removed"));
    expect(aside).toStartWith("a-");
    expect(existsSync(join(w.root, ".removed", String(aside), ".claude.json"))).toBe(true);
    expect(existsSync(join(w.root, ".removed", String(aside), ".credentials.json"))).toBe(false);
    expect(await readFile(w.configPath, "utf8")).not.toContain("a@example.com");
    expect(order()).toEqual(["b@example.com"]);
  });

  test("a login something is running on isn't removed", async () => {
    const w = await world();
    signedIn(w, "a", "a@example.com");
    signedIn(w, "b", "b@example.com");
    const release = holdClaudeAccount({ configDir: join(w.root, "a") });
    expect(() => removeCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" })).toThrow("right now");
    expect(existsSync(join(w.root, "a", ".credentials.json"))).toBe(true);
    release();
    removeCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    expect(existsSync(join(w.root, "a"))).toBe(false);
  });

  test("the last login hands over to the daemon's own, which itself isn't shore's to remove", async () => {
    const w = await world();
    signedIn(w, "a", "a@example.com");
    const removed = removeCredential(w.ctx, { provider: "claude_agent", credential: "a@example.com" });
    expect(removed.message).toContain("daemon's own Claude login");
    expect(removed.provider.credentials.map((login) => login.name)).toEqual(["subscription"]);
    expect(() => removeCredential(w.ctx, { provider: "claude_agent", credential: "subscription" })).toThrow("leaves it alone");
  });
});
