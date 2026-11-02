import { budgetStatuses, usageConfigView } from "../ledger/budget.ts";
import { ledgerFor } from "../ledger/record.ts";
import { usageSummaryBy } from "../ledger/query.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { claudeAccountReports } from "../ledger/plan_limits.ts";
import { discoverCharacters } from "../config/dirs.ts";
import { loadCharacterConfig, type LoadedConfig } from "../config/loader.ts";
import { defaultSdk, hardcodedProviderDefaults } from "../config/models.ts";
import { loadForCharacter } from "../config/preferences.ts";
import { findProviderName, isCredentialBudget, isVisible, SPEND_PERIODS, type ProviderEntry, type ProviderKeyEntry } from "../config/providers.ts";
import { findSchemaEntry } from "../config/schema.ts";
import { schemaValueLiteral, SchemaValueError } from "../config/schema_value.ts";
import { parseConfigPath } from "../config/surface.ts";
import {
  appendTomlArrayTable,
  removeTomlArrayTable,
  removeTomlTable,
  reorderTomlArrayTables,
  setTomlArrayTableValue,
  setTomlValue,
  tomlDefinesTable,
  tomlKeyDefined,
  unsetTomlArrayTableValue,
  unsetTomlValue,
} from "../config/toml_edit.ts";
import { classifyCredentialFailure, defaultApiKeyEnv, isKeylessSdk } from "../llm/credentials.ts";
import { credentialStanding, forgetCredentialStanding, noteCredentialStanding } from "../llm/credential_standing.ts";
import { cachePath, discoverAnthropic, discoverOpenAiCompatible, describeDiscoveryError, readCacheSync, type DiscoveryResult } from "../llm/discovery.ts";
import { fetchNanoGptSubscription } from "../llm/nanogpt_subscription.ts";
import { isNanoGptProvider } from "../llm/providers/nanogpt_config.ts";
import { defaultBaseUrl } from "../llm/request.ts";
import { secretStoreFor } from "../llm/secret_store.ts";
import { SDK_VARIANTS, sdkFromWire } from "../llm/types.ts";
import { commitConfigEdits, configFiles, readConfigFile, schemaOf, type ConfigContext } from "./config.ts";
import { invalidRequest, notFound } from "./errors.ts";
import type { CredentialKind } from "../protocol/CredentialKind.ts";
import type { CredentialStanding } from "../protocol/CredentialStanding.ts";
import type { CredentialStatus } from "../protocol/CredentialStatus.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { ProviderStatus } from "../protocol/ProviderStatus.ts";

export interface ProviderAdminContext {
  config: ConfigContext;
  fetchImpl?: typeof fetch;
  ledgerPath?: string | undefined;
  threads?: { listThreads(character: string): readonly { id: string; chat_model?: string; archived?: boolean }[] } | undefined;
  confidential: boolean;
  now?: () => number;
}

export const RESERVED_PROVIDER_NAMES: readonly string[] = ["add", "models", "refresh", "help"];

const PRESETS: readonly string[] = [
  "anthropic", "openrouter", "openai", "deepseek", "moonshotai", "gemini", "xai", "zhipuai", "zai-api", "zai-sub", "nanogpt", "opencode-go", "claude_agent",
];

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const toml = (value: string): string => JSON.stringify(value);
const tomlNumber = (value: number): string => (Number.isInteger(value) ? `${String(value)}.0` : String(value));
const providerPath = (name: string): string[] => ["providers", name];
const keysPath = (name: string): string[] => ["providers", name, "keys"];

function now(ctx: ProviderAdminContext): number {
  return ctx.now?.() ?? Date.now();
}

function presetOf(name: string) {
  const fields = hardcodedProviderDefaults(name).fields;
  const sdk = fields.sdk ?? defaultSdk(name);
  return {
    sdk,
    baseUrl: fields.baseUrl ?? defaultBaseUrl(name),
    apiKeyEnv: isKeylessSdk(sdk) ? undefined : fields.apiKeyEnv ?? defaultApiKeyEnv(name),
  };
}

export function providerPresets(ctx: { config: LoadedConfig }): OperationResult<"provider_presets"> {
  const configured = ctx.config.providers.entries().map(([name]) => name);
  return {
    presets: PRESETS.map((name) => {
      const preset = presetOf(name);
      return {
        name,
        sdk: preset.sdk,
        base_url: preset.baseUrl ?? null,
        credential_kind: isKeylessSdk(preset.sdk) ? "login" : "api_key",
        api_key_env: preset.apiKeyEnv ?? null,
        discover: true,
        configured: findProviderName(configured, name) !== undefined,
      };
    }),
    sdks: [...SDK_VARIANTS],
  };
}

function resolveProvider(config: LoadedConfig, raw: string): { name: string; entry: ProviderEntry } {
  const names = config.providers.entries().map(([name]) => name);
  const name = findProviderName(names, raw.trim());
  const entry = name === undefined ? undefined : config.providers.get(name);
  if (name === undefined || entry === undefined) {
    const known = names.length === 0 ? "none are configured yet" : `configured: ${names.join(", ")}`;
    throw notFound(`no provider named ${JSON.stringify(raw)} (${known}); add one with \`shore provider add ${raw}\``);
  }
  return { name, entry };
}

function providerFile(ctx: ConfigContext, name: string): string {
  for (const file of [...configFiles(ctx)].reverse()) {
    if (tomlDefinesTable(readConfigFile(file), providerPath(name))) return file;
  }
  return ctx.configPath;
}

