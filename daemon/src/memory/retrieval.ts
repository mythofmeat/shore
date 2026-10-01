import { required } from "../util/required.ts";

import { readCandidateEnv, resolveKeyCandidates, type ProviderEntry } from "../llm/credentials";
import { cacheOrBuild, OpenAIEmbedder, type Embedder } from "../llm/embed";
import { hardcodedProviderBaseUrl } from "../llm/request";
import { defaultMinSimilarity } from "./closeness.ts";

export interface EmbeddingSettings {
  dimensions?: number;
  minSimilarity?: number;
}

export interface EmbeddingProvider {
  entry?: ProviderEntry;
  baseUrl?: string;
}

export interface ResolveEmbedderOptions {
  defaultRef?: string;
  embedding: Record<string, EmbeddingSettings>;
  providers: Record<string, EmbeddingProvider>;
  fetchImpl?: typeof fetch;
}

function resolveTarget(
  defaultRef: string | undefined,
  embedding: Record<string, EmbeddingSettings>,
): string {
  if (defaultRef !== undefined) return defaultRef;
  const keys = Object.keys(embedding);
  if (keys.length === 1) return required(keys[0]);
  if (keys.length > 1) {
    throw new Error(
      'multiple [embedding."provider:model_id"] entries are configured but ' +
        "embedding.model is unset; set embedding.model to choose one",
    );
  }
  throw new Error(
    "no embedding model configured; semantic search disabled. Set " +
      'embedding.model = "provider:model_id" pointing at an ' +
      "OpenAI-compatible embeddings endpoint and configure " +
      "[providers.<provider>].",
  );
}

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

export function resolveMinSimilarity(
  options: Pick<ResolveEmbedderOptions, "defaultRef" | "embedding">,
): number | undefined {
  let target: string;
  try {
    target = resolveTarget(options.defaultRef, options.embedding);
  } catch {
    return undefined;
  }
  return options.embedding[target]?.minSimilarity ??
    defaultMinSimilarity(target.slice(target.indexOf(":") + 1));
}

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
  const providerKey = target.slice(0, colon);
  const modelId = target.slice(colon + 1);
  if (providerKey === "" || modelId === "") {
    throw new Error(
      `embedding model '${target}' is not a valid \`provider:model_id\` identity`,
    );
  }

  const dimensions = embedding[target]?.dimensions;

  const provider = providers[providerKey];
  const baseUrl = provider?.baseUrl ?? hardcodedProviderBaseUrl(providerKey);
  const apiKey = resolveApiKey(providerKey, provider?.entry);

  const cacheKey = [
    providerKey,
    modelId,
    baseUrl ?? "default",
    dimensions === undefined ? "native" : String(dimensions),
  ].join("::");

  return cacheOrBuild(
    cacheKey,
    () => new OpenAIEmbedder(modelId, apiKey, baseUrl, dimensions, fetchImpl, cacheKey),
  );
}
