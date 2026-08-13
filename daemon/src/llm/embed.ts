import type { LlmError } from "./errors";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface Embedder {
  embed(inputs: string[]): Promise<number[][]>;
  readonly modelId: string;
  readonly dimensions: number | undefined;
  readonly identity?: string;
}

export function toF32(value: number): number {
  return Math.fround(value);
}

export function bodyPreview(body: string, max: number): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= max) return body;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function buildEmbedBody(
  model: string,
  input: string[],
  dimensions: number | undefined,
): Record<string, unknown> {
  return {
    model,
    input,
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
}

function providerError(message: string): LlmError {
  return { kind: "provider", message };
}

export function parseEmbeddingResponse(resp: unknown, expectedCount: number): number[][] {
  const data = (resp as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw providerError("embedding response missing data array");
  }
  if (data.length !== expectedCount) {
    throw providerError(
      `embedding response returned ${data.length} vectors for ${expectedCount} inputs`,
    );
  }

  return data.map((item, itemIdx) => {
    const nums = (item as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(nums)) {
      throw providerError(`embedding response item ${itemIdx} missing embedding array`);
    }
    return nums.map((n, numIdx) => {
      if (typeof n !== "number") {
        throw providerError(
          `embedding response item ${itemIdx} has non-numeric value at position ${numIdx}`,
        );
      }
      return toF32(n);
    });
  });
}

export class OpenAIEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number | undefined;
  readonly identity?: string;
  readonly #apiKey: string;
  readonly #baseUrl: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(
    model: string,
    apiKey: string,
    baseUrl: string | undefined,
    dimensions: number | undefined,
    fetchImpl: typeof fetch = fetch,
    identity?: string,
  ) {
    this.modelId = model;
    this.dimensions = dimensions;
    if (identity !== undefined) this.identity = identity;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    const base = this.#baseUrl ?? OPENAI_BASE_URL;
    let response: Response;
    try {
      response = await this.#fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildEmbedBody(this.modelId, inputs, this.dimensions)),
      });
    } catch (e) {
      throw { kind: "transport", message: String(e) } satisfies LlmError;
    }

    const text = await response.text();
    if (!response.ok) {
      throw { kind: "http_status", status: response.status, body: text } satisfies LlmError;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw providerError(
        `embedding response was not valid JSON: ${e instanceof Error ? e.message : String(e)}; ` +
          `body preview: ${bodyPreview(text, 200)}`,
      );
    }
    return parseEmbeddingResponse(parsed, inputs.length);
  }
}

const cache = new Map<string, Embedder>();

export function cacheOrBuild(key: string, build: () => Embedder): Embedder {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  cache.set(key, built);
  return built;
}

export function clearEmbedderCache(): void {
  cache.clear();
}