function lastFour(secret: string | undefined): string | null {
  if (secret === undefined) return null;
  const trimmed = secret.trim();
  return trimmed.length >= 12 ? `…${trimmed.slice(-4)}` : "…";
}

function sdkOf(name: string, entry: ProviderEntry) {
  return entry.sdk ?? defaultSdk(name);
}

interface KeyView {
  key: ProviderKeyEntry;
  explicit: boolean;
}

function keysOf(name: string, entry: ProviderEntry): KeyView[] {
  if (entry.keys.length > 0) return entry.keys.map((key) => ({ key, explicit: true }));
  const env = hardcodedProviderDefaults(name).fields.apiKeyEnv ?? defaultApiKeyEnv(name);
  return [{ key: { name: "default", env, stored: false, enabled: true, warnOnFallback: false }, explicit: false }];
}

function secretOf(ctx: ProviderAdminContext, provider: string, key: ProviderKeyEntry): string | undefined {
  if (key.stored) return secretStoreFor(ctx.config.config.dirs.data).get(provider, key.name);
  const value = process.env[key.env];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function loginStanding(state: string, detail: string): CredentialStanding {
  if (state === "ok") return "works";
  if (state === "limited") return "over_quota";
  if (state === "out") return detail === "not logged in" ? "signed_out" : "invalid";
  return "not_checked";
}

function usageByKey(ctx: ProviderAdminContext, provider: string): Map<string, { cost_usd: number; calls: number; since: string }> {
  const out = new Map<string, { cost_usd: number; calls: number; since: string }>();
  const ledger = ctx.ledgerPath === undefined ? null : ledgerFor(ctx.ledgerPath);
  if (ledger === null) return out;
  const since = toRfc3339(now(ctx) - USAGE_WINDOW_MS);
  try {
    for (const row of usageSummaryBy(ledger.database, { provider, since }, "api_key")) {
      const key = row.group.slice(provider.length + 1);
      out.set(key, { cost_usd: row.total_cost, calls: row.call_count, since });
    }
  } catch {
    return out;
  }
  return out;
}

function limitOf(ctx: ProviderAdminContext, provider: string, key: ProviderKeyEntry): CredentialStatus["limit"] {
  if (key.spendLimit === undefined) return null;
  const budget = ctx.config.config.app.usage.budgets.find((b) => isCredentialBudget(b) && b.provider === provider && b.api_key === key.name);
  const ledger = ctx.ledgerPath === undefined ? null : ledgerFor(ctx.ledgerPath);
  if (budget === undefined || ledger === null) {
    return { cost_usd: key.spendLimit.costUsd, period: key.spendLimit.period, spent_usd: 0, at_limit: false, resets_at: toRfc3339(now(ctx)) };
  }
  const usage = ctx.config.config.app.usage;
  const [status] = budgetStatuses(ledger.database, usageConfigView({ ...usage, budgets: [budget] }), now(ctx));
  return {
    cost_usd: key.spendLimit.costUsd,
    period: key.spendLimit.period,
    spent_usd: status?.current_cost ?? 0,
    at_limit: status?.over_limit ?? false,
    resets_at: status?.reset_at ?? toRfc3339(now(ctx)),
  };
}

function credentialsOf(ctx: ProviderAdminContext, name: string, entry: ProviderEntry): CredentialStatus[] {
  const sdk = sdkOf(name, entry);
  if (isKeylessSdk(sdk)) {
    return claudeAccountReports(now(ctx)).map((report) => ({
      name: report.name,
      kind: "login",
      enabled: true,
      standing: loginStanding(report.state, report.detail),
      detail: report.detail,
      hint: report.email,
      env: null,
      checked_at: null,
      pinned: false,
      in_use: report.in_use,
      warn_on_fallback: false,
      limit: null,
      usage: null,
      ...(report.login_command === undefined ? {} : { login_command: report.login_command }),
    }));
  }
  if (entry.noAuth) {
    const recorded = credentialStanding(name, "none");
    return [{
      name: "none", kind: "none", enabled: true, standing: recorded?.standing ?? "not_checked", detail: recorded?.detail ?? null, hint: null, env: null,
      checked_at: recorded?.checked_at ?? null, pinned: false, in_use: true, warn_on_fallback: false, limit: null, usage: null,
    }];
  }
  const usage = usageByKey(ctx, name);
  const views = keysOf(name, entry);
  const usable = views.filter(({ key }) => key.enabled && secretOf(ctx, name, key) !== undefined && credentialStanding(name, key.name)?.standing !== "invalid");
  const inUse = entry.pin ?? usable[0]?.key.name;
  return views.map(({ key }) => {
    const secret = secretOf(ctx, name, key);
    const recorded = credentialStanding(name, key.name);
    const kind: CredentialKind = key.stored ? "api_key" : "env";
    return {
      name: key.name,
      kind,
      enabled: key.enabled,
      standing: secret === undefined ? "missing" : recorded?.standing ?? "not_checked",
      detail: secret === undefined ? (key.stored ? "no key saved on the daemon" : `${key.env} is not set on the daemon`) : recorded?.detail ?? null,
      hint: lastFour(secret),
      env: key.stored ? null : key.env,
      checked_at: secret === undefined ? null : recorded?.checked_at ?? null,
      pinned: entry.pin === key.name,
      in_use: key.enabled && inUse === key.name,
      warn_on_fallback: key.warnOnFallback,
      limit: limitOf(ctx, name, key),
      usage: usage.get(key.name) ?? null,
    };
  });
}

export function providerStatus(ctx: ProviderAdminContext, name: string, entry: ProviderEntry): ProviderStatus {
  const cache = readCacheSync(cachePath(ctx.config.config.dirs.cache, name));
  const hidden = cache === undefined ? 0 : cache.models.filter((m) => !isVisible(entry.discovery, m.model_id)).length;
  const credentials = credentialsOf(ctx, name, entry);
  const sdk = sdkOf(name, entry);
  return {
    name,
    enabled: entry.enabled,
    sdk,
    base_url: entry.baseUrl ?? defaultBaseUrl(name) ?? null,
    discovery_enabled: entry.discovery.enabled,
    keys: credentials.filter((c) => c.kind === "api_key" || c.kind === "env").map((c) => ({
      name: c.name, enabled: c.enabled, warn_on_fallback: c.warn_on_fallback, env_set: c.standing !== "missing",
    })),
    ignore_models: [...entry.discovery.ignore],
    subscription: entry.subscription,
    no_auth: entry.noAuth,
    selection: isKeylessSdk(sdk) ? "room" : "order",
    pinned: entry.pin ?? null,
    credentials,
    cache: cache === undefined
      ? { present: false, models: 0, visible: 0, hidden: 0, fetched_at: null }
      : { present: true, models: cache.models.length, visible: cache.models.length - hidden, hidden, fetched_at: cache.fetched_at },
  };
}

export function listProviderStatuses(ctx: ProviderAdminContext): OperationResult<"list_providers"> {
  return { providers: ctx.config.config.providers.entries().map(([name, entry]) => providerStatus(ctx, name, entry)) };
}

export function providerDetail(ctx: ProviderAdminContext, args: OperationInput<"provider_detail">): OperationResult<"provider_detail"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  return providerStatus(ctx, name, entry);
}

