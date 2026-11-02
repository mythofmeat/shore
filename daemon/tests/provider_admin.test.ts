import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config, type ConfigContext } from "../src/commands/config.ts";
import {
  addCredential, addProvider, listProviderStatuses, orderCredentials, providerDetail, removeCredential, removeProvider,
  selectCredential, setCredentialLimit, testCredential, updateCredential, type ProviderAdminContext,
} from "../src/commands/provider_admin.ts";
import { loadConfig } from "../src/config/loader.ts";
import { toCredentialsEntry } from "../src/config/providers.ts";
import { readCandidateEnv, resolveKeyCandidates } from "../src/llm/credentials.ts";
import { configureSecretStore } from "../src/llm/secret_store.ts";
import { configureCredentialStanding } from "../src/llm/credential_standing.ts";
import { outcomeOf } from "./support/outcome.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(() => {
  restoreTestEnv();
  configureSecretStore(undefined);
  configureCredentialStanding(undefined);
});

const SECRET = "sk-or-v1-0123456789abcdefWXYZ";

interface World { ctx: ProviderAdminContext; session: ConfigContext; configPath: string; seen: string[] }

function provider(status = 200, models = 2): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${input instanceof Request ? input.url : input.toString()} ${new Headers(init?.headers).get("authorization") ?? ""}`);
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status });
    return new Response(JSON.stringify({ data: Array.from({ length: models }, (_, i) => ({ id: `m${String(i)}` })) }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function world(toml: string, options: { confidential?: boolean; status?: number; env?: Record<string, string> } = {}): Promise<World> {
  const root = await mkdtemp(testTmp("shore-provider-admin-"));
  const configPath = join(root, "config", "config.toml");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(configPath, toml);
  const env = {
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: join(root, "data-home"), XDG_CACHE_HOME: join(root, "cache-home"), XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  for (const [name, value] of Object.entries(options.env ?? {})) setTestEnv(name, value);
  const loaded = loadConfig(configPath, { env, onWarn: () => {} });
  await mkdir(loaded.dirs.data, { recursive: true });
  configureSecretStore(loaded.dirs.data);
  configureCredentialStanding(loaded.dirs.cache);
  const session: ConfigContext = {
    config: loaded, configPath, characterName: undefined, activeModel: undefined, env,
    runtime: { reloadRuntimeConfig: () => {}, adoptGlobalConfig: () => {}, notifyPromptSnapshotRefreshed: () => {} },
  };
  const { fetchImpl, seen } = provider(options.status ?? 200);
  return { ctx: { config: session, fetchImpl, confidential: options.confidential ?? true }, session, configPath, seen };
}

const usedKey = (w: World, name: string): string | undefined => {
  const entry = w.session.config.providers.get(name);
  const [first] = resolveKeyCandidates(name, entry === undefined ? undefined : toCredentialsEntry(entry));
  return first === undefined ? undefined : readCandidateEnv(first);
};

describe("adding providers", () => {
  test("a known provider needs only its name and is usable at once", async () => {
    const w = await world("[chat]\nmodel = \"x:y\"\n");
    const added = addProvider(w.ctx, { name: "openrouter" });
    expect(added.provider.name).toBe("openrouter");
    expect(added.provider.sdk).toBe("openrouter");
    expect(added.provider.discovery_enabled).toBe(true);
    expect(w.session.config.providers.get("openrouter")).toBeDefined();
    expect(await readFile(w.configPath, "utf8")).toBe("[chat]\nmodel = \"x:y\"\n\n[providers.openrouter]\ndiscover = true\n");
  });

  test("a provider of the user's own needs an sdk and, for openai, a base url", async () => {
    const w = await world("");
    expect(() => addProvider(w.ctx, { name: "local" })).toThrow("no preset");
    expect(() => addProvider(w.ctx, { name: "local", sdk: "openai" })).toThrow("needs a base url");
    const added = addProvider(w.ctx, { name: "local", sdk: "openai", base_url: "http://localhost:11434/v1/", no_auth: true });
    expect(added.provider.base_url).toBe("http://localhost:11434/v1");
    expect(await readFile(w.configPath, "utf8")).toContain("[providers.local]\nsdk = \"openai\"\nbase_url = \"http://localhost:11434/v1\"\n");
    expect(added.provider.credentials.map((c) => c.kind)).toEqual(["none"]);
    expect(usedKey(w, "local")).toBe("");
  });

  test("command words and names taken with - and _ swapped are refused", async () => {
    const w = await world("[providers.opencode-go]\ndiscover = true\n");
    for (const name of ["add", "models", "refresh"]) expect(() => addProvider(w.ctx, { name })).toThrow("is a command");
    expect(() => addProvider(w.ctx, { name: "opencode_go" })).toThrow("already configured");
    expect(providerDetail(w.ctx, { provider: "opencode_go" }).name).toBe("opencode-go");
  });
});

describe("keys", () => {
  test("a key typed into shore is checked, kept out of the config and shown only by its last four characters", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    const added = await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: ` ${SECRET}\n` });
    expect(added.message).toContain("works · 2 models");
    expect(w.seen.every((line) => line.endsWith(`Bearer ${SECRET}`))).toBe(true);
    const text = await readFile(w.configPath, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[[providers.openrouter.keys]]\nname = \"work\"\n");
    const file = join(w.session.config.dirs.data, "provider_secrets.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(SECRET);
    const [work] = added.provider.credentials;
    expect(work).toMatchObject({ name: "work", kind: "api_key", standing: "works", hint: "…WXYZ", env: null, in_use: true });
    expect(JSON.stringify(listProviderStatuses(w.ctx))).not.toContain(SECRET);
    expect(JSON.stringify(config(w.session, {}))).not.toContain(SECRET);
    expect(usedKey(w, "openrouter")).toBe(SECRET);
  });

  test("a key the provider rejects is not saved", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { status: 401 });
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET }))).toThrow("rejected: HTTP 401");
    expect(await readFile(w.configPath, "utf8")).not.toContain("keys");
    expect(await outcomeOf(stat(join(w.session.config.dirs.data, "provider_secrets.json")))).toThrow();
    const unchecked = await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(unchecked.provider.credentials[0]?.standing).toBe("not_checked");
  });

  test("a key won't cross a connection that is neither local nor encrypted unless the user says the network is private", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { confidential: false });
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", secret: SECRET }))).toThrow("neither on this machine nor encrypted");
    const env = await addCredential(w.ctx, { provider: "openrouter", name: "ci", env: "OPENROUTER_CI_KEY", no_check: true });
    expect(env.provider.credentials[0]).toMatchObject({ name: "ci", kind: "env", env: "OPENROUTER_CI_KEY", standing: "missing" });
    const allowed = await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, allow_unencrypted: true });
    expect(allowed.provider.credentials.map((c) => c.name)).toEqual(["ci", "work"]);
  });

  test("a second key keeps the environment key first, and order, pin and removal all change which key calls use", async () => {
    const w = await world("[providers.deepseek]\napi_key_env = \"SHORE_PROVIDER_ADMIN_DEEPSEEK_KEY\"\n", { env: { SHORE_PROVIDER_ADMIN_DEEPSEEK_KEY: "sk-env-key-0000000001" } });
    await addCredential(w.ctx, { provider: "deepseek", name: "spare", secret: SECRET, no_check: true });
    expect(w.session.config.providers.get("deepseek")?.keys.map((k) => k.name)).toEqual(["default", "spare"]);
    expect(usedKey(w, "deepseek")).toBe("sk-env-key-0000000001");

    orderCredentials(w.ctx, { provider: "deepseek", order: ["spare"] });
    expect(w.session.config.providers.get("deepseek")?.keys.map((k) => k.name)).toEqual(["spare", "default"]);
    expect(usedKey(w, "deepseek")).toBe(SECRET);

    const pinned = selectCredential(w.ctx, { provider: "deepseek", credential: "default" });
    expect(pinned.provider.pinned).toBe("default");
    const entry = w.session.config.providers.get("deepseek");
    expect(resolveKeyCandidates("deepseek", entry === undefined ? undefined : toCredentialsEntry(entry)).map((c) => c.name)).toEqual(["default"]);

    const removed = removeCredential(w.ctx, { provider: "deepseek", credential: "default" });
    expect(removed.provider.pinned).toBeNull();
    expect(usedKey(w, "deepseek")).toBe(SECRET);
    expect(await readFile(w.configPath, "utf8")).not.toContain("pin");
  });

  test("a key added to a provider already reading its default variable goes after it, under a name of its own", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { env: { OPENROUTER_API_KEY: "sk-or-env-0000000000001" } });
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "default", secret: SECRET, no_check: true }))).toThrow("reads from OPENROUTER_API_KEY");
    const added = await addCredential(w.ctx, { provider: "openrouter", secret: SECRET, no_check: true });
    expect(added.provider.credentials.map((c) => [c.name, c.kind])).toEqual([["default", "env"], ["key2", "api_key"]]);
    expect(usedKey(w, "openrouter")).toBe("sk-or-env-0000000000001");
  });

  test("renaming a stored key keeps its value, and disabling the pinned key unpins it", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    await addCredential(w.ctx, { provider: "openrouter", name: "home", secret: `${SECRET}2`, no_check: true });
    selectCredential(w.ctx, { provider: "openrouter", credential: "work" });
    const renamed = await updateCredential(w.ctx, { provider: "openrouter", credential: "work", rename: "office" });
    expect(renamed.provider.pinned).toBe("office");
    expect(usedKey(w, "openrouter")).toBe(SECRET);
    const disabled = await updateCredential(w.ctx, { provider: "openrouter", credential: "office", enabled: false });
    expect(disabled.provider.pinned).toBeNull();
    expect(usedKey(w, "openrouter")).toBe(`${SECRET}2`);
  });

  test("a spend limit is a budget for that key alone, and stays out of the reported budgets", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    const limited = setCredentialLimit(w.ctx, { provider: "openrouter", credential: "work", cost_usd: 20, period: "week" });
    expect(limited.provider.credentials[0]?.limit).toMatchObject({ cost_usd: 20, period: "week" });
    expect(w.session.config.app.usage.budgets.map((b) => ({ provider: b.provider, api_key: b.api_key, cost_usd: b.cost_usd, period: b.period, limit: b.limit })))
      .toEqual([{ provider: "openrouter", api_key: "work", cost_usd: 20, period: "week", limit: "block" }]);
    expect((config(w.session, { key: "budgets" }) as { config: unknown }).config).toEqual([]);
    expect(await readFile(w.configPath, "utf8")).toContain("spend_limit_usd = 20.0\nspend_period = \"week\"");
    setCredentialLimit(w.ctx, { provider: "openrouter", credential: "work", cost_usd: null });
    expect(w.session.config.app.usage.budgets).toEqual([]);
  });

  test("testing a key records what the provider said", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { status: 401 });
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(await testCredential(w.ctx, { provider: "openrouter", credential: "work" })).toMatchObject({ ok: false, standing: "invalid" });
    expect(providerDetail(w.ctx, { provider: "openrouter" }).credentials[0]?.standing).toBe("invalid");
  });
});

describe("removing providers", () => {
  test("a provider still in use is not removed, and the refusal names what uses it", async () => {
    const w = await world("[chat]\nmodel = \"openrouter:anthropic/claude\"\n\n[providers.openrouter]\ndiscover = true\n");
    expect(() => removeProvider(w.ctx, { provider: "openrouter" })).toThrow("chat.model (openrouter:anthropic/claude)");
  });

  test("removing a provider takes its tables, keys and limits with it and leaves the rest of the file alone", async () => {
    const w = await world("# mine\n[chat]\nmodel = \"x:y\"\n\n[providers.openrouter]\ndiscover = true\nmax_output_tokens = 4096\n\n[providers.deepseek]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    setCredentialLimit(w.ctx, { provider: "openrouter", credential: "work", cost_usd: 5 });
    const removed = removeProvider(w.ctx, { provider: "openrouter" });
    expect(removed).toMatchObject({ provider: "openrouter", keys_removed: 1, limits_removed: 1 });
    expect(await readFile(w.configPath, "utf8")).toBe("# mine\n[chat]\nmodel = \"x:y\"\n\n[providers.deepseek]\ndiscover = true\n");
    expect(w.session.config.providers.get("openrouter")).toBeUndefined();
    expect(await readFile(join(w.session.config.dirs.data, "provider_secrets.json"), "utf8")).not.toContain(SECRET);
  });
});
