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
  cache_ttl?: string | undefined;
}

export function toOpenRouterId(provider: string, model: string): string {
  if (provider === "openrouter" || model.includes("/")) return model;
  if (provider === "anthropic") return `anthropic/${normalizeAnthropicModel(model)}`;
  return `${provider}/${model}`;
}

export function isAnthropicPricing(provider: string, model: string): boolean {
  return provider === "anthropic" || model.startsWith("anthropic/");
}

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

function parsePrice(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export function calculateCost(pricing: ModelPricing, request: CostRequest): CostBreakdown {
  const input = pricing.input_per_token * request.input_tokens;
  const output = pricing.output_per_token * request.output_tokens;
  const cache_read = pricing.cache_read_per_token * request.cache_read_tokens;

  let cache_write = pricing.cache_write_per_token * request.cache_write_tokens;
  if (request.provider === "anthropic" && (request.cache_ttl ?? "1h") === "1h") {
    cache_write *= ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER;
  }

  return { input, output, cache_read, cache_write, total: input + output + cache_read + cache_write };
}

export type CatalogFetch = (url: string) => Promise<Response>;

export interface PricingStore {
  get(modelId: string): ModelPricing | undefined;
  put(modelId: string, pricing: ModelPricing): void;
  clear(): void;
}

export class PricingEngine {
  readonly #store: PricingStore;
  readonly #memory = new Map<string, ModelPricing>();
  readonly #fetch: CatalogFetch;
  #inflight: Promise<void> | undefined;

  constructor(store: PricingStore, fetchImpl: CatalogFetch = (url) => globalThis.fetch(url)) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  cached(provider: string, model: string): ModelPricing | undefined {
    const id = toOpenRouterId(provider, model);
    const hit = this.#memory.get(id);
    if (hit) return hit;
    const stored = this.#store.get(id);
    if (stored) this.#memory.set(id, stored);
    return stored;
  }

  async getOrFetch(provider: string, model: string): Promise<ModelPricing | undefined> {
    const hit = this.cached(provider, model);
    if (hit) return hit;
    await this.#refreshCatalog();
    return this.cached(provider, model);
  }

  clearCache(): void {
    this.#store.clear();
    this.#memory.clear();
  }

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