function changed(ctx: ProviderAdminContext, name: string, file: string, message: string): OperationResult<"add_provider"> {
  const entry = ctx.config.config.providers.get(name);
  if (entry === undefined) throw notFound(`provider ${JSON.stringify(name)} is no longer configured`);
  return { provider: providerStatus(ctx, name, entry), message, file };
}

function requireSdk(raw: string): string {
  const sdk = sdkFromWire(raw.trim());
  if (sdk === undefined) throw invalidRequest(`unknown sdk ${JSON.stringify(raw)}; expected one of ${SDK_VARIANTS.join(", ")}`);
  return sdk;
}

function requireUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidRequest(`base url ${JSON.stringify(raw)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidRequest("base url must start with http:// or https://");
  return trimmed.replace(/\/+$/, "");
}

export function addProvider(ctx: ProviderAdminContext, args: OperationInput<"add_provider">): OperationResult<"add_provider"> {
  const name = args.name.trim();
  if (!NAME.test(name)) throw invalidRequest(`provider names use lowercase letters, digits, - and _, starting with a letter or digit: ${JSON.stringify(args.name)}`);
  if (RESERVED_PROVIDER_NAMES.includes(name)) throw invalidRequest(`"${name}" can't name a provider: \`shore provider ${name}\` is a command`);
  const config = ctx.config.config;
  const existing = findProviderName(config.providers.entries().map(([n]) => n), name);
  if (existing !== undefined) throw invalidRequest(`provider ${JSON.stringify(existing)} is already configured; change it with \`shore provider ${existing} set\``);
  const known = PRESETS.includes(name);
  if (!known && args.sdk === undefined) {
    throw invalidRequest(`shore has no preset for "${name}"; give its sdk (one of ${SDK_VARIANTS.join(", ")}) and base url, e.g. --sdk openai --base-url http://localhost:11434/v1`);
  }
  const sdk = args.sdk === undefined ? undefined : requireSdk(args.sdk);
  const baseUrl = args.base_url === undefined ? undefined : requireUrl(args.base_url);
  const effectiveSdk = sdk ?? presetOf(name).sdk;
  if (baseUrl === undefined && defaultBaseUrl(name) === undefined && (effectiveSdk === "openai" || effectiveSdk === "nanogpt")) {
    throw invalidRequest(`a provider on the ${effectiveSdk} sdk needs a base url, e.g. --base-url http://localhost:11434/v1`);
  }
  if (args.no_auth === true && isKeylessSdk(effectiveSdk)) throw invalidRequest(`${effectiveSdk} signs in with a login; --no-auth doesn't apply`);
  const fields: [string, string][] = [];
  if (sdk !== undefined && (!known || sdk !== presetOf(name).sdk)) fields.push(["sdk", toml(sdk)]);
  if (baseUrl !== undefined) fields.push(["base_url", toml(baseUrl)]);
  fields.push(["discover", String(args.discover ?? true)]);
  if (args.no_auth === true) fields.push(["no_auth", "true"]);
  const file = ctx.config.configPath;
  commitConfigEdits(ctx.config, [{
    file,
    edit: (before) => fields.reduce((text, [key, literal]) => setTomlValue(text, [...providerPath(name), key], literal).text, before),
  }], `adding provider ${name}`);
  return changed(ctx, name, file, `Added provider ${name}`);
}

