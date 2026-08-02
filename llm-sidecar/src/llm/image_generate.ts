import OpenAI from "openai";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";
import type { ImageGenerateParams } from "openai/resources/images";

import { readCandidateEnv, resolveKeyCandidates, type ProviderEntry } from "./credentials.ts";
import { hardcodedProviderBaseUrl } from "./request.ts";
import type { ImageRequest, ImageResponse } from "./types.ts";
import { compareRustStrings } from "../memory/lines.ts";

type RequestOptions = { signal?: AbortSignal };
type ImageSize = NonNullable<ImageGenerateParams["size"]>;
type ImageQuality = NonNullable<ImageGenerateParams["quality"]>;

interface OpenRouterImageMessage {
  content?: string | null;
  images?: Array<{ image_url?: { url?: string | null } }>;
}

interface HttpishError extends Error {
  status?: number;
  body?: unknown;
}

export async function generateImage(
  req: ImageRequest,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<ImageResponse> {
  const startedAt = now();
  if (req.provider_key === "openrouter") {
    const result = await generateOpenRouterImage(req, signal);
    return {
      ...result,
      timing: { total_ms: now() - startedAt },
    };
  }

  const client = new OpenAI({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: req.base_url } : {}),
  });
  const params: ImageGenerateParams = {
    model: req.model,
    prompt: req.prompt,
  };
  if (req.size !== undefined) params.size = req.size as ImageSize;
  if (req.quality !== undefined) {
    params.quality = req.quality as ImageQuality;
  }

  const response = await client.images.generate(params, requestOptions(signal));
  const image = response.data?.[0] as
    | { url?: string | null; b64_json?: string | null; revised_prompt?: string | null }
    | undefined;

  return {
    url: image?.url ?? image?.b64_json ?? "",
    revised_prompt: image?.revised_prompt ?? "",
    timing: { total_ms: now() - startedAt },
  };
}

