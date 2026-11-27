import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as configCommands from "../src/commands/config.ts";
import { config, type ConfigContext } from "../src/commands/config.ts";
import {
  addCredential, addProvider, listProviderStatuses, orderCredentials, providerDetail, providerUsers, removeCredential, removeProvider,
  selectCredential, setCredentialLimit, testCredential, updateCredential, updateProvider, type ProviderAdminContext,
} from "../src/commands/provider_admin.ts";
import { loadConfig } from "../src/config/loader.ts";
import { characterPreferencesPath, emptyPreferences, globalPreferencesPath, saveCharacterPreferences, saveGlobalPreferences } from "../src/config/preferences.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { Ledger } from "../src/ledger/store.ts";
import { toCredentialsEntry } from "../src/config/providers.ts";
import { readCandidateEnv, resolveKeyCandidates } from "../src/llm/credentials.ts";
import { CACHE_VERSION, cachePath, writeCache } from "../src/llm/discovery.ts";
import { configureSecretStore, secretStoreFor } from "../src/llm/secret_store.ts";
import { configureCredentialStanding } from "../src/llm/credential_standing.ts";
import { openLedger } from "./support/ledger_fixture.ts";
import { outcomeOf } from "./support/outcome.ts";
import { GOOGLE_REJECTS_KEY } from "./support/google.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(() => {
  restoreTestEnv();
  configureSecretStore(undefined);
  configureCredentialStanding(undefined);
});

const SECRET = "sk-or-v1-0123456789abcdefWXYZ";

interface World { ctx: ProviderAdminContext; session: ConfigContext; configPath: string; seen: string[] }

type Answer = (url: URL) => Response | Promise<Response>;

const roster = (models = 2): Response => Response.json({ data: Array.from({ length: models }, (_, i) => ({ id: `m${String(i)}` })) });