function settingLiteral(ctx: ProviderAdminContext, name: string, setting: string, value: string): { path: string[]; literal: string } {
  const key = `providers.${name}.${setting.trim().replaceAll("-", "_")}`;
  const entry = findSchemaEntry(schemaOf(ctx.config), key);
  if (entry === undefined || !entry.settable) throw notFound(`providers have no setting ${JSON.stringify(setting)}; \`shore config keys providers.${name}\` lists them`);
  try {
    return { path: parseConfigPath(key), literal: schemaValueLiteral(entry, value) };
  } catch (e) {
    if (e instanceof SchemaValueError) throw invalidRequest(`${setting}: ${e.message}`);
    throw e;
  }
}

export function updateProvider(ctx: ProviderAdminContext, args: OperationInput<"update_provider">): OperationResult<"update_provider"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  const base = providerPath(name);
  const edits: ((text: string) => string)[] = [];
  const said: string[] = [];
  const set = (field: string, literal: string, label: string) => {
    edits.push((text) => setTomlValue(text, [...base, field], literal).text);
    said.push(label);
  };
  const unset = (field: readonly string[], label: string | undefined) => {
    edits.push((text) => unsetTomlValue(text, [...base, ...field]).text);
    if (label !== undefined) said.push(label);
  };
  if (args.enabled !== undefined) set("enabled", String(args.enabled), args.enabled ? "enabled" : "disabled");
  if (args.sdk !== undefined) {
    if (args.sdk === null) unset(["sdk"], "sdk back to its default");
    else set("sdk", toml(requireSdk(args.sdk)), `sdk ${args.sdk}`);
  }
  if (args.base_url !== undefined) {
    if (args.base_url === null) unset(["base_url"], "base url back to its default");
    else {
      const url = requireUrl(args.base_url);
      set("base_url", toml(url), `base url ${url}`);
    }
  }
  if (args.discover !== undefined) {
    unset(["discovery", "enabled"], undefined);
    set("discover", String(args.discover), args.discover ? "model discovery on" : "model discovery off");
  }
  if (args.ignore_models !== undefined) {
    unset(["discovery", "ignore"], undefined);
    const patterns = args.ignore_models.map((p) => p.trim()).filter((p) => p !== "");
    set("ignore_models", `[${patterns.map(toml).join(", ")}]`, patterns.length === 0 ? "no models ignored" : `ignoring ${patterns.join(", ")}`);
  }
  if (args.subscription !== undefined) set("subscription", String(args.subscription), args.subscription ? "billed as a subscription" : "billed per call");
  if (args.no_auth !== undefined) {
    if (args.no_auth && isKeylessSdk(sdkOf(name, entry))) throw invalidRequest(`${name} signs in with a login; no_auth doesn't apply`);
    if (args.no_auth && entry.keys.length > 0) throw invalidRequest(`${name} has keys; remove them before turning on no_auth`);
    if (args.no_auth) set("no_auth", "true", "no key needed");
    else unset(["no_auth"], "keys needed again");
  }
  if (args.setting !== undefined) {
    if (args.value === undefined) throw invalidRequest("a setting needs a value, or null to clear it");
    const setting = args.setting;
    if (args.value === null) {
      const path = parseConfigPath(`providers.${name}.${setting.replaceAll("-", "_")}`);
      edits.push((text) => unsetTomlValue(text, path).text);
      said.push(`${setting} cleared`);
    } else {
      const { path, literal } = settingLiteral(ctx, name, setting, args.value);
      edits.push((text) => setTomlValue(text, path, literal).text);
      said.push(`${setting} = ${literal}`);
    }
  }
  if (edits.length === 0) throw invalidRequest("nothing to change");
  const file = providerFile(ctx.config, name);
  commitConfigEdits(ctx.config, [{ file, edit: (before) => edits.reduce((text, edit) => edit(text), before) }], `changing provider ${name}`);
  return changed(ctx, name, file, `${name}: ${said.join(", ")}`);
}

function modelProvider(config: LoadedConfig, ref: string | undefined | null): string | undefined {
  if (ref === undefined || ref === null || ref.trim() === "") return undefined;
  for (const model of config.models.chat.values()) {
    if (model.name === ref || model.qualifiedName === ref) return model.providerKey;
  }
  const colon = ref.indexOf(":");
  return colon > 0 ? ref.slice(0, colon) : undefined;
}

function modelRefs(config: LoadedConfig): [string, string | undefined][] {
  const d = config.app.defaults;
  return [
    ["chat.model", d.model],
    ["heartbeat.model", d.background.heartbeat],
    ["compaction.model", d.background.compaction],
    ["subagents.model", d.subagent_model],
    ["image.model", d.image_generation],
    ...[...config.app.subagents].map(([sub, def]): [string, string | undefined] => [`subagents.${sub}.model`, def.model]),
  ];
}

export function providerUsers(ctx: ProviderAdminContext, name: string): string[] {
  const global = ctx.config.config;
  const users: string[] = [];
  const uses = (config: LoadedConfig, ref: string | undefined) => modelProvider(config, ref) === name;
  const globalRefs = modelRefs(global);
  for (const [where, ref] of globalRefs) if (uses(global, ref)) users.push(`${where} (${String(ref)})`);
  for (const character of discoverCharacters(global.dirs.config, global.dirs.workspace)) {
    let own: LoadedConfig | undefined;
    try {
      own = loadCharacterConfig(global, character, () => {});
    } catch {
      own = undefined;
    }
    if (own !== undefined) {
      for (const [where, ref] of modelRefs(own)) {
        if (ref !== globalRefs.find(([w]) => w === where)?.[1] && uses(own, ref)) users.push(`${character}'s ${where} (${String(ref)})`);
      }
    }
    try {
      const [, prefs] = loadForCharacter(global.dirs.data, character);
      if (prefs.selected.provider !== undefined && findProviderName([name], prefs.selected.provider) === name) {
        users.push(`${character}'s model (${prefs.selected.provider}:${String(prefs.selected.modelId)})`);
      }
    } catch {
      continue;
    }
    for (const thread of ctx.threads?.listThreads(character) ?? []) {
      if (thread.archived !== true && uses(own ?? global, thread.chat_model)) users.push(`${character}'s thread ${thread.id} (${String(thread.chat_model)})`);
    }
  }
  try {
    const [prefs] = loadForCharacter(global.dirs.data, "");
    if (prefs.selected.provider === name) users.push(`the default model (${name}:${String(prefs.selected.modelId)})`);
  } catch {
    return users;
  }
  return users;
}