async function generateOpenRouterImage(
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<Omit<ImageResponse, "timing">> {
  const client = new OpenAI({
    apiKey: req.api_key,
    baseURL: req.base_url ?? "https://openrouter.ai/api/v1",
    maxRetries: 0,
  });

  try {
    return await tryOpenRouterImage(client, req, ["image", "text"], signal);
  } catch (e) {
    if (isOutputModalities404(e)) {
      return await tryOpenRouterImage(client, req, ["image"], signal);
    }
    throw e;
  }
}

async function tryOpenRouterImage(
  client: OpenAI,
  req: ImageRequest,
  modalities: string[],
  signal?: AbortSignal,
): Promise<Omit<ImageResponse, "timing">> {
  const imageConfig: Record<string, string> = {};
  if (req.aspect_ratio !== undefined) imageConfig["aspect_ratio"] = req.aspect_ratio;
  if (req.image_size !== undefined) imageConfig["image_size"] = req.image_size;

  const params = {
    model: req.model,
    messages: [{ role: "user", content: req.prompt }],
    modalities,
    ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
  } as unknown as ChatCompletionCreateParams;

  const response = (await client.chat.completions.create(
    params,
    requestOptions(signal),
  )) as unknown as { choices: Array<{ message?: unknown }> };
  const message = response.choices[0]?.message as OpenRouterImageMessage | undefined;
  const url = message?.images?.[0]?.image_url?.url ?? "";
  if (!url) {
    throw providerError("OpenRouter response contained no image data");
  }

  return {
    url,
    revised_prompt: message?.content ?? "",
  };
}

function requestOptions(signal: AbortSignal | undefined): RequestOptions | undefined {
  return signal ? { signal } : undefined;
}

function isOutputModalities404(e: unknown): boolean {
  const err = e as Partial<HttpishError>;
  return err.status === 404 && errorBody(e).includes("output modalities");
}

function errorBody(e: unknown): string {
  const err = e as Partial<HttpishError>;
  if (typeof err.body === "string") return err.body;
  if (err.body !== undefined) {
    try {
      return JSON.stringify(err.body);
    } catch {
      return String(err.body);
    }
  }
  return e instanceof Error ? e.message : String(e);
}

function providerError(message: string): HttpishError {
  const err = new Error(message) as HttpishError;
  err.status = 502;
  return err;
}

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Per-model image-generation settings, from `[image_generation."provider:model_id"]`.
 */
export interface ImageGenSettings {
  /** Default size for the OpenAI path (e.g. `"1024x1024"`). */
  size?: string;
  /** Optional quality hint for the OpenAI path (e.g. `"hd"`). */
  quality?: string;
  /** OpenRouter aspect ratio (e.g. `"1:1"`, `"16:9"`). */
  aspect_ratio?: string;
  /** OpenRouter image size (e.g. `"1K"`, `"2K"`, `"4K"`). */
  image_size?: string;
}

/** Image generation, fully resolved: identity, transport and credential. */
export interface ImageGenConfig {
  provider: string;
  model_id: string;
  api_key: string;
  base_url?: string;
  size: string;
  quality?: string;
  aspect_ratio?: string;
  image_size?: string;
}

export interface ResolveImageGenOptions {
  /** `defaults.image_generation` — a `provider:model_id` identity. */
  defaultRef?: string;
  /** `[image_generation.*]`, keyed by the same identity. */
  imageGen: Record<string, ImageGenSettings>;
  /** `[providers.*]`, keyed by provider. */
  providers: Record<string, { entry?: ProviderEntry; baseUrl?: string }>;
  /** Injected for tests; production reads the real environment. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_IMAGE_SIZE = "1024x1024";

/**
 * Resolve image generation from the model catalog.
 *
 * Lived in `memory/compaction_impls.rs` for historical reasons only — it has
 * nothing to do with compaction, and its callers are the tool-context builders
 * in `autonomy` and `handler`. It belongs beside the thing it configures.
 *
 * Every failure is a plain sentence rather than an exception the caller must
 * classify: this is shown to whoever has to fix the config, and the only thing
 * a caller does with it is give up on image generation for the session.
 *
 * Identity is the configured default, or the sole settings-overlay key when
 * there is exactly one. Two overlay entries with no default is an error rather
 * than a pick: the choice would be `BTreeMap` order, which is not a decision
 * anyone made.
 */
export function resolveImageGenConfig(
  opts: ResolveImageGenOptions,
): { ok: ImageGenConfig } | { err: string } {
  let target: string;
  if (opts.defaultRef !== undefined) {
    target = opts.defaultRef;
  } else {
    const keys = Object.keys(opts.imageGen).sort(compareRustStrings);
    if (keys.length === 1) {
      target = keys[0]!;
    } else if (keys.length > 1) {
      return {
        err:
          'multiple [image_generation."provider:model_id"] entries are configured but ' +
          "defaults.image_generation is unset; set defaults.image_generation to choose one",
      };
    } else {
      return {
        err:
          "no image generation model configured; set defaults.image_generation = " +
          '"provider:model_id" and configure [providers.<provider>] (see CONFIGURATION.md).',
      };
    }
  }

  const colon = target.indexOf(":");
  if (colon < 0) {
    return {
      err:
        `image generation model '${target}' must be a \`provider:model_id\` identity ` +
        "with transport under [providers.<provider>]",
    };
  }
  const providerKey = target.slice(0, colon);
  const modelId = target.slice(colon + 1);
  if (providerKey === "" || modelId === "") {
    return {
      err: `image generation model '${target}' is not a valid \`provider:model_id\` identity`,
    };
  }

  // Transport: the registry's own `base_url`, else the hardcoded default, else
  // the SDK's endpoint.
  const provider = opts.providers[providerKey];
  const baseUrl = provider?.baseUrl ?? hardcodedProviderBaseUrl(providerKey);

  // Credentials: the `[providers.<p>].keys[]` fallback chain, first env-set
  // candidate wins.
  const candidates = resolveKeyCandidates(providerKey, provider?.entry);
  if (candidates.length === 0) {
    return {
      err: `image generation provider '${providerKey}' is disabled in [providers.${providerKey}]`,
    };
  }
  let apiKey: string | undefined;
  for (const candidate of candidates) {
    apiKey = readCandidateEnv(candidate, opts.env);
    if (apiKey !== undefined) break;
  }
  if (apiKey === undefined) {
    return {
      err:
        `image generation API key not set for provider '${providerKey}'; ` +
        `set one of these env vars: ${candidates.map((c) => c.env).join(", ")}`,
    };
  }

  const settings = opts.imageGen[target];
  return {
    ok: {
      provider: providerKey,
      model_id: modelId,
      api_key: apiKey,
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      size: settings?.size ?? DEFAULT_IMAGE_SIZE,
      ...(settings?.quality === undefined ? {} : { quality: settings.quality }),
      ...(settings?.aspect_ratio === undefined ? {} : { aspect_ratio: settings.aspect_ratio }),
      ...(settings?.image_size === undefined ? {} : { image_size: settings.image_size }),
    },
  };
}
