/**
 * Provider model discovery and its on-disk cache.
 *
 * Ported from `crates/daemon/src/llm/discovery.rs`, pinned by
 * `tests/llm_fixtures/discovery_parity.json`.
 *
 * OpenAI-compatible providers (OpenAI, OpenRouter, vLLM, Together, …) share one
 * fetcher; native Anthropic discovery needs its own auth and version headers.
 * Both land in the same `DiscoveredModel` shape and the same per-provider cache
 * file, so the rest of the daemon never has to know which dialect a catalog
 * came from.
 *
 * # Unknown is not false
 *
 * Every capability is a *tri-state*: `true`, `false`, or absent. A provider that
 * says nothing about tool use has not said it lacks tool use, and a UI that
 * collapses the two tells the user a model cannot do something it can. Every
 * accessor here returns `undefined` for "the provider did not say" and only
 * commits to `false` when the provider published a field that omitted the
 * capability.
 *
 * # The cache file is a cross-language contract
 *
 * Rust still reads and writes these files (`effective_catalog.rs`,
 * `commands/providers.rs`, `auto_discovery.rs`). Until those move, a cache
 * written here is read there and vice versa, so the serialized shape is pinned
 * byte-for-byte by the fixture — field order, two-space indent, no trailing
 * newline, and every absent optional omitted rather than written as `null`.
 * `undefined` values disappear under `JSON.stringify`, which is what makes the
 * omission fall out naturally; assigning `null` instead would produce a file
 * the Rust rejects.
 *
 * # Failures never destroy a good cache
 *
 * A corrupt or unreadable cache reads as *missing* rather than raising, because
 * a caller asking for cached models should not fall over on a bad file — the
 * user can refresh. Writes go to a sibling tmp file and rename in, so a
 * serialization or I/O failure leaves the previous catalog intact.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Current cache schema version. Bump when adding a field older builds could not
 * reasonably ignore.
 */
export const CACHE_VERSION = 1;

/** How long a cached catalog stays fresh, in milliseconds (24h). */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Required by Anthropic's API on every native HTTP request. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Longest response body kept in an error, in *bytes*. */
const MAX_LOG_BODY_BYTES = 512;

// ── DiscoveredModel ─────────────────────────────────────────────────────

/**
 * One model record returned by a provider's discovery endpoint.
 *
 * The optional fields are optional in the "absent" sense, not the "nullable"
 * sense — see the note on the cache file above.
 */
export interface DiscoveredModel {
  provider_key: string;
  model_id: string;
  display_name?: string;
  /** Wire SDK family, usually the provider's own `sdk` — but see {@link effectiveModelSdk}. */
  sdk: string;
  base_url?: string;
  created_at?: number;
  owned_by?: string;
  description?: string;
  context_length?: number;
  max_output_tokens?: number;
  supports_tools?: boolean;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  supports_prompt_cache?: boolean;
  /** The provider's original entry, verbatim, so later work needn't re-fetch. */
  raw_provider_metadata?: unknown;
  /** RFC3339, as a string, matching the diagnostics ring-buffer convention. */
  discovered_at: string;
}

/** On-disk per-provider cache shape. */
export interface ProviderModelsCache {
  version: number;
  provider_key: string;
  /** RFC3339 timestamp of the last refresh. */
  fetched_at: string;
  base_url?: string;
  models: DiscoveredModel[];
}

// ── Cache file ──────────────────────────────────────────────────────────

/** `<cacheDir>/providers/<provider>/models.json`. */
export function cachePath(cacheDir: string, providerKey: string): string {
  return join(cacheDir, "providers", providerKey, "models.json");
}

/**
 * Read a provider's cache, or `undefined` when it is absent, corrupt, or
 * written by a newer build.
 *
 * Only genuine I/O failures propagate. Everything about the file's *contents*
 * that could go wrong resolves to "no cache", because the caller's fallback —
 * refetch, or show nothing — is better than an exception.
 */
export async function readCache(path: string): Promise<ProviderModelsCache | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return decodeCache(bytes, path);
}

/**
 * The synchronous twin of {@link readCache}, for the model-resolution path.
 *
 * `find_effective_model` is synchronous in the Rust and is called from
 * preference resolution, which is itself synchronous; making the whole chain
 * async to read one small cached file would be a much larger change than the
 * behaviour warrants. Both readers share {@link decodeCache}, so the version
 * and shape checks cannot drift apart.
 */
export function readCacheSync(path: string): ProviderModelsCache | undefined {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return decodeCache(bytes, path);
}