export function removeProvider(ctx: ProviderAdminContext, args: OperationInput<"remove_provider">): OperationResult<"remove_provider"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  const users = providerUsers(ctx, name);
  if (users.length > 0) {
    throw invalidRequest(`${name} is still in use by ${users.join("; ")}. Move those to another model, then remove it`);
  }
  const files = configFiles(ctx.config).filter((file) => tomlDefinesTable(readConfigFile(file), providerPath(name)));
  if (files.length === 0) throw invalidRequest(`${name} isn't written in any config file shore can edit`);
  commitConfigEdits(ctx.config, files.map((file) => ({ file, edit: (before) => removeTomlTable(before, providerPath(name)) })), `removing provider ${name}`);
  const keysRemoved = secretStoreFor(ctx.config.config.dirs.data).removeProvider(name);
  for (const key of entry.keys) forgetCredentialStanding(name, key.name);
  return { provider: name, keys_removed: keysRemoved, limits_removed: entry.keys.filter((k) => k.spendLimit !== undefined).length, file: files[0] as string };
}

function refuseLogins(name: string, entry: ProviderEntry, action: string): void {
  if (isKeylessSdk(sdkOf(name, entry))) {
    throw invalidRequest(`${name} signs in with Claude logins, kept in ~/.claude-accounts on the daemon's host; shore can't ${action} yet`);
  }
}

function keyIndex(name: string, entry: ProviderEntry, raw: string): number {
  const index = entry.keys.findIndex((k) => k.name === raw);
  if (index >= 0) return index;
  const folded = entry.keys.findIndex((k) => k.name.toLowerCase() === raw.toLowerCase());
  if (folded >= 0) return folded;
  if (entry.keys.length === 0) {
    throw notFound(`${name} has no keys of its own yet; it reads ${keysOf(name, entry)[0]?.key.env ?? "an environment variable"} from the daemon's environment. Add one with \`shore provider ${name} auth --add\``);
  }
  throw notFound(`${name} has no key named ${JSON.stringify(raw)}; its keys are ${entry.keys.map((k) => k.name).join(", ")}`);
}

function explicitKeyForm(name: string, entry: ProviderEntry): (text: string) => string {
  return (text) => {
    if (!tomlKeyDefined(text, [...providerPath(name), "api_key_env"])) return text;
    const env = entry.keys[0]?.env ?? "";
    const without = unsetTomlValue(text, [...providerPath(name), "api_key_env"]).text;
    return appendTomlArrayTable(without, keysPath(name), [["name", toml("default")], ["api_key_env", toml(env)]], providerPath(name));
  };
}

function nextKeyName(entry: ProviderEntry, reserved: readonly string[]): string {
  const taken = new Set([...entry.keys.map((k) => k.name), ...reserved]);
  if (!taken.has("default")) return "default";
  for (let n = 2; ; n += 1) if (!taken.has(`key${String(n)}`)) return `key${String(n)}`;
}

interface Check {
  standing: CredentialStanding;
  detail: string;
  models: number | null;
  conclusive: boolean;
}

