/**
 * The `[providers.<name>]` registry: transport, credentials, discovery
 * visibility, and the provider-level behavioral defaults bag.
 *
 * Port of `crates/common/src/config/providers.rs`.
 */

import {
  mergeFrom,
  readModelConfigFields,
  sdkFromWire,
  type ModelConfigFields,
  type ProviderRegistryEntry,
  type Sdk,
} from "./models.ts";
import { compareByCodePoint, sortedKeys } from "../sort.ts";
import type { ProviderEntry as CredentialsProviderEntry } from "../llm/credentials.ts";

// ── Errors ──────────────────────────────────────────────────────────────

export type ProviderRegistryErrorKind =
  | "parse_entry"
  | "conflicting_key_forms"
  | "missing_key_field"
  | "duplicate_key_name"
  | "removed_provider"
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

  static removedProvider(): ProviderRegistryError {
    return new ProviderRegistryError(
      "removed_provider",
      `[providers.claude_code] is no longer supported — the Claude Code transport ` +
        `was removed; drop this section from your config`,
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

// ── Discovery ───────────────────────────────────────────────────────────

/**
 * The `[providers.<name>.discovery]` sub-block.
 *
 * Note `enabled` defaults to **false** — the struct derives `Default` and is
 * `#[serde(default)]`, so an omitted `[discovery]` block leaves discovery off.
 * That is the opposite of `ProviderEntry.enabled`, which has an explicit
 * `default = "default_provider_enabled"` and defaults to true.
 */
export interface ProviderDiscovery {
  enabled: boolean;
  /**
   * Gitignore-style patterns evaluated against an upstream model id.
   *
   * Patterns are evaluated in order and the last match wins. A bare pattern
   * hides matched ids; a `!` prefix un-hides them. Ids matching nothing stay
   * visible. Only discovered models are affected — manual `[chat.*]` entries
   * never are.
   */
  ignore: string[];
}

export function defaultDiscovery(): ProviderDiscovery {
  return { enabled: false, ignore: [] };
}

/**
 * Whether `modelId` should be surfaced in normal model lists. Default-visible
 * when `ignore` is empty.
 */
export function isVisible(discovery: ProviderDiscovery, modelId: string): boolean {
  let visible = true;
  for (const pat of discovery.ignore) {
    const negate = pat.startsWith("!");
    const body = negate ? pat.slice(1) : pat;
    if (globMatches(body, modelId)) {
      // Bare hides, `!` shows; last match wins.
      visible = negate;
    }
  }
  return visible;
}

/**
 * A star-only glob. `*` matches any run of characters, `/` included;
 * everything else matches literally. Enough for the patterns configs actually
 * use — a vendor prefix with a trailing star, a leading star with a `/free`
 * suffix, a version prefix with a trailing star.
 *
 * The Rust indexes `&str` by byte offset while this indexes UTF-16 units, and
 * the two never disagree: every length compared here — the literal edges, the
 * search window, the cursor — is measured against the same subject in the same
 * unit, and the edges are always substrings of that subject. An earlier draft
 * converted both sides to bytes to be safe; mutation testing showed no input
 * could tell the two apart, so the conversion was removed rather than left as
 * unexplained ballast.
 *
 * `middle === ""` cannot arise from a split on a non-empty separator except
 * between adjacent stars, where skipping and not skipping agree — `indexOf("")`
 * is 0 and leaves the cursor put. The guard mirrors the Rust's own.
 */
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
    // A cursor past `end` yields an empty window, and an empty window never
    // contains a non-empty middle — the same `false` the Rust reaches via a
    // failed slice.
    const idx = s.slice(cursor, end).indexOf(middle);
    if (idx < 0) return false;
    cursor += idx + middle.length;
  }
  return true;
}

// ── Keys ────────────────────────────────────────────────────────────────

/** One entry from `[[providers.<name>.keys]]`. */
export interface ProviderKeyEntry {
  /** Friendly key name surfaced in fallback warnings. Unique per provider. */
  name: string;
  /** Env var holding the actual API key value. */
  env: string;
  /** Whether to consider this key when resolving credentials. */
  enabled: boolean;
  /** If set, falling back away from this key emits a visible client warning. */
  warnOnFallback: boolean;
}

// ── Provider entry ──────────────────────────────────────────────────────

/**
 * One `[providers.<name>]` entry.
 *
 * `enabled = false` parses but excludes the provider from every runtime
 * resolution path — discovery, credentials, and (since #139) its legacy
 * static `[chat.*]` entries too.
 */
export interface ProviderEntry extends ProviderRegistryEntry {
  enabled: boolean;
  sdk?: Sdk;
  baseUrl?: string;
  /**
   * Compact single-key form, folded into a synthetic `default` key at parse
   * time so downstream consumers only ever see `keys`. Always absent after
   * {@link registryFromSection}.
   */
  apiKeyEnv?: string;
  keys: ProviderKeyEntry[];
  discovery: ProviderDiscovery;
  /** `[providers.<name>.defaults]` — the provider-wide behavioral bag. */
  defaults: ModelConfigFields;
}