function provider(status = 200, answer?: Answer): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    seen.push(`${url.toString()} ${headers.get("authorization") ?? headers.get("x-api-key") ?? headers.get("x-goog-api-key") ?? ""}`);
    if (answer !== undefined) return await answer(url);
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status });
    return roster();
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function world(toml: string, options: { status?: number; answer?: Answer; env?: Record<string, string> } = {}): Promise<World> {
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
  const { fetchImpl, seen } = provider(options.status ?? 200, options.answer);
  return { ctx: { config: session, fetchImpl }, session, configPath, seen };
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

  test("a key is checked against the endpoint its provider answers on, and only a clear answer is remembered", async () => {
    const at = (path: string, reply: () => Response): Answer => (url) => (url.pathname.endsWith(path) ? reply() : roster());
    const gemini = { models: [
      { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ] };
    const keyed = (url: string): string => `${url} ${SECRET}`;
    const bearer = (url: string): string => `${url} Bearer ${SECRET}`;
    const nano = '[providers.mygpt]\nsdk = "nanogpt"\nbase_url = "https://nano.example/api/v1"\n';
    const unsaved = "; the key wasn't saved. Skipping the check (--no-check) saves it";
    const rows: [string, string, Answer, string, string[], (string | null)[] | null][] = [
      ["[providers.gemini]\n", "gemini", () => Response.json(gemini), "works · 1 models",
        [keyed("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000")], ["1 models"]],
      ["[providers.gemini]\n", "gemini", () => Response.json(GOOGLE_REJECTS_KEY, { status: 400 }), `gemini rejected: HTTP 400${unsaved} anyway`,
        [keyed("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000")], null],
      ["[providers.anthropic]\n", "anthropic", () => roster(), "works · 2 models", [keyed("https://api.anthropic.com/v1/models")], ["2 models"]],
      ["[providers.openrouter]\n", "openrouter", at("/key", () => { throw new Error("connection reset"); }),
        `couldn't check: connection reset${unsaved} without asking`, [bearer("https://openrouter.ai/api/v1/key")], null],
      ["[providers.openrouter]\n", "openrouter", at("/key", () => Response.json({}, { status: 400 })),
        `couldn't check: provider openrouter: discovery HTTP 400${unsaved} without asking`, [bearer("https://openrouter.ai/api/v1/key")], null],
      [nano, "mygpt", at("/usage", () => Response.json({ active: true, state: "active" })), "works · 2 models",
        [bearer("https://nano.example/api/subscription/v1/usage"), bearer("https://nano.example/api/v1/models")], ["2 models"]],
      [nano, "mygpt", at("/usage", () => Response.json({}, { status: 401 })), `mygpt rejected: HTTP 401${unsaved} anyway`,
        [bearer("https://nano.example/api/subscription/v1/usage")], null],
      ['[providers.bare]\nsdk = "openai"\n', "bare", () => roster(), "not checked · not checked: this provider has no endpoint shore can ask", [], [null]],
    ];
    const outcomes: unknown[] = [];
    for (const [toml, name, answer] of rows) {
      const w = await world(toml, { answer });
      try {
        const added = await addCredential(w.ctx, { provider: name, name: "work", secret: SECRET });
        outcomes.push([added.message.slice(added.message.indexOf(" · ") + 3), w.seen, added.provider.credentials.map((c) => c.detail)]);
      } catch (e) {
        outcomes.push([e instanceof Error ? e.message : String(e), w.seen, null]);
      }
    }
    expect(outcomes).toEqual(rows.map(([, , , said, seen, details]) => [said, seen, details]));
  });

  test("a key the provider rejects is not saved", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { status: 401 });
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET }))).toThrow("rejected: HTTP 401");
    expect(await readFile(w.configPath, "utf8")).not.toContain("keys");
    expect(await outcomeOf(stat(join(w.session.config.dirs.data, "provider_secrets.json")))).toThrow();
    const unchecked = await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(unchecked.provider.credentials[0]?.standing).toBe("not_checked");
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

  test("a key that can't be added says why: no key needed, both or neither of a key and a variable, a name that won't do or is taken", async () => {
    const free = await world("[providers.openrouter]\nno_auth = true\n");
    expect(await outcomeOf(addCredential(free.ctx, { provider: "openrouter", secret: SECRET }))).toThrow("openrouter is set to need no key; turn that off first with `shore provider openrouter set no-auth false`");
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    for (const args of [{ provider: "openrouter" }, { provider: "openrouter", secret: SECRET, env: "SHORE_ADMIN_KEY" }]) {
      expect(await outcomeOf(addCredential(w.ctx, args))).toThrow("give the key itself or the name of an environment variable that holds it, not both");
    }
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "bad name", secret: SECRET, no_check: true }))).toThrow('key names use letters, digits, ., _, @ and -: "bad name"');
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "Work", secret: SECRET, no_check: true }))).toThrow('openrouter already has a key named "Work"; pick another name or replace it with `auth Work --replace`');
    expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "env", env: " 1BAD " }))).toThrow('" 1BAD " isn\'t an environment variable name');
  });

  test("a key read from a variable is named by it, trimmed, and says whether the daemon has it yet", async () => {
    unsetTestEnv("SHORE_ADMIN_UNSET_KEY");
    const w = await world("[providers.openrouter]\ndiscover = true\n", { env: { SHORE_ADMIN_EMPTY_KEY: "", SHORE_ADMIN_SET_KEY: SECRET } });
    const unset = await addCredential(w.ctx, { provider: "openrouter", name: "later", env: " SHORE_ADMIN_UNSET_KEY " });
    expect(unset.message).toContain('Added key "later" to openrouter, read from SHORE_ADMIN_UNSET_KEY, which isn\'t set on the daemon yet');
    expect(await readFile(w.configPath, "utf8")).toContain('api_key_env = "SHORE_ADMIN_UNSET_KEY"');
    const empty = await addCredential(w.ctx, { provider: "openrouter", name: "blank", env: "SHORE_ADMIN_EMPTY_KEY" });
    expect(empty.message).toContain("read from SHORE_ADMIN_EMPTY_KEY, which isn't set on the daemon yet");
    const set = await addCredential(w.ctx, { provider: "openrouter", name: "now", env: "SHORE_ADMIN_SET_KEY" });
    expect(set.message).toContain('Added key "now" to openrouter, read from SHORE_ADMIN_SET_KEY · works');
    const typed = await addCredential(w.ctx, { provider: "openrouter", name: "typed", secret: SECRET, no_check: true });
    expect(typed.message).toContain('Added key "typed" to openrouter, saved on the daemon (…WXYZ) · not checked');
  });

  test("a key whose config can't be written isn't kept, and a replacement whose config can't be written puts the old key back", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    const store = () => secretStoreFor(w.session.config.dirs.data);
    const failing = spyOn(configCommands, "commitConfigEdits").mockImplementation(() => { throw new Error("the config is read-only"); });
    try {
      expect(await outcomeOf(addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true }))).toThrow("the config is read-only");
    } finally { failing.mockRestore(); }
    expect(store().get("openrouter", "work")).toBeUndefined();
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    await addCredential(w.ctx, { provider: "openrouter", name: "lost", secret: `${SECRET}2`, no_check: true });
    store().remove("openrouter", "lost");
    const failingAgain = spyOn(configCommands, "commitConfigEdits").mockImplementation(() => { throw new Error("the config is read-only"); });
    try {
      for (const credential of ["work", "lost"]) expect(await outcomeOf(updateCredential(w.ctx, { provider: "openrouter", credential, secret: `${SECRET}9`, no_check: true }))).toThrow("the config is read-only");
    } finally { failingAgain.mockRestore(); }
    expect([store().get("openrouter", "work"), store().get("openrouter", "lost")]).toEqual([SECRET, undefined]);
  });

  test("changing a key says what changed: on or off, how it moves on, its name, its pin and its value", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET });
    await addCredential(w.ctx, { provider: "openrouter", name: "home", secret: `${SECRET}2`, no_check: true });
    selectCredential(w.ctx, { provider: "openrouter", credential: "home" });
    const change = async (args: Omit<Parameters<typeof updateCredential>[1], "provider">) => (await updateCredential(w.ctx, { provider: "openrouter", ...args })).message;
    expect(await change({ credential: "work", enabled: false })).toBe('openrouter key "work": disabled');
    expect(await change({ credential: "work", enabled: true })).toBe('openrouter key "work": enabled');
    expect(await change({ credential: "home", enabled: true })).toBe('openrouter key "home": enabled');
    expect(await change({ credential: "work", warn_on_fallback: true })).toBe('openrouter key "work": warns when calls move past it');
    expect(await readFile(w.configPath, "utf8")).toContain("warn_on_fallback = true");
    expect(await change({ credential: "work", warn_on_fallback: false })).toBe('openrouter key "work": moves on quietly');
    expect(await readFile(w.configPath, "utf8")).toContain("warn_on_fallback = false");
    expect(await outcomeOf(change({ credential: "work", rename: "no good" }))).toThrow('key names use letters, digits, ., _, @ and -: "no good"');
    expect(await outcomeOf(change({ credential: "work", rename: "HOME" }))).toThrow('openrouter already has a key named "HOME"');
    expect(await change({ credential: "work", rename: "work" })).toBe('openrouter key "work": renamed to "work" (earlier usage stays under "work")');
    const renamed = await updateCredential(w.ctx, { provider: "openrouter", credential: "work", rename: "office" });
    expect([renamed.provider.pinned, renamed.provider.credentials.find((c) => c.name === "office")?.standing]).toEqual(["home", "works"]);
    expect(await change({ credential: "home", enabled: false })).toBe('openrouter key "home": disabled, no longer pinned');
    expect(await outcomeOf(change({ credential: "office" }))).toThrow("nothing to change");
  });

  test("a replaced key is checked unless told not to, and what is known of it follows the check", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET });
    const standing = () => providerDetail(w.ctx, { provider: "openrouter" }).credentials[0]?.standing;
    expect(standing()).toBe("works");
    const asked = w.seen.length;
    const unchecked = await updateCredential(w.ctx, { provider: "openrouter", credential: "work", secret: `${SECRET}2`, no_check: true });
    expect([unchecked.message, w.seen.length, standing(), secretStoreFor(w.session.config.dirs.data).get("openrouter", "work")]).toEqual(['openrouter key "work": key replaced (…XYZ2) · not checked', asked, "not_checked", `${SECRET}2`]);
    const checked = await updateCredential(w.ctx, { provider: "openrouter", credential: "work", secret: SECRET });
    expect([checked.message.startsWith('openrouter key "work": key replaced (…WXYZ) · works'), w.seen.length > asked, standing()]).toEqual([true, true, "works"]);
    const rejecting = await world("[providers.openrouter]\ndiscover = true\n", { status: 401 });
    await addCredential(rejecting.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(await outcomeOf(updateCredential(rejecting.ctx, { provider: "openrouter", credential: "work", secret: `${SECRET}3` }))).toThrow("the key wasn't replaced. Skipping the check (--no-check) replaces it anyway");
    expect(secretStoreFor(rejecting.session.config.dirs.data).get("openrouter", "work")).toBe(SECRET);
  });

  test("a spend limit is a budget for that key alone, and stays out of the reported budgets", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n");
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    const limited = setCredentialLimit(w.ctx, { provider: "openrouter", credential: "work", cost_usd: 20, period: "week" });
    expect(limited.provider.credentials[0]?.limit).toMatchObject({ cost_usd: 20, period: "week" });
    expect(w.session.config.app.budgets.map((b) => ({ provider: b.provider, api_key: b.api_key, cost_usd: b.cost_usd, period: b.period, limit_action: b.limit_action })))
      .toEqual([{ provider: "openrouter", api_key: "work", cost_usd: 20, period: "week", limit_action: "block" }]);
    expect((config(w.session, { key: "budgets" }) as { config: unknown }).config).toEqual([]);
    expect(await readFile(w.configPath, "utf8")).toContain("spend_limit_usd = 20.0\nspend_period = \"week\"");
    setCredentialLimit(w.ctx, { provider: "openrouter", credential: "work", cost_usd: null });
    expect(w.session.config.app.budgets).toEqual([]);
  });

  test("each key's spending limit reports that key's own spend, whatever other budgets and other providers' keys there are", async () => {
    const w = await world([
      "[providers.openrouter]", "[[providers.openrouter.keys]]", 'name = "work"', 'api_key_env = "SHORE_TEST_OR_WORK"', "spend_limit_usd = 20",
      "[[providers.openrouter.keys]]", 'name = "home"', 'api_key_env = "SHORE_TEST_OR_HOME"', "spend_limit_usd = 20",
      "[providers.deepseek]", "[[providers.deepseek.keys]]", 'name = "work"', 'api_key_env = "SHORE_TEST_DS_WORK"', "spend_limit_usd = 5",
      "[[budgets]]", 'name = "nobody"', "cost_usd = 1", 'period = "month"', 'provider = "openrouter"', 'api_key = "work"', 'character = "nobody"', "",
    ].join("\n"));
    const ledgerPath = join(w.session.config.dirs.data, "ledger.db");
    Ledger.create(ledgerPath).close();
    const db = openLedger(ledgerPath);
    for (const [spender, key, cost] of [["openrouter", "work", 3], ["openrouter", "home", 1], ["deepseek", "work", 7]] as const) {
      db.query(
        `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
         VALUES (?1, 'ada', ?2, ?3, 'm', 'message', 10, 5, 0, 0, 100, 10, 'end_turn', 0, 'pricing_catalog', ?4)`,
      ).run(new Date().toISOString(), spender, key, cost);
    }
    db.close();
    try {
      const spent = listProviderStatuses({ ...w.ctx, ledgerPath }).providers.flatMap((status) =>
        status.credentials.map((credential) => [status.name, credential.name, credential.limit?.spent_usd, credential.limit?.at_limit]));
      expect(spent).toEqual([["deepseek", "work", 7, true], ["openrouter", "work", 3, false], ["openrouter", "home", 1, false]]);
    } finally {
      closeLedgers();
    }
  });

  test("testing a key records what the provider said", async () => {
    const w = await world("[providers.openrouter]\ndiscover = true\n", { status: 401 });
    await addCredential(w.ctx, { provider: "openrouter", name: "work", secret: SECRET, no_check: true });
    expect(await testCredential(w.ctx, { provider: "openrouter", credential: "work" })).toMatchObject({ ok: false, standing: "invalid" });
    expect(providerDetail(w.ctx, { provider: "openrouter" }).credentials[0]?.standing).toBe("invalid");
  });
});