/** Validate raw cache bytes. Everything recoverable resolves to "no cache". */
function decodeCache(bytes: string, path: string): ProviderModelsCache | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    console.warn(`Provider cache failed to parse — treating as missing: ${path}`);
    return undefined;
  }

  const cache = asCache(parsed);
  if (cache === undefined) {
    // Shape mismatch is the same class of problem as a syntax error: the Rust
    // reached it through a failed `serde` deserialization, which is likewise
    // swallowed into `Ok(None)`.
    console.warn(`Provider cache failed to parse — treating as missing: ${path}`);
    return undefined;
  }
  if (cache.version > CACHE_VERSION) {
    console.warn(
      `Provider cache version ${cache.version} newer than this build (${CACHE_VERSION}) — treating as missing: ${path}`,
    );
    return undefined;
  }
  return cache;
}

/**
 * Validate the cache envelope the way `serde` would.
 *
 * `version`, `provider_key`, `fetched_at` and `models` have no defaults in the
 * Rust struct, so a file missing any of them fails to deserialize and reads as
 * missing. Notably `models` is *not* defaulted: a cache without it is not an
 * empty catalog, it is a broken file. Unknown fields are ignored.
 */
function asCache(value: unknown): ProviderModelsCache | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 0) {
    return undefined;
  }
  if (typeof v.provider_key !== "string") return undefined;
  if (typeof v.fetched_at !== "string") return undefined;
  if (!Array.isArray(v.models)) return undefined;

  const models: DiscoveredModel[] = [];
  for (const raw of v.models) {
    const model = asModel(raw);
    if (model === undefined) return undefined;
    models.push(model);
  }

  return {
    version: v.version,
    provider_key: v.provider_key,
    fetched_at: v.fetched_at,
    ...(typeof v.base_url === "string" ? { base_url: v.base_url } : {}),
    models,
  };
}

function asModel(value: unknown): DiscoveredModel | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.provider_key !== "string") return undefined;
  if (typeof v.model_id !== "string") return undefined;
  if (typeof v.sdk !== "string") return undefined;
  if (typeof v.discovered_at !== "string") return undefined;

  return {
    provider_key: v.provider_key,
    model_id: v.model_id,
    ...optionalString("display_name", v),
    sdk: v.sdk,
    ...optionalString("base_url", v),
    ...optionalNumber("created_at", v),
    ...optionalString("owned_by", v),
    ...optionalString("description", v),
    ...optionalNumber("context_length", v),
    ...optionalNumber("max_output_tokens", v),
    ...optionalBoolean("supports_tools", v),
    ...optionalBoolean("supports_images", v),
    ...optionalBoolean("supports_reasoning", v),
    ...optionalBoolean("supports_prompt_cache", v),
    ...(v.raw_provider_metadata !== undefined && v.raw_provider_metadata !== null
      ? { raw_provider_metadata: v.raw_provider_metadata }
      : {}),
    discovered_at: v.discovered_at,
  };
}

function optionalString(key: string, v: Record<string, unknown>): Record<string, string> {
  return typeof v[key] === "string" ? { [key]: v[key] } : {};
}

function optionalNumber(key: string, v: Record<string, unknown>): Record<string, number> {
  return typeof v[key] === "number" ? { [key]: v[key] } : {};
}

function optionalBoolean(key: string, v: Record<string, unknown>): Record<string, boolean> {
  return typeof v[key] === "boolean" ? { [key]: v[key] } : {};
}

/**
 * Milliseconds elapsed since `fetchedAt`, or `undefined` when the timestamp is
 * unparseable *or in the future*.
 *
 * The future case is not an oversight. The Rust converted a signed duration
 * into a `std::time::Duration`, which cannot be negative, and callers read
 * `undefined` as "stale" — so a clock that jumped, or a hand-edited file,
 * triggers a refresh instead of pinning a catalog as permanently fresh.
 */
export function cacheAgeMs(fetchedAt: string, now: number = Date.now()): number | undefined {
  const parsed = parseRfc3339(fetchedAt);
  if (parsed === undefined) return undefined;
  const elapsed = now - parsed;
  if (elapsed < 0) return undefined;
  return elapsed;
}

/** A cache is stale when its age is unknown or at least {@link REFRESH_INTERVAL_MS}. */
export function isStale(cache: ProviderModelsCache, now: number = Date.now()): boolean {
  const age = cacheAgeMs(cache.fetched_at, now);
  if (age === undefined) return true;
  return age >= REFRESH_INTERVAL_MS;
}

