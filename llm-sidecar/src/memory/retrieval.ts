/**
 * Choosing the embedder from config.
 *
 * Ported from `crates/daemon/src/memory/retrieval.rs`, pinned by
 * `tests/memory_fixtures/workspace_index_parity.json`.
 *
 * There is no bundled local embedder. Semantic search needs an
 * OpenAI-compatible embeddings endpoint — hosted or self-hosted
 * (text-embedding-inference, llama.cpp's `/v1/embeddings`) — and when nothing
 * is configured, hybrid search degrades to lexical at the call site. That is
 * why every failure here is a plain sentence: it is shown to whoever has to
 * fix the config, and it is not an exception the caller must handle.
 *
 * Identity is a bare `provider:model_id`. Transport and credentials come from
 * `[providers.<provider>]`, on the same key-fallback contract chat uses;
 * optional `[embedding."provider:model_id"]` settings carry `dimensions`.
 */

import { readCandidateEnv, resolveKeyCandidates, type ProviderEntry } from "../llm/credentials";
import { cacheOrBuild, OpenAIEmbedder, type Embedder } from "../llm/embed";

/** Per-model embedding settings, from `[embedding."provider:model_id"]`. */
export interface EmbeddingSettings {
  /** Requested output width. Unset means the model's native width. */
  dimensions?: number;
}

/** What resolution needs to know about one `[providers.<key>]` entry. */
export interface EmbeddingProvider {
  entry?: ProviderEntry;
  /** The entry's own `base_url`, when it sets one. */
  baseUrl?: string;
}

export interface ResolveEmbedderOptions {
  /** `defaults.embedding`. */
  defaultRef?: string;
  /** `[embedding.*]`, keyed by `provider:model_id`. */
  embedding: Record<string, EmbeddingSettings>;
  /** `[providers.*]`, keyed by provider. */
  providers: Record<string, EmbeddingProvider>;
  /** Injected for tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The conventional endpoint for a provider, used when its entry sets no
 * `base_url`.
 *
 * This is **not** the same table as `llm/request.ts`'s `defaultBaseUrl`, and
 * merging them would be a bug in both directions: that one answers "where does
 * chat go", this one answers "where do embeddings go", and the Rust kept them
 * as separate tables that genuinely disagree — `deepseek` carries a `/v1`
 * suffix here and not there, `zhipuai` and `nanogpt` have an endpoint here and
 * none there, and `anthropic` is the other way around.
 *
 * An absent answer is not a failure: it means the OpenAI-compatible default
 * endpoint, which is what an unrecognised self-hosted provider wants.
 */
export function embeddingProviderBaseUrl(providerKey: string): string | undefined {
  switch (providerKey) {
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "moonshot":
    case "moonshotai":
      return "https://api.moonshot.ai/v1";
    case "xai":
      return "https://api.x.ai/v1";
    case "zhipuai":
      return "https://open.bigmodel.cn/api/paas/v4";
    case "nanogpt":
      return "https://nano-gpt.com/api/v1";
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1";
    default:
      return undefined;
  }
}

/**
 * The embedding identity to use: the configured default, else the sole
 * `[embedding.*]` key.
 *
 * With several entries and no default, this fails rather than picking one.
 * The Rust's comment for that was "the choice would be arbitrary (BTreeMap
 * order)" — which is also why a plain object is fine here despite the Rust
 * using an ordered map. The only branch that reads more than one key is the
 * one that refuses to choose.
 */
function resolveTarget(
  defaultRef: string | undefined,
  embedding: Record<string, EmbeddingSettings>,
): string {
  if (defaultRef !== undefined) return defaultRef;
  const keys = Object.keys(embedding);
  if (keys.length === 1) return keys[0]!;
  if (keys.length > 1) {
    throw new Error(
      'multiple [embedding."provider:model_id"] entries are configured but ' +
        "defaults.embedding is unset; set defaults.embedding to choose one",
    );
  }
  throw new Error(
    "no embedding model configured; semantic search disabled. Set " +
      'defaults.embedding = "provider:model_id" pointing at an ' +
      "OpenAI-compatible embeddings endpoint and configure " +
      "[providers.<provider>] (see CONFIGURATION.md).",
  );
}

/**
 * The API key for an embedding provider, via the `[providers.<p>].keys[]`
 * fallback chain — the first candidate whose env var is set wins.
 *
 * An empty candidate list means the provider is *disabled*, which is a
 * different failure from having no key set, and says so.
 */
function resolveApiKey(providerKey: string, entry: ProviderEntry | undefined): string {
  const candidates = resolveKeyCandidates(providerKey, entry);
  if (candidates.length === 0) {
    throw new Error(
      `embedding provider '${providerKey}' is disabled in [providers.${providerKey}]`,
    );
  }
  for (const candidate of candidates) {
    const value = readCandidateEnv(candidate);
    if (value !== undefined) return value;
  }
  throw new Error(
    `embedding API key not set for provider '${providerKey}'; ` +
      `set one of these env vars: ${candidates.map((c) => c.env).join(", ")}`,
  );
}

/**
 * Build, or fetch from the process-wide cache, the configured embedder.
 *
 * @throws {Error} when nothing is configured, the identity is not a hosted
 * `provider:model_id`, the provider is disabled, or no key is set. Callers
 * degrade hybrid search to lexical on any of these.
 */
export function resolveEmbedder(options: ResolveEmbedderOptions): Embedder {
  const { defaultRef, embedding, providers, fetchImpl } = options;
  const target = resolveTarget(defaultRef, embedding);

  const colon = target.indexOf(":");
  if (colon === -1) {
    throw new Error(
      `embedding model '${target}' is not a \`provider:model_id\` identity. ` +
        "Hosted semantic search needs an OpenAI-compatible embeddings endpoint " +
        '(e.g. "openai:text-embedding-3-large") with transport under ' +
        "[providers.<provider>]; bundled local ids are not served at runtime.",
    );
  }
  // Split on the *first* colon: a model id may contain more of them.
  const providerKey = target.slice(0, colon);
  const modelId = target.slice(colon + 1);
  if (providerKey === "" || modelId === "") {
    throw new Error(
      `embedding model '${target}' is not a valid \`provider:model_id\` identity`,
    );
  }

  // "Unset" stays unset so the wire request omits `dimensions` and the provider
  // returns the model's native width. Substituting a default here would
  // silently dimension-reduce any model that is not 1536 wide.
  //
  // The Rust also guarded a `usize::try_from` on this value; the field is a
  // `u32`, so that conversion cannot fail on any platform shore runs on. The
  // guard is dropped rather than reproduced as an unreachable branch.
  const dimensions = embedding[target]?.dimensions;

  const provider = providers[providerKey];
  const baseUrl = provider?.baseUrl ?? embeddingProviderBaseUrl(providerKey);
  const apiKey = resolveApiKey(providerKey, provider?.entry);

  const cacheKey = [
    providerKey,
    modelId,
    baseUrl ?? "default",
    dimensions === undefined ? "native" : String(dimensions),
  ].join("::");

  return cacheOrBuild(
    cacheKey,
    () => new OpenAIEmbedder(modelId, apiKey, baseUrl, dimensions, fetchImpl),
  );
}