export function defaultProviderEntry(): ProviderEntry {
  return { enabled: true, keys: [], discovery: defaultDiscovery(), defaults: {} };
}

/** Only the enabled keys, in configured order. */
export function enabledKeys(entry: ProviderEntry): ProviderKeyEntry[] {
  return entry.keys.filter((k) => k.enabled);
}

/**
 * The same entry in the shape `llm/credentials.ts` reads.
 *
 * The twin of `toRequestModel` in `./models.ts`, for the same reason and with
 * the same rule: the credential resolver was ported against the sidecar's
 * snake_case mirror before this module existed, so there are two spellings of
 * one Rust type. Convert here, never at a call site.
 *
 * The credentials side models only `enabled` and `keys` — deliberately, since
 * nothing about resolving a key needs transport or discovery — so this drops
 * the rest rather than renaming it. `warnOnFallback` is the single field whose
 * spelling actually differs.
 */
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

// ── Registry ────────────────────────────────────────────────────────────

/**
 * The parsed `[providers]` section.
 *
 * Iteration is in `BTreeMap` order over provider names — code-point sorted,
 * matching the model catalog. Callers that stop at the first match (the
 * bare-model-id search in `effective_catalog`) depend on it.
 */
export class ProviderRegistry {
  private constructor(private readonly providers: Map<string, ProviderEntry>) {}

  static empty(): ProviderRegistry {
    return new ProviderRegistry(new Map());
  }

  /** Build a registry from the raw `providers` section, if present. */
  static fromSection(section: Record<string, unknown> | undefined): ProviderRegistry {
    if (section === undefined) return ProviderRegistry.empty();

    const providers = new Map<string, ProviderEntry>();
    for (const name of sortedKeys(section)) {
      if (name === "claude_code") throw ProviderRegistryError.removedProvider();
      providers.set(name, parseEntry(name, section[name]));
    }
    return new ProviderRegistry(
      new Map([...providers].sort((a, b) => compareByCodePoint(a[0], b[0]))),
    );
  }

  /** For tests and callers that already hold entries. */
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

  /** `(providerKey, entry)` pairs in lexicographic order. */
  entries(): [string, ProviderEntry][] {
    return [...this.providers];
  }

  /** Only the enabled providers, in lexicographic order. */
  enabled(): [string, ProviderEntry][] {
    return this.entries().filter(([, e]) => e.enabled);
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(provider: string, value: unknown): ProviderEntry {
  const entry = readEntry(value);
  if ("err" in entry) throw ProviderRegistryError.parseEntry(provider, entry.err);
  const parsed = entry.ok;

  // Transport lives on the provider entry itself, not under `[.defaults]`.
  // Reject it there so there is exactly one home for sdk/base_url/credentials.
  const transport = transportFieldInDefaults(parsed.defaults);
  if (transport !== undefined) {
    throw ProviderRegistryError.transportInDefaults(provider, transport);
  }

  // Reject the "both forms" case explicitly — silent precedence between the
  // compact and named-key forms invites surprise.
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

  // Fold the compact form into a synthetic `default` key so downstream
  // consumers only ever see the named-key form.
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

/**
 * The first transport field set in a `[.defaults]` block, if any. Transport
 * belongs on the provider entry, not in its behavioral-defaults bag.
 */
export function transportFieldInDefaults(defaults: ModelConfigFields): string | undefined {
  if (defaults.sdk !== undefined) return "sdk";
  if (defaults.baseUrl !== undefined) return "base_url";
  if (defaults.apiKeyEnv !== undefined) return "api_key_env";
  return undefined;
}

type ReadResult<T> = { ok: T } | { err: string };

const ENTRY_KEYS = ["enabled", "sdk", "base_url", "api_key_env", "keys", "discovery", "defaults"];
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

function readEntry(value: unknown): ReadResult<ProviderEntry> {
  if (!isTable(value)) return { err: "invalid type: expected a table" };
  const unknown = unknownField(value, ENTRY_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultProviderEntry();

  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") return { err: "invalid type: expected a boolean" };
    out.enabled = value["enabled"];
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
    // The defaults bag is the same field set as a model entry; reuse the
    // catalog's reader by merging an empty bag with what it produces.
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

  // `name` and `env` have no serde default, so a missing one is a parse
  // error rather than the empty string that `missing_key_field` reports.
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

/**
 * `[providers.<name>.defaults]` carries the same field set as a model entry,
 * so it goes through the catalog's own reader. Transport keys are rejected
 * afterwards by {@link transportFieldInDefaults}, which names the offending
 * field — parsing them here would only report a type.
 */
function readDefaults(table: Record<string, unknown>): ReadResult<ModelConfigFields> {
  return readModelConfigFields(table);
}

/**
 * How serde phrases the accepted set. Two fields get `a` or `b`; three or more
 * get a comma list under `one of`. Matching this exactly is what makes the
 * unknown-field errors compare byte for byte.
 */
function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  if (known.length === 2) return `\`${known[0]}\` or \`${known[1]}\``;
  const head = known.slice(0, -1).map((k) => `\`${k}\``).join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}
