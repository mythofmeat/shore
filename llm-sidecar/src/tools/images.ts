/**
 * `generate_image` — make an image and hand the model back a path to it.
 *
 * Ported from `crates/daemon/src/tools/images.rs`, pinned by
 * `tests/tools_fixtures/web_images_parity.json`.
 *
 * The generation call itself is `llm/image_generate.ts`. What lives here is
 * what happens to the result: a provider returns either a data URL or an HTTP
 * one, and either way the bytes end up on disk under the character's image
 * directory with a timestamped name.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InvalidArgs, ToolIoError } from "./errors.ts";
import { ToolHttpError, type FetchLike } from "./web.ts";

/** `[image_generation]`, as this module reads it. */
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

/** What the generation call returns. */
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

/**
 * Decode a `data:image/…;base64,…` URL into bytes and a file extension.
 *
 * The extension is the MIME subtype verbatim, with one rewrite: `jpeg` becomes
 * `jpg`. Anything else is used as given, so `image/svg+xml` yields a file
 * ending `.svg+xml`. Odd, and reproduced — the alternative is a whitelist that
 * silently drops formats a provider might add.
 *
 * The prefix match is case-sensitive, matching `strip_prefix`, so a provider
 * shouting `DATA:IMAGE/PNG;` is rejected rather than quietly accepted.
 */
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

/**
 * Why the `base64` crate would reject `b64`, or `undefined` if it would not.
 *
 * `atob` and `Buffer.from(…, "base64")` are both lenient: they skip characters
 * outside the alphabet and accept unpadded input, so `"aGVsbG8"` and
 * `"!!!not-base64!!!"` decode to *something* rather than failing. The Rust
 * engine rejects both, and the difference is the model being told its image
 * failed versus being handed a truncated file.
 *
 * The messages are reproduced verbatim because they reach the model through
 * the tool result. Three shapes, in the order the crate reports them:
 *
 * - `Invalid symbol {code}, offset {i}.` — trailing period included. A `=`
 *   anywhere but the final one or two positions counts as an invalid symbol,
 *   which is how `aG=sbG8=` and `aGVsbG8===` are caught.
 * - `Invalid input length: {n}` — when `n % 4 == 1`, a length no padding can
 *   explain.
 * - `Invalid padding` — the remaining `n % 4` of 2 or 3.
 */
function base64Rejection(b64: string): string | undefined {
  // An empty payload needs no special case: it has no symbols to reject and a
  // length of 0, so it falls through as the valid zero-byte image it is.
  const firstPad = b64.indexOf("=");
  // Padding is legal only as the last one or two characters of a full quantum.
  const padIsPositioned =
    firstPad === -1 || firstPad === b64.length - 1 || firstPad === b64.length - 2;

  for (let i = 0; i < b64.length; i += 1) {
    const ch = b64[i] as string;
    if (B64_ALPHABET.test(ch)) continue;
    if (ch === "=" && padIsPositioned && i >= firstPad) {
      // Everything from the first `=` on must also be `=`.
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

/** `chrono::Local::now().format("%Y%m%d_%H%M%S")`. */
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

/**
 * Handle `generate_image`.
 *
 * `size` falls back to the profile's, but `quality` / `aspect_ratio` /
 * `image_size` are profile-only — the tool schema offers no way to set them
 * per call, and the provider adapters treat an absent one differently from an
 * empty one.
 *
 * A missing generator or profile reports `io:`, not "not implemented": the
 * tool is registered and routed, it just has nothing behind it on this path.
 */
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
    // A downloaded image is assumed PNG. The Rust did not sniff either — the
    // extension is for the filename, and every consumer reads the bytes.
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