function fromDiscovery<T>(provider: string, result: DiscoveryResult<T>, count: (value: T) => number): Check {
  if ("ok" in result) {
    const n = count(result.ok);
    return { standing: "works", detail: `${String(n)} models`, models: n, conclusive: true };
  }
  const err = result.err;
  if (err.kind === "http_status") {
    const kind = classifyCredentialFailure(provider, { kind: "http_status", status: err.status, body: err.body });
    if (kind === "invalid_key") return { standing: "invalid", detail: `rejected: HTTP ${String(err.status)}`, models: null, conclusive: true };
    if (kind === "quota_exhausted" || kind === "budget_exhausted") return { standing: "over_quota", detail: `over quota: HTTP ${String(err.status)}`, models: null, conclusive: true };
    if (kind === "rate_limited_credential") return { standing: "works", detail: "rate-limited right now", models: null, conclusive: true };
  }
  return { standing: "not_checked", detail: `couldn't check: ${describeDiscoveryError(err)}`, models: null, conclusive: false };
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<{ status: number; body: string } | { error: string }> {
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.text() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function checkKey(provider: string, entry: ProviderEntry, secret: string, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const sdk = sdkOf(provider, entry);
  const baseUrl = entry.baseUrl ?? defaultBaseUrl(provider);
  if (sdk === "gemini" && baseUrl === undefined) {
    const reply = await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": secret }, fetchImpl);
    if ("error" in reply) return { standing: "not_checked", detail: `couldn't check: ${reply.error}`, models: null, conclusive: false };
    if (reply.status >= 400) return fromDiscovery(provider, { err: { kind: "http_status", provider, status: reply.status, body: reply.body } }, () => 0);
    const models = (JSON.parse(reply.body) as { models?: unknown[] }).models?.length ?? 0;
    return { standing: "works", detail: `${String(models)} models`, models, conclusive: true };
  }
  if (baseUrl === undefined) return { standing: "not_checked", detail: "not checked: this provider has no endpoint shore can ask", models: null, conclusive: false };
  if (sdk === "openrouter") {
    const reply = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/key`, { authorization: `Bearer ${secret}` }, fetchImpl);
    if ("error" in reply) return { standing: "not_checked", detail: `couldn't check: ${reply.error}`, models: null, conclusive: false };
    if (reply.status >= 400) return fromDiscovery(provider, { err: { kind: "http_status", provider, status: reply.status, body: reply.body } }, () => 0);
  }
  if (isNanoGptProvider(provider) || sdk === "nanogpt") {
    const usage = await fetchNanoGptSubscription(baseUrl, secret, fetchImpl);
    if ("err" in usage) return fromDiscovery(provider, usage, () => 0);
  }
  const models = sdk === "anthropic"
    ? await discoverAnthropic(provider, baseUrl, secret, fetchImpl)
    : await discoverOpenAiCompatible(provider, baseUrl, secret, fetchImpl);
  return fromDiscovery(provider, models, (list) => list.length);
}

function requireConfidential(ctx: ProviderAdminContext, allow: boolean | undefined): void {
  if (ctx.confidential || allow === true) return;
  throw invalidRequest(
    "this connection to the daemon is neither on this machine nor encrypted, so the key would cross the network as plain text. " +
      "Set it in the daemon's environment and add it with --env, connect over https or from the daemon's host, " +
      "or pass --allow-unencrypted if the network between you is private (a VPN such as Tailscale)",
  );
}

function cleanSecret(raw: string): string {
  const secret = raw.trim();
  if (secret === "") throw invalidRequest("the key is empty");
  if (/\s/.test(secret)) throw invalidRequest("the key has spaces or line breaks in it; paste just the key");
  return secret;
}

function described(check: Check | undefined): string {
  return check === undefined ? "not checked" : check.detail === "" ? check.standing.replaceAll("_", " ") : `${check.standing.replaceAll("_", " ")} · ${check.detail}`;
}

export async function addCredential(ctx: ProviderAdminContext, args: OperationInput<"add_credential">): Promise<OperationResult<"add_credential">> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "add one");
  if (entry.noAuth) throw invalidRequest(`${name} is set to need no key; turn that off first with \`shore provider ${name} set no-auth false\``);
  if ((args.secret === undefined) === (args.env === undefined)) throw invalidRequest("give the key itself or the name of an environment variable that holds it, not both");
  const implicit = entry.keys.length === 0 ? keysOf(name, entry)[0]?.key : undefined;
  const keepImplicit = implicit !== undefined && secretOf(ctx, name, implicit) !== undefined;
  const requested = args.name?.trim() ?? "";
  const keyName = requested === "" ? nextKeyName(entry, keepImplicit ? ["default"] : []) : requested;
  if (!KEY_NAME.test(keyName)) throw invalidRequest(`key names use letters, digits, ., _, @ and -: ${JSON.stringify(keyName)}`);
  if (keepImplicit && keyName.toLowerCase() === "default") throw invalidRequest(`"default" is the key ${name} reads from ${implicit.env}; give the new one another name`);
  if (entry.keys.some((k) => k.name.toLowerCase() === keyName.toLowerCase())) throw invalidRequest(`${name} already has a key named ${JSON.stringify(keyName)}; pick another name or replace it with \`auth ${keyName} --replace\``);
  let secret: string | undefined;
  let env: string | undefined;
  if (args.secret !== undefined) {
    requireConfidential(ctx, args.allow_unencrypted);
    secret = cleanSecret(args.secret);
  } else {
    env = (args.env ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) throw invalidRequest(`${JSON.stringify(args.env)} isn't an environment variable name`);
  }
  const value = secret ?? process.env[env ?? ""]?.trim();
  let check: Check | undefined;
  if (args.no_check !== true && value !== undefined && value !== "") {
    check = await checkKey(name, entry, value, ctx.fetchImpl);
    if (check.standing === "invalid" || check.standing === "over_quota") throw invalidRequest(`${name} ${check.detail}; the key wasn't saved. Skipping the check (--no-check) saves it anyway`);
    if (!check.conclusive && check.detail.startsWith("couldn't")) throw invalidRequest(`${check.detail}; the key wasn't saved. Skipping the check (--no-check) saves it without asking`);
  }
  const store = secretStoreFor(ctx.config.config.dirs.data);
  const file = providerFile(ctx.config, name);
  const fields: [string, string][] = [["name", toml(keyName)], ...(env === undefined ? [] : [["api_key_env", toml(env)] as [string, string]])];
  if (secret !== undefined) store.set(name, keyName, secret);
  try {
    commitConfigEdits(ctx.config, [{
      file,
      edit: (before) => {
        let text = explicitKeyForm(name, entry)(before);
        if (keepImplicit) text = appendTomlArrayTable(text, keysPath(name), [["name", toml("default")], ["api_key_env", toml(implicit.env)]], providerPath(name));
        return appendTomlArrayTable(text, keysPath(name), fields, providerPath(name));
      },
    }], `adding key ${keyName} to ${name}`);
  } catch (e) {
    if (secret !== undefined) store.remove(name, keyName);
    throw e;
  }
  if (check !== undefined && check.conclusive) noteCredentialStanding(name, keyName, check.standing, check.detail, now(ctx));
  const where = secret !== undefined ? `saved on the daemon (${String(lastFour(secret))})` : `read from ${String(env)}${value === undefined || value === "" ? ", which isn't set on the daemon yet" : ""}`;
  const kept = keepImplicit ? `; ${implicit.env} stays first as "default"` : "";
  return changed(ctx, name, file, `Added key "${keyName}" to ${name}, ${where} · ${described(check)}${kept}`);
}