/**
 * Parse an RFC3339 timestamp to epoch milliseconds.
 *
 * `Date.parse` is far more permissive than `chrono`'s RFC3339 parser — it
 * accepts `2026-04-28`, `Apr 28 2026`, and assorted other shapes that the Rust
 * rejected. Since "unparseable" means "refresh this cache", being *more*
 * accepting here would silently keep stale catalogs alive, so the shape is
 * checked before the value is.
 */
function parseRfc3339(value: string): number | undefined {
  // date `T` time, then either `Z` or a `±HH:MM` offset. Fractional seconds
  // optional; the separator may be a lowercase `t`, as RFC3339 permits.
  const shape = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
  if (!shape.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Write a provider cache atomically: serialize, write a tmp sibling, rename in.
 *
 * The rename is the commit point, so a previous good cache survives any failure
 * before it.
 */
export async function writeCache(path: string, cache: ProviderModelsCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = serializeCache(cache);
  // `.json` → `.json.tmp`, matching the Rust's `with_extension`.
  const tmp = `${path.replace(/\.json$/, "")}.json.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

/**
 * The exact bytes of a cache file.
 *
 * Field order follows the Rust struct declaration, not insertion convenience —
 * see the cross-language note at the top of the file.
 */
export function serializeCache(cache: ProviderModelsCache): string {
  const ordered = {
    version: cache.version,
    provider_key: cache.provider_key,
    fetched_at: cache.fetched_at,
    base_url: cache.base_url,
    models: cache.models.map(serializeModel),
  };
  return JSON.stringify(ordered, null, 2);
}

function serializeModel(m: DiscoveredModel): Record<string, unknown> {
  return {
    provider_key: m.provider_key,
    model_id: m.model_id,
    display_name: m.display_name,
    sdk: m.sdk,
    base_url: m.base_url,
    created_at: m.created_at,
    owned_by: m.owned_by,
    description: m.description,
    context_length: m.context_length,
    max_output_tokens: m.max_output_tokens,
    supports_tools: m.supports_tools,
    supports_images: m.supports_images,
    supports_reasoning: m.supports_reasoning,
    supports_prompt_cache: m.supports_prompt_cache,
    // A null here is skipped on the Rust side just as an absent value is, so
    // both collapse to omission.
    raw_provider_metadata: m.raw_provider_metadata ?? undefined,
    discovered_at: m.discovered_at,
  };
}

// ── Discovery errors ────────────────────────────────────────────────────

export type DiscoveryError =
  | { kind: "discovery_disabled"; provider: string; discoveryKind: string }
  | { kind: "no_keys"; provider: string }
  | { kind: "missing_base_url"; provider: string }
  | { kind: "http_status"; provider: string; status: number; body: string }
  | { kind: "network"; provider: string; message: string }
  | { kind: "parse"; provider: string; message: string };

export function describeDiscoveryError(e: DiscoveryError): string {
  switch (e.kind) {
    case "discovery_disabled":
      return `provider ${e.provider}: ${e.discoveryKind} discovery is not enabled`;
    case "no_keys":
      return `provider ${e.provider}: no API key configured`;
    case "missing_base_url":
      return `provider ${e.provider}: missing base_url for discovery`;
    case "http_status":
      return `provider ${e.provider}: discovery HTTP ${e.status}`;
    case "network":
      return `provider ${e.provider}: network error: ${e.message}`;
    case "parse":
      return `provider ${e.provider}: failed to parse models response: ${e.message}`;
  }
}

/** Either a value or a discovery error — the shape `Result` collapses to here. */
export type DiscoveryResult<T> = { ok: T } | { err: DiscoveryError };

// ── Fetchers ────────────────────────────────────────────────────────────

/**
 * Fetch and map a provider's `/v1/models` endpoint.
 *
 * `baseUrl` is the API root (e.g. `https://openrouter.ai/api/v1`); `/models` is
 * appended.
 */
export async function discoverOpenAiCompatible(
  providerKey: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  return await fetchModels(providerKey, baseUrl, "openai", buildModelsUrl(baseUrl), fetchImpl, {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  });
}

/**
 * Fetch and map Anthropic's native Models API.
 *
 * Anthropic authenticates with `x-api-key` rather than a bearer token and
 * requires a version header, and its conventional base URL is the API host — so
 * the version segment is appended when the caller did not supply one.
 */
export async function discoverAnthropic(
  providerKey: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  return await fetchModels(
    providerKey,
    baseUrl,
    "anthropic",
    buildAnthropicModelsUrl(baseUrl),
    fetchImpl,
    {
      accept: "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    },
  );
}

async function fetchModels(
  providerKey: string,
  baseUrl: string,
  sdk: string,
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  let resp: Response;
  let body: string;
  try {
    resp = await fetchImpl(url, { method: "GET", headers });
    // Reading the body is part of the network step: a stream that dies
    // mid-transfer is a network error, not a bad status.
    body = await resp.text();
  } catch (e) {
    return { err: { kind: "network", provider: providerKey, message: String(e) } };
  }

  if (!resp.ok) {
    return {
      err: {
        kind: "http_status",
        provider: providerKey,
        status: resp.status,
        body: truncateForLog(body),
      },
    };
  }

  return parseModelsResponse(providerKey, baseUrl, sdk, body);
}

/** Append `/models` to a provider base URL, tolerating trailing slashes. */
export function buildModelsUrl(baseUrl: string): string {
  return `${trimTrailingSlashes(baseUrl)}/models`;
}

/**
 * Append Anthropic's Models API path to either a host root or a caller-supplied
 * version root such as a gateway's `/api/v1`.
 *
 * The test is a literal `/v1` *suffix*, so `/v10` gets a version segment
 * appended and `/v1/beta` does too — a `v1` elsewhere in the path does not
 * count.
 */
export function buildAnthropicModelsUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function trimTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Cap a response body kept in an error.
 *
 * The cap is **512 bytes, not 512 characters**, and the cut is moved back to a
 * UTF-8 character boundary so a multibyte character straddling the limit is
 * dropped whole rather than split into replacement junk. A `slice(0, 512)` on
 * the string would cut by UTF-16 code units, which is neither the same
 * threshold nor the same boundary.
 */
export function truncateForLog(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= MAX_LOG_BODY_BYTES) return body;
  return `${bytes.toString("utf8", 0, floorCharBoundary(bytes, MAX_LOG_BODY_BYTES))}…`;
}

/**
 * The largest index at or below `index` that starts a UTF-8 character.
 *
 * Continuation bytes match `0b10xxxxxx`; walking back off them lands on a lead
 * byte. Well-formed UTF-8 never runs more than three continuations, so the walk
 * is bounded without needing a guard.
 */
function floorCharBoundary(bytes: Buffer, index: number): number {
  let i = index;
  while (i > 0 && ((bytes[i] as number) & 0xc0) === 0x80) i -= 1;
  return i;
}

// ── Response mapping ────────────────────────────────────────────────────

/**
 * Map a `{ "data": [...] }` envelope to models.
 *
 * `data` may be *absent* — that is an empty catalog — but an explicit `null` or
 * a non-array is a parse failure. The Rust reached that asymmetry through
 * `#[serde(default)]`, which fires on a missing field and not on a present one
 * holding the wrong type, and the difference is visible: a provider that
 * answers `{"data": null}` gets an error rather than being recorded as having
 * no models at all.
 */
export function parseModelsResponse(
  providerKey: string,
  baseUrl: string,
  sdk: string,
  body: string,
  now: string = new Date().toISOString(),
): DiscoveryResult<DiscoveredModel[]> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch (e) {
    return { err: { kind: "parse", provider: providerKey, message: String(e) } };
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return {
      err: { kind: "parse", provider: providerKey, message: "expected a JSON object" },
    };
  }

  const data = (envelope as Record<string, unknown>).data;
  if (data === undefined) return { ok: [] };
  if (!Array.isArray(data)) {
    return {
      err: { kind: "parse", provider: providerKey, message: "`data` is not an array" },
    };
  }

  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const model = mapEntry(providerKey, baseUrl, sdk, raw, now);
    if (model !== undefined) out.push(model);
  }
  return { ok: out };
}

/**
 * Resolve the wire SDK for one discovered model.
 *
 * OpenAI-compatible discovery stamps one blanket `sdk` across a feed, which is
 * right for single-dialect gateways. OpenCode Go is not one: it fronts open
 * models across two dialects behind a single `/models` feed, where MiniMax and
 * Qwen speak the Anthropic `/messages` format and everything else speaks
 * `/chat/completions`.
 *
 * Note that for `opencode-go` the caller's `defaultSdk` is *discarded* — a
 * non-Qwen, non-MiniMax model there is `openai` whatever the feed claimed.
 */
export function effectiveModelSdk(
  providerKey: string,
  modelId: string,
  defaultSdk: string,
): string {
  if (providerKey !== "opencode-go") return defaultSdk;
  const id = modelId.toLowerCase();
  // Strip any leading `vendor/` namespace some feeds prepend, so the family
  // test looks at the model name and not at who published it.
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return bare.startsWith("qwen") || bare.startsWith("minimax") ? "anthropic" : "openai";
}

/**
 * Map one raw provider entry, or `undefined` when it has no usable `id`.
 *
 * A malformed entry is skipped rather than failing the whole catalog: one bad
 * record in a 300-model feed should not cost the user the other 299.
 */
export function mapEntry(
  providerKey: string,
  baseUrl: string,
  sdk: string,
  raw: unknown,
  now: string,
): DiscoveredModel | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;

  const id = r.id;
  if (typeof id !== "string") return undefined;

  return {
    provider_key: providerKey,
    model_id: id,
    ...maybe("display_name", displayName(r)),
    sdk: effectiveModelSdk(providerKey, id, sdk),
    base_url: baseUrl,
    ...maybe("created_at", createdAt(r)),
    ...maybe("owned_by", str(r.owned_by)),
    ...maybe("description", str(r.description)),
    ...maybe("context_length", unsignedInt(r.context_length)),
    ...maybe("max_output_tokens", maxOutputTokens(r)),
    ...maybe("supports_tools", supportedParam(r, ["tools", "tool_use", "function_calling"])),
    ...maybe("supports_images", modalityIncludes(r, "input", "image")),
    ...maybe("supports_reasoning", supportedParam(r, ["reasoning", "include_reasoning"])),
    ...maybe("supports_prompt_cache", supportedParam(r, ["prompt_cache", "cache_control"])),
    raw_provider_metadata: raw,
    discovered_at: now,
  };
}

