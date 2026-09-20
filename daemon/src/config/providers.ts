import {
  mergeFrom,
  readModelConfigFields,
  sdkFromWire,
  type ModelConfigFields,
  type ProviderRegistryEntry,
  type Sdk,
} from "./models.ts";
import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import type { ProviderEntry as CredentialsProviderEntry } from "../llm/credentials.ts";
import { ZAI_SUB_PROVIDER } from "../llm/providers/zai_config.ts";

export type ProviderRegistryErrorKind =
  | "parse_entry"
  | "conflicting_key_forms"
  | "missing_key_field"
  | "duplicate_key_name"
  | "transport_in_defaults";

export class ProviderRegistryError extends Error {
  constructor(
    readonly kind: ProviderRegistryErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRegistryError";
  }

  static parseEntry(provider: string, source: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "parse_entry",
      `failed to parse [providers.${provider}]: ${source}`,
    );
  }

  static conflictingKeyForms(provider: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "conflicting_key_forms",
      `[providers.${provider}] declares both \`api_key_env\` and explicit \`[[keys]]\`; ` +
        `use one form per provider`,
    );
  }

  static missingKeyField(provider: string, index: number, field: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "missing_key_field",
      `[providers.${provider}] key #${index} is missing \`${field}\``,
    );
  }

  static duplicateKeyName(provider: string, name: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "duplicate_key_name",
      `[providers.${provider}] has duplicate key name ${JSON.stringify(name)}; ` +
        `each key under a provider must have a unique name`,
    );
  }

  static transportInDefaults(provider: string, field: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "transport_in_defaults",
      `[providers.${provider}.defaults] may not set transport key \`${field}\`; ` +
        `set it on [providers.${provider}] directly`,
    );
  }
}

export interface ProviderDiscovery {
  enabled: boolean;
  ignore: string[];
}

export function defaultDiscovery(): ProviderDiscovery {
  return { enabled: false, ignore: [] };
}

export function isVisible(discovery: ProviderDiscovery, modelId: string): boolean {
  let visible = true;
  for (const pat of discovery.ignore) {
    const negate = pat.startsWith("!");
    const body = negate ? pat.slice(1) : pat;
    if (globMatches(body, modelId)) {
      visible = negate;
    }
  }
  return visible;
}

export function globMatches(pattern: string, s: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return parts[0] === s;

  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (!s.startsWith(first) || !s.endsWith(last)) return false;
  if (first.length + last.length > s.length) return false;

  let cursor = first.length;
  const end = s.length - last.length;
  for (const middle of parts.slice(1, parts.length - 1)) {
    if (middle === "") continue;
    const idx = s.slice(cursor, end).indexOf(middle);
    if (idx < 0) return false;
    cursor += idx + middle.length;
  }
  return true;
}

export interface ProviderKeyEntry {
  name: string;
  env: string;
  enabled: boolean;
  warnOnFallback: boolean;
}

export interface ProviderEntry extends ProviderRegistryEntry {
  enabled: boolean;
  subscription: boolean;
  sdk?: Sdk;
  baseUrl?: string;
  apiKeyEnv?: string;
  keys: ProviderKeyEntry[];
  discovery: ProviderDiscovery;
  defaults: ModelConfigFields;
}

export const DEFAULT_SUBSCRIPTION_PROVIDERS: readonly string[] = [
  "opencode-go",
  "opencode",
  ZAI_SUB_PROVIDER,
];
const DEFAULT_SUBSCRIPTION_SET = new Set(DEFAULT_SUBSCRIPTION_PROVIDERS);

function defaultProviderEntry(name?: string): ProviderEntry {
  return {
    enabled: true,
    subscription: name !== undefined && DEFAULT_SUBSCRIPTION_SET.has(name),
    keys: [],
    discovery: defaultDiscovery(),
    defaults: {},
  };
}

export function enabledKeys(entry: ProviderEntry): ProviderKeyEntry[] {
  return entry.keys.filter((k) => k.enabled);
}

export function toCredentialsEntry(entry: ProviderEntry): CredentialsProviderEntry {
  return {
    enabled: entry.enabled,
    keys: entry.keys.map((k) => ({
      name: k.name,
      env: k.env,
      enabled: k.enabled,
      warn_on_fallback: k.warnOnFallback,
    })),
  };
}

export class ProviderRegistry {
  private constructor(private readonly providers: Map<string, ProviderEntry>) {}

  static empty(): ProviderRegistry {
    return new ProviderRegistry(new Map());
  }

  static fromSection(section: Record<string, unknown> | undefined): ProviderRegistry {
    if (section === undefined) return ProviderRegistry.empty();

    const providers = new Map<string, ProviderEntry>();
    for (const name of sortedKeys(section)) {
      providers.set(name, parseEntry(name, section[name]));
    }
    return new ProviderRegistry(
      new Map([...providers].sort((a, b) => compareByCodePoint(a[0], b[0]))),
    );
  }

  static fromEntries(entries: Iterable<readonly [string, ProviderEntry]>): ProviderRegistry {
    return new ProviderRegistry(
      new Map([...entries].sort((a, b) => compareByCodePoint(a[0], b[0]))),
    );
  }

  get(providerKey: string): ProviderEntry | undefined {
    return this.providers.get(providerKey);
  }

  isEmpty(): boolean {
    return this.providers.size === 0;
  }

  get size(): number {
    return this.providers.size;
  }

  entries(): [string, ProviderEntry][] {
    return [...this.providers];
  }

  enabled(): [string, ProviderEntry][] {
    return this.entries().filter(([, e]) => e.enabled);
  }

