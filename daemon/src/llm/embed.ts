/**
 * Vector embeddings over an OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Ported from `crates/daemon/src/llm/embed.rs`, pinned by
 * `tests/memory_fixtures/workspace_index_parity.json`.
 *
 * The Rust called this "the one LLM call shore makes from Rust" — everything
 * else already routed through this sidecar. With the workspace index moving
 * over too, the exception disappears: this is now an ordinary sidecar client
 * alongside the chat adapters.
 *
 * One body shape covers every supported provider (OpenAI itself, Together,
 * Voyage's compat endpoint, OpenRouter, and self-hosted servers speaking the
 * same shape — text-embedding-inference, llama.cpp's `/v1/embeddings`), so
 * there is no per-provider branching here.
 */

import type { LlmError } from "./errors";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * A source of vectors.
 *
 * `modelId` identifies the model that produced a vector; index entries store
 * it so a model swap invalidates cached vectors rather than silently mixing
 * two vector spaces.
 *
 * The Rust was a `dyn`-compatible trait held as `Arc<dyn Embedder>`; an
 * interface needs no equivalent ceremony. `model_id()` and `dimensions()`
 * were methods only because a trait cannot declare fields.
 */
export interface Embedder {
  /** @throws {LlmError} on transport, status, or malformed-response failures. */
  embed(inputs: string[]): Promise<number[][]>;
  readonly modelId: string;
  /**
   * The *requested* output width, or `undefined` for the model's native
   * width. This is the configured knob, not a measured length: when
   * `undefined`, a returned vector is however long the provider made it.
   */
  readonly dimensions: number | undefined;
}

/**
 * The f32 an `f64 as f32` cast in Rust would produce.
 *
 * Embeddings are stored and compared as f32 all the way through — the wire
 * carries JSON doubles, the index file stores f32, and cosine similarity
 * accumulates in f32. Doing any of that arithmetic in JavaScript's native
 * doubles gives answers that differ in the low bits from the ones the Rust
 * produced, and those numbers are handed to the model verbatim.
 */
export function toF32(value: number): number {
  return Math.fround(value);
}

/**
 * The first `max` *bytes* of `body`, cut back to a character boundary.
 *
 * Rust's `floor_char_boundary` over a byte length; slicing by JS string index
 * would cut by UTF-16 unit and give a different prefix for any non-ASCII body.
 */
export function bodyPreview(body: string, max: number): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= max) return body;
  // `toString` on a cut that lands mid-sequence yields replacement characters;
  // walking back to a lead byte is what `floor_char_boundary` does.
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Build the `/v1/embeddings` request body.
 *
 * `dimensions` maps to OpenAI's `dimensions` field, which asks
 * `text-embedding-3*` models for dimension-reduced vectors. It is emitted only
 * when set — omitting it is what makes the provider return the model's native
 * width, so `0` and "unset" are different requests.
 */
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

/**
 * Read the vectors out of an embeddings response.
 *
 * Every failure is a `provider` error naming the item that went wrong, because
 * a truncated or reshaped response is far more common than a transport fault
 * and "embedding failed" alone is not enough to act on.
 *
 * @throws {LlmError}
 */
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
      // `true` is a number to a loose check but not to serde's `as_f64`.
      if (typeof n !== "number") {
        throw providerError(
          `embedding response item ${itemIdx} has non-numeric value at position ${numIdx}`,
        );
      }
      return toF32(n);
    });
  });
}

/** A hosted OpenAI-compatible embeddings endpoint. */
export class OpenAIEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number | undefined;
  readonly #apiKey: string;
  readonly #baseUrl: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(
    model: string,
    apiKey: string,
    baseUrl: string | undefined,
    dimensions: number | undefined,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.modelId = model;
    this.dimensions = dimensions;
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

/**
 * Process-wide embedder cache.
 *
 * Keyed by an opaque string the caller chooses, so a config change that would
 * produce a different embedder produces a different key rather than reusing
 * the old one. See `resolveEmbedder`, which owns the key format.
 */
const cache = new Map<string, Embedder>();

/** Look up `key`, building and caching the embedder on a miss. */
export function cacheOrBuild(key: string, build: () => Embedder): Embedder {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  cache.set(key, built);
  return built;
}

/** Drop every cached embedder. For tests that assert on cache behaviour. */
export function clearEmbedderCache(): void {
  cache.clear();
}