export async function updateCredential(ctx: ProviderAdminContext, args: OperationInput<"update_credential">): Promise<OperationResult<"update_credential">> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "change one");
  const index = keyIndex(name, entry, args.credential);
  const key = entry.keys[index] as ProviderKeyEntry;
  const file = providerFile(ctx.config, name);
  const block: ((text: string) => string)[] = [explicitKeyForm(name, entry)];
  const said: string[] = [];
  let unpin = false;
  if (args.enabled !== undefined) {
    block.push((text) => args.enabled === true ? unsetTomlArrayTableValue(text, keysPath(name), index, "enabled") : setTomlArrayTableValue(text, keysPath(name), index, "enabled", "false"));
    said.push(args.enabled ? "enabled" : "disabled");
    if (!args.enabled && entry.pin === key.name) unpin = true;
  }
  if (args.warn_on_fallback !== undefined) {
    block.push((text) => setTomlArrayTableValue(text, keysPath(name), index, "warn_on_fallback", String(args.warn_on_fallback)));
    said.push(args.warn_on_fallback ? "warns when calls move past it" : "moves on quietly");
  }
  let renamed: string | undefined;
  if (args.rename !== undefined) {
    renamed = args.rename.trim();
    if (!KEY_NAME.test(renamed)) throw invalidRequest(`key names use letters, digits, ., _, @ and -: ${JSON.stringify(renamed)}`);
    if (renamed !== key.name && entry.keys.some((k) => k.name.toLowerCase() === (renamed as string).toLowerCase())) throw invalidRequest(`${name} already has a key named ${JSON.stringify(renamed)}`);
    const to = renamed;
    block.push((text) => setTomlArrayTableValue(text, keysPath(name), index, "name", toml(to)));
    if (entry.pin === key.name && !unpin) block.push((text) => setTomlValue(text, [...providerPath(name), "pin"], toml(to)).text);
    said.push(`renamed to "${to}" (earlier usage stays under "${key.name}")`);
  }
  if (unpin) {
    block.push((text) => unsetTomlValue(text, [...providerPath(name), "pin"]).text);
    said.push("no longer pinned");
  }
  let replacement: string | undefined;
  let check: Check | undefined;
  if (args.secret !== undefined) {
    if (!key.stored) throw invalidRequest(`"${key.name}" reads ${key.env} from the daemon's environment; change it there, or remove it and add the key itself`);
    requireConfidential(ctx, args.allow_unencrypted);
    replacement = cleanSecret(args.secret);
    if (args.no_check !== true) {
      check = await checkKey(name, entry, replacement, ctx.fetchImpl);
      if (check.standing === "invalid" || check.standing === "over_quota") throw invalidRequest(`${name} ${check.detail}; the key wasn't replaced. Skipping the check (--no-check) replaces it anyway`);
    }
    said.push(`key replaced (${String(lastFour(replacement))}) · ${described(check)}`);
  }
  if (said.length === 0) throw invalidRequest("nothing to change");
  const store = secretStoreFor(ctx.config.config.dirs.data);
  const previous = store.get(name, key.name);
  if (replacement !== undefined) store.set(name, key.name, replacement);
  try {
    commitConfigEdits(ctx.config, [{ file, edit: (before) => block.reduce((text, edit) => edit(text), before) }], `changing key ${key.name} of ${name}`);
  } catch (e) {
    if (replacement !== undefined) {
      if (previous === undefined) store.remove(name, key.name);
      else store.set(name, key.name, previous);
    }
    throw e;
  }
  if (renamed !== undefined && renamed !== key.name) {
    if (key.stored) store.rename(name, key.name, renamed);
    forgetCredentialStanding(name, key.name, renamed);
  }
  if (check?.conclusive === true) noteCredentialStanding(name, renamed ?? key.name, check.standing, check.detail, now(ctx));
  else if (replacement !== undefined) forgetCredentialStanding(name, renamed ?? key.name);
  return changed(ctx, name, file, `${name} key "${key.name}": ${said.join(", ")}`);
}

export function removeCredential(ctx: ProviderAdminContext, args: OperationInput<"remove_credential">): OperationResult<"remove_credential"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "remove one");
  const index = keyIndex(name, entry, args.credential);
  const key = entry.keys[index] as ProviderKeyEntry;
  const file = providerFile(ctx.config, name);
  commitConfigEdits(ctx.config, [{
    file,
    edit: (before) => {
      let text = explicitKeyForm(name, entry)(before);
      if (entry.pin === key.name) text = unsetTomlValue(text, [...providerPath(name), "pin"]).text;
      return removeTomlArrayTable(text, keysPath(name), index);
    },
  }], `removing key ${key.name} from ${name}`);
  if (key.stored) secretStoreFor(ctx.config.config.dirs.data).remove(name, key.name);
  forgetCredentialStanding(name, key.name);
  const left = entry.keys.length - 1;
  const fallback = left === 0 ? `; ${name} now reads ${keysOf(name, { ...entry, keys: [] })[0]?.key.env ?? "its default variable"} from the daemon's environment` : "";
  return changed(ctx, name, file, `Removed key "${key.name}" from ${name}${entry.pin === key.name ? " and its pin" : ""}${fallback}`);
}