  subscriptionSettings(): [string, boolean][] {
    return this.entries().map(([name, e]) => [name, e.subscription]);
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(provider: string, value: unknown): ProviderEntry {
  const entry = readEntry(value, provider);
  if ("err" in entry) throw ProviderRegistryError.parseEntry(provider, entry.err);
  const parsed = entry.ok;

  const transport = transportFieldInDefaults(parsed.defaults);
  if (transport !== undefined) {
    throw ProviderRegistryError.transportInDefaults(provider, transport);
  }

  if (parsed.apiKeyEnv !== undefined && parsed.keys.length > 0) {
    throw ProviderRegistryError.conflictingKeyForms(provider);
  }

  const seen = new Set<string>();
  for (const [idx, key] of parsed.keys.entries()) {
    if (key.name === "") throw ProviderRegistryError.missingKeyField(provider, idx, "name");
    if (key.env === "") throw ProviderRegistryError.missingKeyField(provider, idx, "env");
    if (seen.has(key.name)) throw ProviderRegistryError.duplicateKeyName(provider, key.name);
    seen.add(key.name);
  }

  if (parsed.apiKeyEnv !== undefined) {
    parsed.keys.push({
      name: "default",
      env: parsed.apiKeyEnv,
      enabled: true,
      warnOnFallback: false,
    });
    delete parsed.apiKeyEnv;
  }

  return parsed;
}

function transportFieldInDefaults(defaults: ModelConfigFields): string | undefined {
  if (defaults.sdk !== undefined) return "sdk";
  if (defaults.baseUrl !== undefined) return "base_url";
  if (defaults.apiKeyEnv !== undefined) return "api_key_env";
  return undefined;
}

type ReadResult<T> = { ok: T } | { err: string };

const ENTRY_KEYS = [
  "enabled",
  "subscription",
  "sdk",
  "base_url",
  "api_key_env",
  "keys",
  "discovery",
  "defaults",
];
const DISCOVERY_KEYS = ["enabled", "ignore"];
const KEY_KEYS = ["name", "env", "enabled", "warn_on_fallback"];

function unknownField(table: Record<string, unknown>, known: readonly string[]): string | undefined {
  for (const key of sortedKeys(table)) {
    if (!known.includes(key)) {
      return `unknown field \`${key}\`, expected ${expectedList(known)}`;
    }
  }
  return undefined;
}

function readEntry(value: unknown, name?: string): ReadResult<ProviderEntry> {
  if (!isTable(value)) return { err: "invalid type: expected a table" };
  const unknown = unknownField(value, ENTRY_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultProviderEntry(name);

  for (const field of ["enabled", "subscription"] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "boolean") return { err: "invalid type: expected a boolean" };
    out[field] = value[field];
  }
  if (value["sdk"] !== undefined) {
    if (typeof value["sdk"] !== "string") return { err: "invalid type: expected a string" };
    const sdk = sdkFromWire(value["sdk"]);
    if (sdk === undefined) return { err: `unknown variant \`${value["sdk"]}\`` };
    out.sdk = sdk;
  }
  for (const [field, key] of [
    ["baseUrl", "base_url"],
    ["apiKeyEnv", "api_key_env"],
  ] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return { err: "invalid type: expected a string" };
    out[field] = raw;
  }

  const discovery = value["discovery"];
  if (discovery !== undefined) {
    const read = readDiscovery(discovery);
    if ("err" in read) return read;
    out.discovery = read.ok;
  }

  const keys = value["keys"];
  if (keys !== undefined) {
    if (!Array.isArray(keys)) return { err: "invalid type: expected a sequence" };
    for (const raw of keys) {
      const read = readKey(raw);
      if ("err" in read) return read;
      out.keys.push(read.ok);
    }
  }

  const defaults = value["defaults"];
  if (defaults !== undefined) {
    if (!isTable(defaults)) return { err: "invalid type: expected a table" };
    const read = readDefaults(defaults);
    if ("err" in read) return read;
    mergeFrom(out.defaults, read.ok);
  }

  return { ok: out };
}

function readDiscovery(value: unknown): ReadResult<ProviderDiscovery> {
  if (!isTable(value)) return { err: "invalid type: expected a table" };
  const unknown = unknownField(value, DISCOVERY_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultDiscovery();
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") return { err: "invalid type: expected a boolean" };
    out.enabled = value["enabled"];
  }
  const ignore = value["ignore"];
  if (ignore !== undefined) {
    if (!Array.isArray(ignore)) return { err: "invalid type: expected a sequence" };
    for (const pat of ignore) {
      if (typeof pat !== "string") return { err: "invalid type: expected a string" };
      out.ignore.push(pat);
    }
  }
  return { ok: out };
}

function readKey(value: unknown): ReadResult<ProviderKeyEntry> {
  if (!isTable(value)) return { err: "invalid type: expected a table" };
  const unknown = unknownField(value, KEY_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const name = value["name"];
  const env = value["env"];
  if (typeof name !== "string") return { err: "missing field `name`" };
  if (typeof env !== "string") return { err: "missing field `env`" };

  const out: ProviderKeyEntry = { name, env, enabled: true, warnOnFallback: false };
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") return { err: "invalid type: expected a boolean" };
    out.enabled = value["enabled"];
  }
  if (value["warn_on_fallback"] !== undefined) {
    if (typeof value["warn_on_fallback"] !== "boolean") {
      return { err: "invalid type: expected a boolean" };
    }
    out.warnOnFallback = value["warn_on_fallback"];
  }
  return { ok: out };
}

function readDefaults(table: Record<string, unknown>): ReadResult<ModelConfigFields> {
  return readModelConfigFields(table);
}

function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  if (known.length === 2) return `\`${known[0]}\` or \`${known[1]}\``;
  const head = known.slice(0, -1).map((k) => `\`${k}\``).join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}
