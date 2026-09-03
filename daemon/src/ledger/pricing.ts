import { shoreLog } from "../log.ts";

const ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER = 1.6;

const ANTHROPIC_5M_CACHE_WRITE_RATIO = 1.25;

const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";

const NANOGPT_CATALOG_URL = "https://nano-gpt.com/api/v1/models?detailed=true";

const NANOGPT_PROVIDER = "nanogpt";

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
  cache_ttl?: string | undefined;
}

export function catalogId(provider: string, model: string): string {
  if (provider === NANOGPT_PROVIDER) return `${NANOGPT_PROVIDER}/${model}`;
  if (provider === "openrouter" || model.includes("/")) return model;
  if (provider === "anthropic") return `anthropic/${normalizeAnthropicModel(model)}`;
  return `${provider}/${model}`;
}

export function isAnthropicPricing(provider: string, model: string): boolean {
  return provider === "anthropic" || model.startsWith("anthropic/");
}

function normalizeAnthropicModel(model: string): string {
  const chars = Array.from(model);
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

function parsePrice(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function priceOrZero(value: unknown): number {
  return parsePrice(value) ?? 0;
}

export function pricingIsUsable(
  provider: string,
  model: string,
  pricing: ModelPricing,
): boolean {
  if (!isAnthropicPricing(provider, model)) return true;
  return pricing.cache_write_per_token > 0;
}

export function calculateCost(pricing: ModelPricing, request: CostRequest): CostBreakdown {
  const input = pricing.input_per_token * request.input_tokens;
  const output = pricing.output_per_token * request.output_tokens;
  const cache_read = pricing.cache_read_per_token * request.cache_read_tokens;

  let cache_write = pricing.cache_write_per_token * request.cache_write_tokens;
  const oneHourCache = request.cache_ttl === "1h" ||
    (request.provider === "anthropic" && request.cache_ttl === undefined);
  if (
    (request.provider === "anthropic" ||
      (request.provider === NANOGPT_PROVIDER && request.model.startsWith("anthropic/"))) &&
    oneHourCache
  ) {
    cache_write *= ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER;
  }

  return { input, output, cache_read, cache_write, total: input + output + cache_read + cache_write };
}

export type CatalogFetch = (url: string) => Promise<Response>;

export interface PricingStore {
  get(modelId: string): ModelPricing | undefined;
  put(modelId: string, pricing: ModelPricing): void;
}

const PER_MILLION = 1e-6;

const PER_THOUSAND = 1e-3;

function cacheWriteOrAnthropicFallback(
  id: string,
  advertised: number | undefined,
  inputPerToken: number,
): number {
  if (advertised !== undefined && advertised > 0) return advertised;
  return id.startsWith("anthropic/") ? inputPerToken * ANTHROPIC_5M_CACHE_WRITE_RATIO : 0;
}

function openRouterPricing(id: string, p: Record<string, unknown>): ModelPricing {
  const input = priceOrZero(p["prompt"]);
  return {
    input_per_token: input,
    output_per_token: priceOrZero(p["completion"]),
    cache_read_per_token: priceOrZero(p["input_cache_read"] ?? p["cache_read"]),
    cache_write_per_token: cacheWriteOrAnthropicFallback(
      id,
      parsePrice(p["input_cache_write"] ?? p["cache_write"]),
      input,
    ),
  };
}

function nanoGptPricing(id: string, p: Record<string, unknown>): ModelPricing {
  const prompt = priceOrZero(p["prompt"]) * PER_MILLION;
  const advertisedWrite = parsePrice(p["cacheWriteInputPer1kTokens"]);
  const cacheWrite = cacheWriteOrAnthropicFallback(
    id,
    advertisedWrite === undefined ? undefined : advertisedWrite * PER_THOUSAND,
    prompt,
  );
  return {
    input_per_token: prompt,
    output_per_token: priceOrZero(p["completion"]) * PER_MILLION,
    cache_read_per_token: priceOrZero(p["cacheReadInputPer1kTokens"]) * PER_THOUSAND,
    cache_write_per_token: cacheWrite,
  };
}

interface CatalogSource {
  url: string;
  key: (id: string) => string;
  read: (id: string, pricing: Record<string, unknown>) => ModelPricing;
}

const OPENROUTER_SOURCE: CatalogSource = {
  url: OPENROUTER_CATALOG_URL,
  key: (id) => id,
  read: openRouterPricing,
};

const NANOGPT_SOURCE: CatalogSource = {
  url: NANOGPT_CATALOG_URL,
  key: (id) => `${NANOGPT_PROVIDER}/${id}`,
  read: nanoGptPricing,
};

function catalogSource(provider: string): CatalogSource {
  return provider === NANOGPT_PROVIDER ? NANOGPT_SOURCE : OPENROUTER_SOURCE;
}

export class PricingEngine {
  readonly #store: PricingStore;
  readonly #fetch: CatalogFetch;
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #warnedUnusable = new Set<string>();

  constructor(store: PricingStore, fetchImpl: CatalogFetch = (url) => globalThis.fetch(url)) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  cached(provider: string, model: string): ModelPricing | undefined {
    const id = catalogId(provider, model);
    const hit = this.#store.get(id);
    if (hit === undefined) return undefined;
    if (pricingIsUsable(provider, model, hit)) return hit;
    if (!this.#warnedUnusable.has(id)) {
      this.#warnedUnusable.add(id);
      shoreLog.warn(
        `shore: catalog pricing for ${id} charges nothing for cache writes, which cannot be ` +
          `right for an Anthropic-priced model; discarding it so calls are left unpriced ` +
          `rather than under-reported`,
      );
    }
    return undefined;
  }

  async getOrFetch(provider: string, model: string): Promise<ModelPricing | undefined> {
    const hit = this.cached(provider, model);
    if (hit) return hit;
    await this.#refreshCatalog(catalogSource(provider));
    return this.cached(provider, model);
  }

  cost(request: CostRequest): CostBreakdown | undefined {
    const pricing = this.cached(request.provider, request.model);
    return pricing ? calculateCost(pricing, request) : undefined;
  }

  async #refreshCatalog(source: CatalogSource): Promise<void> {
    let pending = this.#inflight.get(source.url);
    if (pending === undefined) {
      pending = this.#fetchCatalog(source).finally(() => {
        this.#inflight.delete(source.url);
      });
      this.#inflight.set(source.url, pending);
    }
    await pending;
  }

  async #fetchCatalog(source: CatalogSource): Promise<void> {
    let body: unknown;
    try {
      const response = await this.#fetch(source.url);
      if (!response.ok) {
        this.#catalogUnavailable(source, `HTTP ${response.status}`);
        return;
      }
      body = await response.json();
    } catch (e) {
      this.#catalogUnavailable(source, String(e));
      return;
    }

    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      this.#catalogUnavailable(source, "the response carried no model array");
      return;
    }

    for (const entry of data) {
      const model = entry as { id?: unknown; pricing?: Record<string, unknown> };
      if (typeof model.id !== "string" || !model.pricing) continue;
      this.#store.put(source.key(model.id), source.read(model.id, model.pricing));
    }
  }

  #catalogUnavailable(source: CatalogSource, detail: string): void {
    shoreLog.warn(
      `shore: pricing catalog ${source.url} could not be read (${detail}); models it prices ` +
        `keep whatever cached rates they already have, and calls with none are left unpriced`,
    );
  }
}
