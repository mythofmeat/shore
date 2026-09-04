import { shoreLog } from "../log.ts";

import { toRfc3339 } from "../ledger/zoned.ts";
import {
  isNanoGptProvider,
  NANOGPT_MODELS_QUERY,
  NANOGPT_PAID_MODELS_URL,
  NANOGPT_SUBSCRIPTION_MODELS_URL,
} from "./providers/nanogpt_config.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CACHE_VERSION = 2;

export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const ANTHROPIC_VERSION = "2023-06-01";

const MAX_LOG_BODY_BYTES = 512;

export interface DiscoveredModelSupport {
  supported_parameters?: readonly string[];
  effort?: {
    supported: boolean;
    levels: readonly string[];
  };
  thinking?: {
    adaptive?: boolean;
    enabled?: boolean;
  };
}

export interface DiscoveredModel {
  provider_key: string;
  model_id: string;
  display_name?: string;
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
  support?: DiscoveredModelSupport;
  subscription_included?: boolean;
  subscription_input_multiplier?: number;
  raw_provider_metadata?: unknown;
  discovered_at: string;
}

export interface ProviderModelsCache {
  version: number;
  provider_key: string;
  fetched_at: string;
  base_url?: string;
  models: DiscoveredModel[];
}

export function cachePath(cacheDir: string, providerKey: string): string {
  return join(cacheDir, "providers", providerKey, "models.json");
}

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

function decodeCache(bytes: string, path: string): ProviderModelsCache | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    shoreLog.warn(`Provider cache failed to parse — treating as missing: ${path}`);
    return undefined;
  }

  const cache = asCache(parsed);
  if (cache === undefined) {
    shoreLog.warn(`Provider cache failed to parse — treating as missing: ${path}`);
    return undefined;
  }
  if (cache.version > CACHE_VERSION) {
    shoreLog.warn(
      `Provider cache version ${cache.version} newer than this build (${CACHE_VERSION}) — treating as missing: ${path}`,
    );
    return undefined;
  }
  return cache;
}

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
    const model = asModel(raw, v.version);
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

function asModel(value: unknown, cacheVersion: number): DiscoveredModel | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.provider_key !== "string") return undefined;
  if (typeof v.model_id !== "string") return undefined;
  if (typeof v.sdk !== "string") return undefined;
  if (typeof v.discovered_at !== "string") return undefined;

  const rawMetadata = v.raw_provider_metadata !== undefined && v.raw_provider_metadata !== null
    ? v.raw_provider_metadata
    : undefined;
  const support = asSupport(v.support) ??
    (cacheVersion === 1 ? normalizeDiscoveredSupport(rawMetadata) : undefined);

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
    ...maybe("support", support),
    ...maybe(
      "subscription_included",
      typeof v.subscription_included === "boolean"
        ? v.subscription_included
        : inlineSubscriptionIncluded(rawMetadata),
    ),
    ...maybe(
      "subscription_input_multiplier",
      typeof v.subscription_input_multiplier === "number"
        ? v.subscription_input_multiplier
        : inlineSubscriptionMultiplier(rawMetadata),
    ),
    ...(rawMetadata === undefined ? {} : { raw_provider_metadata: rawMetadata }),
    discovered_at: v.discovered_at,
  };
}

function asSupport(value: unknown): DiscoveredModelSupport | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const supportedParameters = stringListPreservingEmpty(v.supported_parameters);
  let effort: DiscoveredModelSupport["effort"];
  if (typeof v.effort === "object" && v.effort !== null && !Array.isArray(v.effort)) {
    const block = v.effort as Record<string, unknown>;
    const levels = stringListPreservingEmpty(block.levels);
    if (typeof block.supported === "boolean" && levels !== undefined) {
      effort = { supported: block.supported, levels };
    }
  }
  let thinking: DiscoveredModelSupport["thinking"];
  if (typeof v.thinking === "object" && v.thinking !== null && !Array.isArray(v.thinking)) {
    const block = v.thinking as Record<string, unknown>;
    const adaptive = typeof block.adaptive === "boolean" ? block.adaptive : undefined;
    const enabled = typeof block.enabled === "boolean" ? block.enabled : undefined;
    if (adaptive !== undefined || enabled !== undefined) {
      thinking = {
        ...(adaptive === undefined ? {} : { adaptive }),
        ...(enabled === undefined ? {} : { enabled }),
      };
    }
  }
  if (supportedParameters === undefined && effort === undefined && thinking === undefined) {
    return undefined;
  }
  return {
    ...maybe("supported_parameters", supportedParameters),
    ...maybe("effort", effort),
    ...maybe("thinking", thinking),
  };
}

function inlineSubscriptionBlock(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const block = (raw as Record<string, unknown>).subscription;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  return block as Record<string, unknown>;
}

