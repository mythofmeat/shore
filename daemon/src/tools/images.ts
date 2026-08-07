import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InvalidArgs, ToolIoError } from "./errors.ts";
import { ToolHttpError, type FetchLike } from "./web.ts";

export interface ImageGenConfigView {
  provider: string;
  model_id: string;
  api_key: string;
  base_url?: string;
  size: string;
  quality?: string;
  aspect_ratio?: string;
  image_size?: string;
}

export interface ImageGenerateResult {
  url: string;
  revised_prompt: string;
  timing: { total_ms: number };
}

export type ImageGenerator = (params: {
  provider_key: string;
  model: string;
  api_key: string;
  base_url: string | undefined;
  prompt: string;
  size: string;
  quality: string | undefined;
  aspect_ratio: string | undefined;
  image_size: string | undefined;
}) => Promise<ImageGenerateResult>;

const DOWNLOAD_TIMEOUT_MS = 60_000;

export function decodeDataUrl(url: string): { bytes: Uint8Array; extension: string } {
  const PREFIX = "data:image/";
  if (!url.startsWith(PREFIX)) {
    throw new ToolIoError("data URL is not an image");
  }
  const rest = url.slice(PREFIX.length);

  const sep = rest.indexOf(";base64,");
  if (sep === -1) {
    throw new ToolIoError("data URL missing ;base64, separator");
  }
  const mimeSubtype = rest.slice(0, sep);
  const b64 = rest.slice(sep + ";base64,".length);

  const extension = mimeSubtype === "jpeg" ? "jpg" : mimeSubtype;

  const failure = base64Rejection(b64);
  if (failure !== undefined) {
    throw new ToolIoError(`failed to decode base64 image: ${failure}`);
  }
  return { bytes: decodeBase64(b64), extension };
}

const B64_ALPHABET = /^[A-Za-z0-9+/]$/;

export function base64Rejection(b64: string): string | undefined {
  const firstPad = b64.indexOf("=");
  const padIsPositioned =
    firstPad === -1 || firstPad === b64.length - 1 || firstPad === b64.length - 2;

  for (let i = 0; i < b64.length; i += 1) {
    const ch = b64[i] as string;
    if (B64_ALPHABET.test(ch)) continue;
    if (ch === "=" && padIsPositioned && i >= firstPad) {
      continue;
    }
    return `Invalid symbol ${ch.charCodeAt(0)}, offset ${i}.`;
  }

  const remainder = b64.length % 4;
  if (remainder === 1) return `Invalid input length: ${b64.length}`;
  if (remainder !== 0) return "Invalid padding";
  return undefined;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timestampName(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export interface GenerateImageResult {
  path: string;
  caption: string | undefined;
  revised_prompt: string;
  timing_ms: number;
  sent: boolean;
}

export async function handleGenerateImage(
  input: Record<string, unknown>,
  imageDir: string,
  config: ImageGenConfigView | undefined,
  generate: ImageGenerator | undefined,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<GenerateImageResult> {
  const prompt = input["prompt"];
  if (typeof prompt !== "string") {
    throw new InvalidArgs("missing 'prompt' field");
  }
  if (generate === undefined) {
    throw new ToolIoError("image generation not available: no LLM client");
  }
  if (config === undefined) {
    throw new ToolIoError("no [image_generation] profile configured");
  }

  const rawSize = input["size"];
  const size = typeof rawSize === "string" ? rawSize : config.size;
  const rawCaption = input["caption"];
  const caption = typeof rawCaption === "string" ? rawCaption : undefined;

  let result: ImageGenerateResult;
  try {
    result = await generate({
      provider_key: config.provider,
      model: config.model_id,
      api_key: config.api_key,
      base_url: config.base_url,
      prompt,
      size,
      quality: config.quality,
      aspect_ratio: config.aspect_ratio,
      image_size: config.image_size,
    });
  } catch (e) {
    throw new ToolHttpError(`image generation failed: ${String(e)}`);
  }

  let bytes: Uint8Array;
  let extension: string;
  if (result.url.startsWith("data:")) {
    ({ bytes, extension } = decodeDataUrl(result.url));
  } else {
    let resp: Response;
    try {
      resp = await fetchImpl(result.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ToolHttpError(`failed to download image: ${String(e)}`);
    }
    try {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      throw new ToolHttpError(`failed to read image bytes: ${String(e)}`);
    }
    extension = "png";
  }

  const generatedDir = join(imageDir, "generated");
  try {
    await mkdir(generatedDir, { recursive: true });
  } catch (e) {
    throw new ToolIoError(`failed to create directory: ${String(e)}`);
  }

  const savePath = join(generatedDir, `${timestampName(now)}.${extension}`);
  try {
    await writeFile(savePath, bytes);
  } catch (e) {
    throw new ToolIoError(`failed to save image: ${String(e)}`);
  }

  return {
    path: savePath,
    caption,
    revised_prompt: result.revised_prompt,
    timing_ms: result.timing.total_ms,
    sent: true,
  };
}