function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<K, never> {
  return value === undefined ? ({} as Record<K, never>) : ({ [key]: value } as Record<K, V>);
}

/**
 * `name`, else `display_name`.
 *
 * The fallback is keyed on the *presence* of `name`, not on whether it held a
 * string: an entry with a numeric `name` and a perfectly good `display_name`
 * ends up with no display name at all. That is what the Rust's
 * `get("name").or_else(|| get("display_name")).and_then(as_str)` does — the
 * `or_else` runs before the string check — and a `??` chain in its place would
 * quietly disagree.
 */
function displayName(r: Record<string, unknown>): string | undefined {
  const picked = "name" in r ? r.name : r.display_name;
  return str(picked);
}

/**
 * `created` as epoch seconds, else `created_at` parsed from RFC3339.
 *
 * The fallback runs whenever `created` did not yield an integer — including
 * when it was present but fractional, since a JSON float is not an `i64`.
 */
function createdAt(r: Record<string, unknown>): number | undefined {
  const created = signedInt(r.created);
  if (created !== undefined) return created;
  const iso = str(r.created_at);
  if (iso === undefined) return undefined;
  const ms = parseRfc3339(iso);
  return ms === undefined ? undefined : Math.floor(ms / 1000);
}

/** OpenRouter nests it under `top_provider`; other feeds put it at the top level. */
function maxOutputTokens(r: Record<string, unknown>): number | undefined {
  const top = r.top_provider;
  if (typeof top === "object" && top !== null && !Array.isArray(top)) {
    const nested = unsignedInt((top as Record<string, unknown>).max_completion_tokens);
    if (nested !== undefined) return nested;
  }
  return unsignedInt(r.max_completion_tokens);
}

