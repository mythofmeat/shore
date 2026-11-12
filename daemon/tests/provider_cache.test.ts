import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import {
  claudeAccountInUsePath,
  claudeAccountInUse,
  claudeAccounts,
  claudePlanLimitsPath,
  configureClaudePlanLimits,
  readClaudePlanLimits,
  refreshClaudeAccount,
  useClaudeAccount,
} from "../src/ledger/plan_limits.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { setSubscriptionProviders } from "../src/ledger/store.ts";
import { claudeAccountsRoot } from "../src/llm/claude_accounts.ts";
import { configureCredentialStanding, credentialStanding, noteCredentialStanding } from "../src/llm/credential_standing.ts";
import { CACHE_VERSION, cachePath, readCacheSync, writeCache } from "../src/llm/discovery.ts";
import { readLearnedImageSupport, recordImageRejection } from "../src/llm/image_support.ts";
import { nanoGptSubscriptionPath, readNanoGptSubscriptionSync, writeNanoGptSubscription, type NanoGptSubscriptionState } from "../src/llm/nanogpt_subscription.ts";
import { createRuntime } from "../src/runtime.ts";
import { testTmp } from "./support/tmp.ts";

afterEach(() => {
  configureClaudePlanLimits();
  configureCredentialStanding(undefined);
  setSubscriptionProviders(["opencode-go", "opencode"]);
  closeLedgers();
});

const freshCache = (): string => testTmp(`provider-cache-${randomUUID()}`);

const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

function foldersFrom(cache: string, file: string): string[] {
  const folders = [];
  for (let folder = join(file, ".."); folder.startsWith(join(cache, "providers")); folder = join(folder, "..")) folders.push(folder);
  return folders;
}

function expectOnlyTheDaemonCanOpen(cache: string, file: string): void {
  const folders = foldersFrom(cache, file);
  expect(folders.at(-1)).toBe(join(cache, "providers"));
  expect(folders.map((folder) => [folder, modeOf(folder)])).toEqual(folders.map((folder) => [folder, "700"]));
}

test("a model catalog written to an empty cache sits in folders only the daemon can open", async () => {
  const cache = freshCache();
  const path = cachePath(cache, "openrouter");
  const catalog = { version: CACHE_VERSION, provider_key: "openrouter", fetched_at: "2026-11-12T10:00:00Z", models: [{ provider_key: "openrouter", model_id: "a-model", sdk: "openai", discovered_at: "2026-11-12T10:00:00Z" }] };

  await writeCache(path, catalog);

  expect(readCacheSync(path)).toEqual(catalog);
  expectOnlyTheDaemonCanOpen(cache, path);
});

test("a NanoGPT subscription written to an empty cache sits in folders only the daemon can open", async () => {
  const cache = freshCache();
  const path = nanoGptSubscriptionPath(cache);
  const state: NanoGptSubscriptionState = { version: 1, fetched_at: "2026-11-12T10:00:00Z", active: true, state: "active" };

  await writeNanoGptSubscription(path, state);

  expect(readNanoGptSubscriptionSync(path)).toEqual(state);
  expectOnlyTheDaemonCanOpen(cache, path);
});

test("a model learned to refuse pictures is remembered in folders only the daemon can open", () => {
  const cache = freshCache();

  recordImageRejection(cache, "openrouter", "a-model");

  expect(readLearnedImageSupport(cache, "openrouter")).toEqual({ "a-model": false });
  expectOnlyTheDaemonCanOpen(cache, join(cache, "providers", "openrouter", "image_support.json"));
});

test("how a key stands is remembered in folders only the daemon can open", () => {
  const cache = freshCache();
  configureCredentialStanding(cache);

  noteCredentialStanding("openrouter", "main", "over_quota", "out of credit", Date.parse("2026-11-12T10:00:00Z"));

  configureCredentialStanding(cache);
  expect(credentialStanding("openrouter", "main")).toEqual({ standing: "over_quota", detail: "out of credit", checked_at: "2026-11-12T10:00:00.000Z" });
  expectOnlyTheDaemonCanOpen(cache, join(cache, "providers", "openrouter", "credentials.json"));
});

async function signIn(home: string, folder: string, name: string): Promise<void> {
  const dir = join(claudeAccountsRoot(home), folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.com` } }));
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: `token-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.now() + 3_600_000,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "pro",
  } }));
}

test("the Claude login in use and each login's plan limits are remembered in folders only the daemon can open", async () => {
  const home = testTmp(`provider-cache-home-${randomUUID()}`);
  const cache = freshCache();
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  const poll = { subscription_type: "max", five_hour: { percent_used: 10, resets_at: "2026-11-12T15:00:00Z" }, seven_day: null };
  configureClaudePlanLimits({ home, cacheDir: cache, fetch: () => Promise.resolve({ status: "ok", poll }) });
  const other = claudeAccounts().find((account) => account.name !== claudeAccountInUse().name)?.name ?? "";

  useClaudeAccount(other, "a test moved to it");
  expect(await refreshClaudeAccount(other)).toBe("ok");

  const inUse = claudeAccountInUsePath(cache);
  const limits = claudePlanLimitsPath(cache, other);
  expect((await readFile(inUse, "utf8")).trim()).toBe(other);
  expect(readClaudePlanLimits(limits)).toMatchObject(poll);
  expectOnlyTheDaemonCanOpen(cache, inUse);
  expectOnlyTheDaemonCanOpen(cache, limits);
});

function installAt(root: string): LoadedConfig {
  return {
    app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.fromSection(undefined), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
}

async function start(config: LoadedConfig): Promise<void> {
  const runtime = await createRuntime({ config, providers: {}, env: {} });
  await runtime.autonomy.shutdown();
  await runtime.shutdown();
}

test("a daemon starting on an empty cache makes the provider caches its own", async () => {
  const config = installAt(testTmp(`provider-cache-start-${randomUUID()}`));

  await start(config);

  expect(modeOf(join(config.dirs.cache, "providers"))).toBe("700");
});

test("a daemon starting where an older one left the provider caches open closes them to everyone but itself, and keeps what they hold", async () => {
  const config = installAt(testTmp(`provider-cache-start-${randomUUID()}`));
  const inUse = claudeAccountInUsePath(config.dirs.cache);
  await mkdir(join(inUse, ".."), { recursive: true, mode: 0o755 });
  await writeFile(inUse, "first@example.com\n", { mode: 0o644 });
  expect(modeOf(join(config.dirs.cache, "providers"))).toBe("755");

  await start(config);

  expect(modeOf(join(config.dirs.cache, "providers"))).toBe("700");
  expect(await readFile(inUse, "utf8")).toBe("first@example.com\n");
});