export async function testCredential(ctx: ProviderAdminContext, args: OperationInput<"test_credential">): Promise<OperationResult<"test_credential">> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "test one");
  const implicit = entry.keys.length === 0 ? keysOf(name, entry)[0]?.key : undefined;
  const key = implicit !== undefined && implicit.name === args.credential ? implicit : entry.keys[keyIndex(name, entry, args.credential)] as ProviderKeyEntry;
  const secret = secretOf(ctx, name, key);
  if (secret === undefined) {
    return { provider: name, credential: key.name, ok: false, standing: "missing", detail: key.stored ? "no key saved on the daemon" : `${key.env} is not set on the daemon`, model_count: null };
  }
  const check = await checkKey(name, entry, secret, ctx.fetchImpl);
  if (check.conclusive) noteCredentialStanding(name, key.name, check.standing, check.detail, now(ctx));
  return { provider: name, credential: key.name, ok: check.standing === "works", standing: check.standing, detail: check.detail, model_count: check.models };
}

export function orderCredentials(ctx: ProviderAdminContext, args: OperationInput<"order_credentials">): OperationResult<"order_credentials"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "order them");
  const wanted = args.order.map((raw) => keyIndex(name, entry, raw.trim()));
  if (new Set(wanted).size !== wanted.length) throw invalidRequest("each key can appear once in the order");
  const order = [...wanted, ...entry.keys.map((_, i) => i).filter((i) => !wanted.includes(i))];
  const file = providerFile(ctx.config, name);
  commitConfigEdits(ctx.config, [{ file, edit: (before) => reorderTomlArrayTables(explicitKeyForm(name, entry)(before), keysPath(name), order) }], `reordering ${name}'s keys`);
  const names = order.map((i) => entry.keys[i]?.name ?? "").join(", ");
  return changed(ctx, name, file, `${name} tries its keys in this order: ${names}${entry.pin === undefined ? "" : ` (but stays pinned to "${entry.pin}")`}`);
}

export function selectCredential(ctx: ProviderAdminContext, args: OperationInput<"select_credential">): OperationResult<"select_credential"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "pin one");
  const file = providerFile(ctx.config, name);
  if (args.credential === null) {
    commitConfigEdits(ctx.config, [{ file, edit: (before) => unsetTomlValue(before, [...providerPath(name), "pin"]).text }], `unpinning ${name}`);
    return changed(ctx, name, file, `${name} picks its key automatically again: the first one that works, in order`);
  }
  const key = entry.keys[keyIndex(name, entry, args.credential)] as ProviderKeyEntry;
  if (!key.enabled) throw invalidRequest(`"${key.name}" is disabled; enable it before pinning it`);
  commitConfigEdits(ctx.config, [{ file, edit: (before) => setTomlValue(explicitKeyForm(name, entry)(before), [...providerPath(name), "pin"], toml(key.name)).text }], `pinning ${name} to ${key.name}`);
  return changed(ctx, name, file, `${name} now uses only "${key.name}"; if it fails, calls fail instead of moving to another key`);
}

export function setCredentialLimit(ctx: ProviderAdminContext, args: OperationInput<"set_credential_limit">): OperationResult<"set_credential_limit"> {
  const { name, entry } = resolveProvider(ctx.config.config, args.provider);
  refuseLogins(name, entry, "limit one's spending");
  const index = keyIndex(name, entry, args.credential);
  const key = entry.keys[index] as ProviderKeyEntry;
  const file = providerFile(ctx.config, name);
  if (args.cost_usd === null) {
    commitConfigEdits(ctx.config, [{
      file,
      edit: (before) => ["spend_limit_usd", "spend_period"].reduce((text, field) => unsetTomlArrayTableValue(text, keysPath(name), index, field), explicitKeyForm(name, entry)(before)),
    }], `clearing the limit on ${name} key ${key.name}`);
    return changed(ctx, name, file, `${name} key "${key.name}" has no spend limit now`);
  }
  if (!Number.isFinite(args.cost_usd) || args.cost_usd <= 0) throw invalidRequest("a spend limit must be more than $0");
  const period = args.period ?? key.spendLimit?.period ?? "month";
  if (!(SPEND_PERIODS as readonly string[]).includes(period)) throw invalidRequest(`a limit's period is one of ${SPEND_PERIODS.join(", ")}`);
  const cost = args.cost_usd;
  commitConfigEdits(ctx.config, [{
    file,
    edit: (before) => {
      const text = setTomlArrayTableValue(explicitKeyForm(name, entry)(before), keysPath(name), index, "spend_limit_usd", tomlNumber(cost));
      return setTomlArrayTableValue(text, keysPath(name), index, "spend_period", toml(period));
    },
  }], `limiting ${name} key ${key.name}`);
  const next = entry.keys.filter((k) => k.enabled && k.name !== key.name).length > 0 && entry.pin === undefined;
  return changed(ctx, name, file, `${name} key "${key.name}" may spend $${cost.toFixed(2)} a ${period}${next ? "; past that, calls move on to the next key" : "; past that, its calls are refused"}`);
}