/**
 * OpenRouter-style `supported_parameters: [...]`, checked for any of `names`.
 *
 * `undefined` means the field was absent — unknown, not unsupported. An *empty*
 * array is knowledge, and yields `false`. Non-string members are dropped before
 * matching rather than coerced.
 */
function supportedParam(r: Record<string, unknown>, names: string[]): boolean | undefined {
  const arr = r.supported_parameters;
  if (!Array.isArray(arr)) return undefined;
  const values = arr.filter((v): v is string => typeof v === "string");
  return names.some((n) => values.includes(n));
}

/**
 * OpenRouter-style `architecture.{input,output}_modalities`.
 *
 * Only the requested side is consulted: a model that *emits* images but cannot
 * accept them reports `supports_images: false`, which is the question the
 * caller is actually asking.
 */
function modalityIncludes(
  r: Record<string, unknown>,
  side: string,
  modality: string,
): boolean | undefined {
  const arch = r.architecture;
  if (typeof arch !== "object" || arch === null || Array.isArray(arch)) return undefined;
  const arr = (arch as Record<string, unknown>)[`${side}_modalities`];
  if (!Array.isArray(arr)) return undefined;
  return arr.some((v) => v === modality);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * A JSON number that is an `i64`.
 *
 * Fractional values are rejected, matching `serde_json::Value::as_i64`, which
 * answers for the number's *representation* rather than rounding it.
 */
function signedInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** A JSON number that is a `u64` — integral and non-negative. */
function unsignedInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}