describe("keys read from the daemon's environment", () => {
  const TOML = [
    "[providers.deepseek]", "[providers.openrouter]", "[[providers.openrouter.keys]]", 'name = "ci"', 'api_key_env = "SHORE_TEST_UNSET_OPENROUTER_KEY"',
    "[[providers.openrouter.keys]]", 'name = "saved"', "",
  ].join("\n");

  test("a provider with no keys of its own says which variable it reads, and a key that reads a variable says to change it there", async () => {
    const w = await world(TOML);
    expect(await outcomeOf(updateCredential(w.ctx, { provider: "deepseek", credential: "work", enabled: false }))).toThrow(
      "deepseek has no keys of its own yet; it reads DEEPSEEK_API_KEY from the daemon's environment. Add one with `shore provider deepseek auth --add`",
    );
    expect(await outcomeOf(updateCredential(w.ctx, { provider: "openrouter", credential: "work", enabled: false }))).toThrow(
      'openrouter has no key named "work"; its keys are ci, saved',
    );
    expect(await outcomeOf(updateCredential(w.ctx, { provider: "openrouter", credential: "ci", secret: SECRET, no_check: true }))).toThrow(
      '"ci" reads SHORE_TEST_UNSET_OPENROUTER_KEY from the daemon\'s environment; change it there, or remove it and add the key itself',
    );
    const replaced = await updateCredential(w.ctx, { provider: "openrouter", credential: "saved", secret: SECRET, no_check: true });
    expect(replaced.provider.credentials.map((credential) => [credential.name, credential.kind, credential.env])).toEqual([["ci", "env", "SHORE_TEST_UNSET_OPENROUTER_KEY"], ["saved", "api_key", null]]);
  });

  test("testing a key that has nothing behind it says what is missing without asking the provider", async () => {
    const w = await world(TOML);
    expect(await testCredential(w.ctx, { provider: "openrouter", credential: "ci" })).toEqual({
      provider: "openrouter", credential: "ci", ok: false, standing: "missing", detail: "SHORE_TEST_UNSET_OPENROUTER_KEY is not set on the daemon", model_count: null,
    });
    expect(await testCredential(w.ctx, { provider: "openrouter", credential: "saved" })).toEqual({
      provider: "openrouter", credential: "saved", ok: false, standing: "missing", detail: "no key saved on the daemon", model_count: null,
    });
    expect(w.seen).toEqual([]);
  });

  test("a provider's status shows the variable it reads when it has no keys of its own, and what each key is missing", async () => {
    const w = await world(TOML);
    const shown = (name: string): unknown[] => providerDetail(w.ctx, { provider: name }).credentials.map((credential) =>
      [credential.name, credential.kind, credential.enabled, credential.standing, credential.detail, credential.env, credential.in_use, credential.warn_on_fallback]);
    unsetTestEnv("DEEPSEEK_API_KEY");
    expect(shown("deepseek")).toEqual([["default", "env", true, "missing", "DEEPSEEK_API_KEY is not set on the daemon", "DEEPSEEK_API_KEY", false, false]]);
    setTestEnv("DEEPSEEK_API_KEY", "sk-ds-env-0000000000003");
    expect(shown("deepseek")).toEqual([["default", "env", true, "not_checked", null, "DEEPSEEK_API_KEY", true, false]]);
    expect(shown("openrouter")).toEqual([
      ["ci", "env", true, "missing", "SHORE_TEST_UNSET_OPENROUTER_KEY is not set on the daemon", "SHORE_TEST_UNSET_OPENROUTER_KEY", false, false],
      ["saved", "api_key", true, "missing", "no key saved on the daemon", null, false, false],
    ]);
  });

  test("removing a provider's last key says which variable it reads from then on", async () => {
    const w = await world('[providers.openrouter]\n[[providers.openrouter.keys]]\nname = "a"\napi_key_env = "SHORE_TEST_KEY_A"\n[[providers.openrouter.keys]]\nname = "b"\napi_key_env = "SHORE_TEST_KEY_B"\n');
    expect(removeCredential(w.ctx, { provider: "openrouter", credential: "a" }).message).toBe('Removed key "a" from openrouter');
    expect(removeCredential(w.ctx, { provider: "openrouter", credential: "b" }).message)
      .toBe('Removed key "b" from openrouter; openrouter now reads OPENROUTER_API_KEY from the daemon\'s environment');
  });

  test("a provider's status counts the models it has found and how many of them ignore_models hides", async () => {
    const w = await world('[providers.openrouter]\ndiscover = true\nignore_models = ["tucked-*"]\n[providers.deepseek]\n');
    await writeCache(cachePath(w.session.config.dirs.cache, "openrouter"), {
      version: CACHE_VERSION, provider_key: "openrouter", fetched_at: "2026-11-12T10:00:00Z",
      models: ["open-a", "open-b", "tucked-away"].map((id) => ({ provider_key: "openrouter", model_id: id, sdk: "openai", discovered_at: "2026-11-12T10:00:00Z" })),
    });
    expect(providerDetail(w.ctx, { provider: "openrouter" })).toMatchObject({
      discovery_enabled: true, ignore_models: ["tucked-*"], cache: { present: true, models: 3, visible: 2, hidden: 1, fetched_at: "2026-11-12T10:00:00Z" },
    });
    expect(providerDetail(w.ctx, { provider: "deepseek" })).toMatchObject({
      discovery_enabled: false, ignore_models: [], cache: { present: false, models: 0, visible: 0, hidden: 0, fetched_at: null },
    });
  });

  test("turning no_auth off says keys are needed again and takes the line out of the file", async () => {
    const w = await world('[providers.local]\nsdk = "openai"\nbase_url = "http://127.0.0.1:9/v1"\nno_auth = true\n');
    expect(updateProvider(w.ctx, { provider: "local", base_url: "http://127.0.0.1:8/v1" }).message).toBe("local: base url http://127.0.0.1:8/v1");
    expect(updateProvider(w.ctx, { provider: "local", no_auth: false }).message).toBe("local: keys needed again");
    expect(await readFile(w.configPath, "utf8")).toBe('[providers.local]\nsdk = "openai"\nbase_url = "http://127.0.0.1:8/v1"\n');
  });
});

