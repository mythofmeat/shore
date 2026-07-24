import OpenAI from "openai";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";
import type { ImageGenerateParams } from "openai/resources/images";

import type { ImageRequest, ImageResponse } from "./types.ts";

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
