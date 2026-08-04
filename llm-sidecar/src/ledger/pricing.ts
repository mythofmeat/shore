/**
 * Model pricing, ported from `crates/daemon/src/ledger/pricing.rs`.
 *
 * This side computes cost because this side makes the calls: it knows the
 * usage the moment a response lands, so pricing a row does not need a second
 * hop. The catalog comes from OpenRouter and is cached in the `pricing` table
 * of `ledger.db`, which is the same table the Rust engine used — a daemon that
 * has already fetched prices hands them over rather than making this side
 * re-fetch.
 *
 * The one piece of genuine Anthropic knowledge here is the cache-write TTL
 * tiering: a 1h write costs 2× input where a 5m write costs 1.25×, so the
 * catalog's 5m price is multiplied by 1.6 to reach the 1h price. That applies
 * to *native* Anthropic only — an OpenRouter-routed Anthropic call is billed at
 * OpenRouter's catalog price as-is.
 */

/** Anthropic 1h cache-write price is 2× input; 5m is 1.25×. 2.0 / 1.25 = 1.6. */
const ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER = 1.6;

const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";

export interface ModelPricing {
  input_per_token: number;
  output_per_token: number;
  cache_read_per_token: number;
  cache_write_per_token: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface CostRequest {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** `"5m"` or `"1h"`; absent means `"1h"`. */
  cache_ttl?: string | undefined;
}

/**
 * Map a (provider, model) pair to OpenRouter's model id.
 *
 * Most providers: `{provider}/{model}`. OpenRouter's own ids are already in
 * that shape and pass through. Anthropic spells minor versions with a dot
 * (`claude-opus-4.6`, not `claude-opus-4-6`). A custom provider key whose
 * model column already holds a prefixed id — `openrouter-anthropic` resolving
 * `anthropic/claude-opus-4.6` — is detected by the `/` and passes through.
 */
export function toOpenRouterId(provider: string, model: string): string {
  if (provider === "openrouter" || model.includes("/")) return model;
  if (provider === "anthropic") return `anthropic/${normalizeAnthropicModel(model)}`;
  return `${provider}/${model}`;
}

/**
 * Recognize Anthropic-family rows for cache health and diagnostics.
 *
 * Native Anthropic uses the literal provider key; OpenRouter-routed Anthropic
 * carries an `anthropic/...` model id by the time it reaches the ledger,
 * whatever the user named the provider. Mirrored as SQL in the daemon's
 * `query.rs` and `store.rs` as `(provider = 'anthropic' OR model LIKE
 * 'anthropic/%')` — those copies cannot move until the ledger's readers do.
 */
export function isAnthropicPricing(provider: string, model: string): boolean {
  return provider === "anthropic" || model.startsWith("anthropic/");
}

/**
 * Rewrite the last `digit-digit` separator as a dot: `claude-opus-4-6` becomes
 * `claude-opus-4.6`. Scans from the right and stops at the first match, so a
 * model name with an earlier digit-hyphen-digit run keeps it.
 */
function normalizeAnthropicModel(model: string): string {
  const chars = [...model];
  for (let i = chars.length - 2; i >= 1; i--) {
    const before = chars[i - 1];
    const separator = chars[i];
    const after = chars[i + 1];
    if (separator === "-" && isAsciiDigit(before) && isAsciiDigit(after)) {
      chars[i] = ".";
      break;
    }
  }
  return chars.join("");
}

const isAsciiDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= "0" && c <= "9";

/** OpenRouter reports prices as strings or numbers. Anything else is 0. */
function parsePrice(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Multiply tokens by per-token prices.
 *
 * Pure: the caller supplies the catalog entry, so this is testable without a
 * database and callable from wherever the prices happen to be cached.
 */
export function calculateCost(pricing: ModelPricing, request: CostRequest): CostBreakdown {
  const input = pricing.input_per_token * request.input_tokens;
  const output = pricing.output_per_token * request.output_tokens;
  const cache_read = pricing.cache_read_per_token * request.cache_read_tokens;

  let cache_write = pricing.cache_write_per_token * request.cache_write_tokens;
  // Native Anthropic only. An OpenRouter-routed Anthropic row is billed at
  // OpenRouter's catalog cache-write price, so the native TTL multiplier would
  // over-count it.
  if (request.provider === "anthropic" && (request.cache_ttl ?? "1h") === "1h") {
    cache_write *= ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER;
  }

  return { input, output, cache_read, cache_write, total: input + output + cache_read + cache_write };
}

/**
 * How the catalog is fetched. Narrower than `typeof fetch` so a test can pass
 * a plain function without reimplementing the platform's extras.
 */
export type CatalogFetch = (url: string) => Promise<Response>;

/** Where cached prices live. Backed by the `pricing` table in `ledger.db`. */
export interface PricingStore {
  get(modelId: string): ModelPricing | undefined;
  put(modelId: string, pricing: ModelPricing): void;
  /** Forget every cached price. `shore usage --refresh-pricing` is the caller. */
  clear(): void;
}

/**
 * Catalog lookup with an in-memory cache in front of the store.
 *
 * A miss fetches OpenRouter's whole catalog and caches every model in it, not
 * just the one asked for — the request is the expensive part and the catalog
 * is a few hundred KB.
 */
export class PricingEngine {
  readonly #store: PricingStore;
  readonly #memory = new Map<string, ModelPricing>();
  readonly #fetch: CatalogFetch;
  /** In-flight catalog fetch, so concurrent misses share one request. */
  #inflight: Promise<void> | undefined;

  constructor(store: PricingStore, fetchImpl: CatalogFetch = (url) => globalThis.fetch(url)) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  /** Cached price, memory first, then the store. No network. */
  cached(provider: string, model: string): ModelPricing | undefined {
    const id = toOpenRouterId(provider, model);
    const hit = this.#memory.get(id);
    if (hit) return hit;
    const stored = this.#store.get(id);
    if (stored) this.#memory.set(id, stored);
    return stored;
  }

  /** Cached price, else fetch the catalog. `undefined` if unavailable. */
  async getOrFetch(provider: string, model: string): Promise<ModelPricing | undefined> {
    const hit = this.cached(provider, model);
    if (hit) return hit;
    await this.#refreshCatalog();
    return this.cached(provider, model);
  }

  /**
   * Empty both caches, so the next lookup fetches the catalog again.
   *
   * The table first and the memory second, which is the only order that holds
   * under a concurrent read: clearing memory first leaves a window where a
   * lookup can repopulate it from the rows that are about to be deleted.
   *
   * This was two methods in two processes — the daemon deleted the table, and
   * the sidecar dropped the memory it kept in front of that table when the
   * `refresh_pricing` report reached it. Both halves are here now, and a
   * refresh that ran only one of them was the bug that split them.
   */
  clearCache(): void {
    this.#store.clear();
    this.#memory.clear();
  }

  /** Price a call, or `undefined` when the model has no catalog entry. */
  cost(request: CostRequest): CostBreakdown | undefined {
    const pricing = this.cached(request.provider, request.model);
    return pricing ? calculateCost(pricing, request) : undefined;
  }

  async #refreshCatalog(): Promise<void> {
    this.#inflight ??= this.#fetchCatalog().finally(() => {
      this.#inflight = undefined;
    });
    await this.#inflight;
  }

  async #fetchCatalog(): Promise<void> {
    let body: unknown;
    try {
      const response = await this.#fetch(OPENROUTER_CATALOG_URL);
      if (!response.ok) return;
      body = await response.json();
    } catch {
      // Pricing is best-effort: an unpriced row is better than a failed call.
      return;
    }

    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return;

    for (const entry of data) {
      const model = entry as { id?: unknown; pricing?: Record<string, unknown> };
      if (typeof model.id !== "string" || !model.pricing) continue;
      const p = model.pricing;
      const pricing: ModelPricing = {
        input_per_token: parsePrice(p["prompt"]),
        output_per_token: parsePrice(p["completion"]),
        cache_read_per_token: parsePrice(p["input_cache_read"] ?? p["cache_read"]),
        cache_write_per_token: parsePrice(p["input_cache_write"] ?? p["cache_write"]),
      };
      this.#memory.set(model.id, pricing);
      this.#store.put(model.id, pricing);
    }
  }
}