export function inlineSubscriptionIncluded(raw: unknown): boolean | undefined {
  const block = inlineSubscriptionBlock(raw);
  if (block === undefined) return undefined;
  return typeof block.included === "boolean" ? block.included : undefined;
}

export function inlineSubscriptionMultiplier(raw: unknown): number | undefined {
  const block = inlineSubscriptionBlock(raw);
  if (block === undefined) return undefined;
  const value = block.inputTokenMultiplier;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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

export function cacheAgeMs(fetchedAt: string, now: number = Date.now()): number | undefined {
  const parsed = parseRfc3339(fetchedAt);
  if (parsed === undefined) return undefined;
  const elapsed = now - parsed;
  if (elapsed < 0) return undefined;
  return elapsed;
}

export function isStale(cache: ProviderModelsCache, now: number = Date.now()): boolean {
  const age = cacheAgeMs(cache.fetched_at, now);
  if (age === undefined) return true;
  return age >= REFRESH_INTERVAL_MS;
}

function parseRfc3339(value: string): number | undefined {
  const shape = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
  if (!shape.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export async function writeCache(path: string, cache: ProviderModelsCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = serializeCache(cache);
  const tmp = `${path.replace(/\.json$/, "")}.json.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

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
    support: m.support,
    subscription_included: m.subscription_included,
    subscription_input_multiplier: m.subscription_input_multiplier,
    raw_provider_metadata: m.raw_provider_metadata ?? undefined,
    discovered_at: m.discovered_at,
  };
}

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

export type DiscoveryResult<T> = { ok: T } | { err: DiscoveryError };

export async function discoverOpenAiCompatible(
  providerKey: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  if (isNanoGptProvider(providerKey)) {
    return await discoverNanoGpt(providerKey, baseUrl, apiKey, fetchImpl);
  }
  return await fetchModels(providerKey, baseUrl, "openai", buildModelsUrl(baseUrl, providerKey), fetchImpl, {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  });
}

async function discoverNanoGpt(
  providerKey: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
  const covered = await fetchModels(
    providerKey,
    baseUrl,
    "openai",
    NANOGPT_SUBSCRIPTION_MODELS_URL,
    fetchImpl,
    headers,
  );
  if ("err" in covered) return covered;
  const paid = await fetchModels(
    providerKey,
    baseUrl,
    "openai",
    NANOGPT_PAID_MODELS_URL,
    fetchImpl,
    headers,
  );
  if ("err" in paid) return paid;
  return { ok: mergeNanoGptRosters(covered.ok, paid.ok) };
}

export function mergeNanoGptRosters(
  covered: readonly DiscoveredModel[],
  paid: readonly DiscoveredModel[],
): DiscoveredModel[] {
  const coveredIds = new Set(covered.map((m) => m.model_id));
  const paidIds = new Set(paid.map((m) => m.model_id));
  const merged = new Map<string, DiscoveredModel>();
  for (const m of [...covered, ...paid]) {
    if (merged.has(m.model_id)) continue;
    merged.set(m.model_id, {
      ...m,
      subscription_included: coveredIds.has(m.model_id) && !paidIds.has(m.model_id),
      ...maybe(
        "subscription_input_multiplier",
        m.subscription_input_multiplier ?? inlineSubscriptionMultiplier(m.raw_provider_metadata),
      ),
    });
  }
  return [...merged.values()];
}

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

export function buildModelsUrl(baseUrl: string, providerKey?: string): string {
  const url = `${trimTrailingSlashes(baseUrl)}/models`;
  return isNanoGptProvider(providerKey ?? "") ? `${url}${NANOGPT_MODELS_QUERY}` : url;
}

export function buildAnthropicModelsUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function trimTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

export function truncateForLog(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= MAX_LOG_BODY_BYTES) return body;
  return `${bytes.toString("utf8", 0, floorCharBoundary(bytes, MAX_LOG_BODY_BYTES))}…`;
}

function floorCharBoundary(bytes: Buffer, index: number): number {
  let i = index;
  while (i > 0 && ((bytes[i] as number) & 0xc0) === 0x80) i -= 1;
  return i;
}

export function parseModelsResponse(
  providerKey: string,
  baseUrl: string,
  sdk: string,
  body: string,
  now: string = toRfc3339(Date.now()),
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

export function effectiveModelSdk(
  providerKey: string,
  modelId: string,
  defaultSdk: string,
): string {
  if (providerKey !== "opencode-go") return defaultSdk;
  const id = modelId.toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return bare.startsWith("qwen") || bare.startsWith("minimax") ? "anthropic" : "openai";
}

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
    ...maybe(
      "supports_tools",
      supportedParam(r, ["tools", "tool_use", "function_calling"]) ?? capabilityFlag(r, "tool_calling"),
    ),
    ...maybe(
      "supports_images",
      modalityIncludes(r, "input", "image") ?? capabilityFlag(r, "vision"),
    ),
    ...maybe(
      "supports_reasoning",
      supportedParam(r, ["reasoning", "include_reasoning"]) ?? capabilityFlag(r, "reasoning"),
    ),
    ...maybe("supports_prompt_cache", supportedParam(r, ["prompt_cache", "cache_control"])),
    ...maybe("support", normalizeDiscoveredSupport(raw)),
    raw_provider_metadata: raw,
    discovered_at: now,
  };
}

function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<K, never> {
  return value === undefined ? ({} as Record<K, never>) : ({ [key]: value } as Record<K, V>);
}

function displayName(r: Record<string, unknown>): string | undefined {
  const picked = "name" in r ? r.name : r.display_name;
  return str(picked);
}

function createdAt(r: Record<string, unknown>): number | undefined {
  const created = signedInt(r.created);
  if (created !== undefined) return created;
  const iso = str(r.created_at);
  if (iso === undefined) return undefined;
  const ms = parseRfc3339(iso);
  return ms === undefined ? undefined : Math.floor(ms / 1000);
}

function maxOutputTokens(r: Record<string, unknown>): number | undefined {
  const top = r.top_provider;
  if (typeof top === "object" && top !== null && !Array.isArray(top)) {
    const nested = unsignedInt((top as Record<string, unknown>).max_completion_tokens);
    if (nested !== undefined) return nested;
  }
  return unsignedInt(r.max_completion_tokens) ?? unsignedInt(r.max_output_tokens);
}

function stringListPreservingEmpty(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function capabilityBlock(r: Record<string, unknown>): Record<string, unknown> | undefined {
  const caps = r.capabilities;
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) return undefined;
  return caps as Record<string, unknown>;
}

function capabilityFlag(r: Record<string, unknown>, name: string): boolean | undefined {
  const flag = capabilityBlock(r)?.[name];
  return typeof flag === "boolean" ? flag : undefined;
}

function isSupported(v: unknown): boolean | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const flag = (v as Record<string, unknown>).supported;
  return typeof flag === "boolean" ? flag : undefined;
}

function advertisedEfforts(r: Record<string, unknown>): DiscoveredModelSupport["effort"] {
  const named = stringListPreservingEmpty(r.reasoning_efforts)?.filter((level) => level !== "none");
  if (named !== undefined && named.length > 0) return { supported: true, levels: named };
  return capabilityFlag(r, "reasoning") === false ? { supported: false, levels: [] } : undefined;
}

function effortSupport(r: Record<string, unknown>): DiscoveredModelSupport["effort"] {
  const effort = capabilityBlock(r)?.effort;
  if (typeof effort !== "object" || effort === null || Array.isArray(effort)) {
    return advertisedEfforts(r);
  }
  const block = effort as Record<string, unknown>;
  const levels = Object.entries(block)
    .filter(([key]) => key !== "supported")
    .filter(([, value]) => isSupported(value) === true)
    .map(([key]) => key);
  return { supported: block.supported !== false, levels };
}

function thinkingType(r: Record<string, unknown>, name: string): boolean | undefined {
  const thinking = capabilityBlock(r)?.thinking;
  if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) return undefined;
  const block = thinking as Record<string, unknown>;
  if (block.supported === false) return false;
  const types = block.types;
  if (typeof types !== "object" || types === null || Array.isArray(types)) return undefined;
  return isSupported((types as Record<string, unknown>)[name]);
}

export function normalizeDiscoveredSupport(raw: unknown): DiscoveredModelSupport | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const supportedParameters = stringListPreservingEmpty(r.supported_parameters);
  const effort = effortSupport(r);
  const adaptive = thinkingType(r, "adaptive");
  const enabled = thinkingType(r, "enabled");
  const thinking = adaptive === undefined && enabled === undefined
    ? undefined
    : {
        ...(adaptive === undefined ? {} : { adaptive }),
        ...(enabled === undefined ? {} : { enabled }),
      };
  if (supportedParameters === undefined && effort === undefined && thinking === undefined) {
    return undefined;
  }
  return {
    ...maybe("supported_parameters", supportedParameters),
    ...maybe("effort", effort),
    ...maybe("thinking", thinking),
  };
}

function supportedParam(r: Record<string, unknown>, names: string[]): boolean | undefined {
  const arr = r.supported_parameters;
  if (!Array.isArray(arr)) return undefined;
  const values = arr.filter((v): v is string => typeof v === "string");
  return names.some((n) => values.includes(n));
}

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

function signedInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function unsignedInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}