describe("removing providers", () => {
  test("a provider still in use is not removed, and the refusal names what uses it", async () => {
    const w = await world("[chat]\nmodel = \"openrouter:anthropic/claude\"\n\n[providers.openrouter]\ndiscover = true\n");
    expect(() => removeProvider(w.ctx, { provider: "openrouter" })).toThrow("chat.model (openrouter:anthropic/claude)");
  });

  test("what uses a provider is every config, character overlay, character's pick, live thread and default pick that names it, each once, and anything that can't be read", async () => {
    const w = await world('[chat]\nmodel = "x:y"\n\n[triggers]\nmodel = "openrouter:t"\n\n[providers.openrouter]\ndiscover = true\n');
    const configDir = w.session.config.dirs.config;
    const data = w.session.config.dirs.data;
    const overlay = async (character: string, toml: string) => {
      await mkdir(join(configDir, "characters", character), { recursive: true });
      await writeFile(join(configDir, "characters", character, "config.toml"), toml);
    };
    await overlay("ada", '[chat]\nmodel = "openrouter:a"\n');
    await overlay("bo", '[triggers]\nmodel = "openrouter:t"\n\n[image]\nmodel = "openrouter:i"\n');
    await overlay("cy", "[chat\n");
    await mkdir(join(configDir, "characters", "dee"), { recursive: true });
    saveCharacterPreferences(data, "ada", { ...emptyPreferences(), selected: { provider: "openrouter", modelId: "m" } });
    saveCharacterPreferences(data, "bo", { ...emptyPreferences(), selected: { provider: "deepseek", modelId: "chat" } });
    await mkdir(join(data, "dee", "preferences"), { recursive: true });
    await writeFile(characterPreferencesPath(data, "dee"), "[selected\n");
    saveGlobalPreferences(data, { ...emptyPreferences(), selected: { provider: "openrouter", modelId: "d" } });
    const threads: Record<string, { id: string; chat_model?: string; archived?: boolean }[]> = {
      ada: [{ id: "main" }, { id: "story", chat_model: "openrouter:s" }, { id: "old", chat_model: "openrouter:o", archived: true }, { id: "other", chat_model: "deepseek:chat" }],
      cy: [{ id: "lamp", chat_model: "openrouter:c" }],
      dee: [{ id: "ring", chat_model: "openrouter:r" }],
    };
    const ctx = { ...w.ctx, threads: { listThreads: (character: string) => threads[character] ?? [] } };

    expect(providerUsers(ctx, "openrouter")).toEqual([
      "triggers.model (openrouter:t)",
      "ada's chat.model (openrouter:a)",
      "ada's model (openrouter:m)",
      "ada's thread story (openrouter:s)",
      "bo's image.model (openrouter:i)",
      "cy's config, which can't be read",
      "cy's thread lamp (openrouter:c)",
      "dee's model preferences, which can't be read",
      "dee's thread ring (openrouter:r)",
      "the default model (openrouter:d)",
    ]);
    await writeFile(globalPreferencesPath(data), "[selected\n");
    expect(providerUsers(ctx, "openrouter").slice(-3)).toEqual(["dee's model preferences, which can't be read", "dee's thread ring (openrouter:r)", "the default model preferences, which can't be read"]);
  });

  test("a provider only sub-agents run on is still in use", async () => {
    const w = await world("[subagents]\nmodel = \"openrouter:anthropic/claude\"\n\n[providers.openrouter]\ndiscover = true\n");
    expect(() => removeProvider(w.ctx, { provider: "openrouter" })).toThrow("subagents.model (openrouter:anthropic/claude)");
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
