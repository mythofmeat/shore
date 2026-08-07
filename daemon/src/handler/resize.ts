/**
 * Format-aware image downscaling, with a disk cache.
 *
 * Ported from `crates/daemon/src/handler/resize.rs`, pinned by
 * `tests/handler_fixtures/resize_parity.json`.
 *
 * **The encoded bytes are not portable and the fixture does not pretend they
 * are.** Rust used `image` + `fast_image_resize`; this uses libvips through
 * `sharp`. Two different JPEG encoders will not agree byte-for-byte on the same
 * pixels, and no amount of parameter matching changes that. What *is* pinned —
 * and what the fixture covers exhaustively — is every decision made around the
 * encoder: the scale arithmetic, the alpha and format choice, the dimension
 * floor, the quality ladder, the cache key, and the cache lookup order.
 *
 * The one consequence worth stating plainly: the retry paths trigger on
 * *encoded size*, so an image that fits on the first attempt under one encoder
 * may need a retry under the other, and land at different final dimensions.
 * Both stay under the caller's byte limit, which is the property that matters.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import sharp, { type Sharp } from "sharp";

import { mediaTypeForPath } from "./images.ts";

/**
 * Images at or above this on their longest side are never estimated below it.
 *
 * Text in a screenshot stops being legible well before the byte budget runs
 * out, so the estimator would happily produce something the model cannot read.
 * The floor applies to the *first* attempt only — see {@link resizeWithDims}.
 */
export const DIMENSION_FLOOR = 2048;

/** Result of a successful resize. */
export interface ResizeResult {
  bytes: Uint8Array;
  mediaType: string;
}

// ── Scale arithmetic ────────────────────────────────────────────────────

/**
 * `u32::MAX` — the saturation ceiling `f64_to_u32_saturating` imposed.
 *
 * Reachable only through a scale above 1.0, which the callers clamp away, but
 * `scaled_dims` itself does not clamp and the fixture pins that it saturates
 * rather than wrapping.
 */
const U32_MAX = 4_294_967_295;

/** `f64 as u32` with Rust's saturating-cast semantics, on an already-rounded value. */
function saturatingU32(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  return value >= U32_MAX ? U32_MAX : value;
}

/**
 * Apply `scale` to both dimensions, never producing a zero.
 *
 * `Math.round` is half-up and Rust's `f64::round` is half-away-from-zero; the
 * two agree for every non-negative input, which is all that reaches here.
 * The `max(1)` is what stops a brutal budget from asking for a 0-pixel image,
 * which every encoder rejects.
 */
export function scaledDims(w: number, h: number, scale: number): [number, number] {
  return [
    saturatingU32(Math.max(Math.round(w * scale), 1)),
    saturatingU32(Math.max(Math.round(h * scale), 1)),
  ];
}

/**
 * First-attempt dimensions for a transparent image.
 *
 * Byte size scales roughly with area, so the linear scale is the square root of
 * the byte ratio. The 0.85 is deliberate pessimism: overshooting means a second
 * encode, and a second encode of a large PNG is the expensive outcome.
 */
export function planTransparentDims(
  srcW: number,
  srcH: number,
  srcBytes: number,
  maxBytes: number,
): [number, number] {
  return scaledDims(srcW, srcH, Math.min(Math.sqrt(maxBytes / srcBytes) * 0.85, 1.0));
}

/**
 * First-attempt dimensions for an opaque image, which will be re-encoded as JPEG.
 *
 * Two corrections over the naive square root:
 *
 * - **`formatFactor`.** Above 3 bytes per pixel the source is almost certainly
 *   in a format far less efficient than the JPEG it is about to become — a raw
 *   or lightly-compressed PNG — so the budget is treated as 3× larger. Without
 *   it a 4 MB PNG gets scaled as though JPEG would need the same 4 MB, and the
 *   result is needlessly tiny. The threshold is strict: exactly 3.0 does not
 *   trigger it, and the fixture pins both sides.
 * - **The dimension floor.** An image that started at or above
 *   {@link DIMENSION_FLOOR} is pulled back up to it.
 */
export function planOpaqueDims(
  srcW: number,
  srcH: number,
  srcBytes: number,
  maxBytes: number,
): [number, number] {
  const formatFactor = srcBytes / (srcW * srcH) > 3.0 ? 3.0 : 1.0;
  const rawScale = Math.min(Math.sqrt((maxBytes * formatFactor) / srcBytes) * 0.85, 1.0);
  let [newW, newH] = scaledDims(srcW, srcH, rawScale);

  if (Math.max(srcW, srcH) >= DIMENSION_FLOOR && Math.max(newW, newH) < DIMENSION_FLOOR) {
    const boost = DIMENSION_FLOOR / Math.max(newW, newH);
    newW = saturatingU32(Math.round(newW * boost));
    newH = saturatingU32(Math.round(newH * boost));
  }
  return [newW, newH];
}

/**
 * Second-attempt dimensions, corrected by how far the first encode overshot.
 *
 * `factor` is 0.85 on the transparent path and 0.9 on the opaque one — the
 * opaque retry is less pessimistic because it also drops the JPEG quality from
 * 90 to 85, so it is buying headroom twice.
 *
 * **This is not floored.** A brutal budget can and does land below
 * {@link DIMENSION_FLOOR} here, which the fixture records: a 4000×3000 source
 * with a 5 KB budget is planned at 2048×1520 and finishes at 61×46.
 */
export function planRetryDims(
  w: number,
  h: number,
  encodedLen: number,
  maxBytes: number,
  factor: number,
): [number, number] {
  return scaledDims(w, h, Math.min(Math.sqrt(maxBytes / encodedLen) * factor, 1.0));
}

// ── Alpha ───────────────────────────────────────────────────────────────

/**
 * Whether any pixel is less than fully opaque.
 *
 * An image with no alpha channel at all is opaque by construction and is not
 * scanned. One with a channel is scanned, because a PNG that carries alpha and
 * never uses it is common — an editor added it — and converting it to JPEG is
 * both smaller and lossless in the ways that matter.
 *
 * `stats().isOpaque` is libvips' answer to the same question the Rust asked by
 * walking pixels: is the minimum alpha the channel maximum.
 */
export async function hasMeaningfulAlpha(image: Sharp): Promise<boolean> {
  const metadata = await image.metadata();
  if (metadata.hasAlpha !== true) return false;
  try {
    return !(await image.stats()).isOpaque;
  } catch {
    // A stats failure on an image that declares an alpha channel is treated as
    // "assume transparency": staying PNG costs bytes, converting to JPEG would
    // flatten transparency the caller can never get back.
    return true;
  }
}

// ── Encoding ────────────────────────────────────────────────────────────

async function encodeJpeg(
  image: Sharp,
  w: number,
  h: number,
  quality: number,
): Promise<Uint8Array | undefined> {
  try {
    return await image.clone().resize(w, h, { fit: "fill" }).jpeg({ quality }).toBuffer();
  } catch (e) {
    console.warn(`shore: JPEG encode failed: ${String(e)}`);
    return undefined;
  }
}

async function encodePng(
  image: Sharp,
  w: number,
  h: number,
): Promise<Uint8Array | undefined> {
  try {
    // `compressionLevel: 9` is libvips' equivalent of `CompressionType::Best`;
    // adaptive filtering matches `FilterType::Adaptive`.
    return await image
      .clone()
      .resize(w, h, { fit: "fill" })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch (e) {
    console.warn(`shore: PNG encode failed: ${String(e)}`);
    return undefined;
  }
}

// ── The ladder ──────────────────────────────────────────────────────────

/**
 * Transparent images stay PNG, and are only ever scaled down.
 *
 * Never converted to JPEG, however much that would save: flattening
 * transparency against a guessed background is not something the caller can
 * undo, and a wrong guess is far more visible than a larger file.
 */
async function resizeTransparent(
  image: Sharp,
  srcW: number,
  srcH: number,
  srcBytes: number,
  maxBytes: number,
): Promise<ResizeResult | undefined> {
  const [newW, newH] = planTransparentDims(srcW, srcH, srcBytes, maxBytes);
  const first = await encodePng(image, newW, newH);
  if (first === undefined) {
    console.warn("shore: failed to resize transparent image; sending original");
    return undefined;
  }
  if (first.length <= maxBytes) {
    logResize(srcW, srcH, newW, newH, srcBytes, first.length);
    return { bytes: first, mediaType: "image/png" };
  }

  const [retryW, retryH] = planRetryDims(newW, newH, first.length, maxBytes, 0.85);
  const second = await encodePng(image, retryW, retryH);
  if (second === undefined) {
    console.warn("shore: failed to resize transparent image; sending original");
    return undefined;
  }
  if (second.length > maxBytes) {
    // Returned anyway. A best-effort result the provider may reject beats
    // sending the original, which it certainly will.
    console.warn(
      `shore: transparent image still exceeds limit after retry (${second.length} > ${maxBytes}); ` +
        `sending best-effort result`,
    );
  }
  logResize(srcW, srcH, retryW, retryH, srcBytes, second.length);
  return { bytes: second, mediaType: "image/png" };
}

/**
 * Drop JPEG quality without touching dimensions.
 *
 * Tried first for opaque images already within the dimension floor, where
 * re-encoding at 90 or 75 usually clears the budget on its own. Returns
 * `undefined` if neither quality fits, and the caller falls through to scaling.
 */
async function resizeQualityOnly(
  image: Sharp,
  srcW: number,
  srcH: number,
  maxBytes: number,
): Promise<ResizeResult | undefined> {
  for (const quality of [90, 75]) {
    const buf = await encodeJpeg(image, srcW, srcH, quality);
    if (buf !== undefined && buf.length <= maxBytes) {
      console.info(`shore: reduced image quality to ${quality} without dimension change`);
      return { bytes: buf, mediaType: "image/jpeg" };
    }
  }
  return undefined;
}

/** Estimate dimensions, encode as JPEG, and correct once if the estimate missed. */
async function resizeWithDims(
  image: Sharp,
  srcW: number,
  srcH: number,
  srcBytes: number,
  maxBytes: number,
): Promise<ResizeResult | undefined> {
  const [newW, newH] = planOpaqueDims(srcW, srcH, srcBytes, maxBytes);
  const first = await encodeJpeg(image, newW, newH, 90);
  if (first === undefined) {
    console.warn("shore: failed to resize image after retry; sending original");
    return undefined;
  }
  if (first.length <= maxBytes) {
    logResize(srcW, srcH, newW, newH, srcBytes, first.length);
    return { bytes: first, mediaType: "image/jpeg" };
  }

  const [retryW, retryH] = planRetryDims(newW, newH, first.length, maxBytes, 0.9);
  const second = await encodeJpeg(image, retryW, retryH, 85);
  if (second === undefined) {
    console.warn("shore: failed to resize image after retry; sending original");
    return undefined;
  }
  if (second.length > maxBytes) {
    console.warn(
      `shore: image still exceeds limit after retry (${second.length} > ${maxBytes}); ` +
        `sending best-effort result`,
    );
  }
  logResize(srcW, srcH, retryW, retryH, srcBytes, second.length);
  return { bytes: second, mediaType: "image/jpeg" };
}

function logResize(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  srcBytes: number,
  dstBytes: number,
): void {
  console.info(
    `shore: resized image for LLM upload: ${srcW}x${srcH} (${srcBytes} bytes) -> ` +
      `${dstW}x${dstH} (${dstBytes} bytes)`,
  );
}

/**
 * Bring `bytes` under `maxBytes`, or explain why it cannot.
 *
 * Returns `undefined` — meaning "send the original" — when the image is already
 * small enough, when there is no limit, when it is a GIF, or when it cannot be
 * decoded. A GIF is refused rather than flattened because resizing one means
 * dropping every frame but the first, and a still where an animation was is a
 * worse answer than a large file.
 */
export async function smartResize(
  bytes: Uint8Array,
  mediaType: string,
  maxBytes: number,
): Promise<ResizeResult | undefined> {
  if (maxBytes === 0 || bytes.length <= maxBytes) return undefined;

  if (mediaType === "image/gif") {
    console.warn(
      `shore: GIF exceeds max_image_size (${bytes.length} > ${maxBytes}) but resizing is not ` +
        `supported; sending as-is`,
    );
    return undefined;
  }

  const image = sharp(Buffer.from(bytes), { failOn: "none" });
  let srcW: number;
  let srcH: number;
  try {
    const metadata = await image.metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
      throw new Error("no dimensions");
    }
    srcW = metadata.width;
    srcH = metadata.height;
  } catch (e) {
    console.warn(`shore: failed to decode image for resizing; sending original: ${String(e)}`);
    return undefined;
  }

  if (await hasMeaningfulAlpha(image)) {
    return await resizeTransparent(image, srcW, srcH, bytes.length, maxBytes);
  }

  // Opaque and already within the floor: try quality alone before losing
  // pixels, and fall through to scaling only if that is not enough.
  if (Math.max(srcW, srcH) <= DIMENSION_FLOOR) {
    return (
      (await resizeQualityOnly(image, srcW, srcH, maxBytes)) ??
      (await resizeWithDims(image, srcW, srcH, bytes.length, maxBytes))
    );
  }
  return await resizeWithDims(image, srcW, srcH, bytes.length, maxBytes);
}

// ── Cache ───────────────────────────────────────────────────────────────

/**
 * The cache key for one resize.
 *
 * SHA-256 over the path, the modification time in nanoseconds as a
 * **little-endian u128**, and the byte limit as a **little-endian u64**. The
 * widths are load-bearing: they are what the Rust hashed, and a key computed
 * over 8 bytes of mtime instead of 16 collides with nothing but also hits
 * nothing, silently costing a re-encode on every turn.
 *
 * Including the mtime is what makes an edited image re-encode rather than
 * serving a stale crop, and including `maxBytes` is what makes a config change
 * take effect without a manual cache clear.
 *
 * `maxBytes` accepts a bigint because a `u64` does not fit a JS number. Config
 * values are ordinary byte counts far below 2^53, but the key must still be
 * computable for anything the Rust could hash.
 */
export function computeCacheKey(
  path: string,
  mtimeNanos: bigint,
  maxBytes: number | bigint,
): string {
  const hasher = createHash("sha256");
  hasher.update(Buffer.from(path, "utf8"));
  hasher.update(u128LE(mtimeNanos < 0n ? 0n : mtimeNanos));
  hasher.update(u64LE(BigInt(maxBytes)));
  return hasher.digest("hex");
}

function u128LE(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffff_ffff_ffff_ffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/**
 * Look up a cached result. JPEG is checked first.
 *
 * The order is not arbitrary: a key can only ever have produced one format, so
 * a hit on `.jpg` means the `.png` cannot exist. Checking JPEG first makes the
 * common case — an opaque photo — one stat instead of two.
 */
export async function readCache(cacheDir: string, key: string): Promise<ResizeResult | undefined> {
  try {
    return { bytes: await readFile(join(cacheDir, `${key}.jpg`)), mediaType: "image/jpeg" };
  } catch {
    /* fall through to PNG */
  }
  try {
    return { bytes: await readFile(join(cacheDir, `${key}.png`)), mediaType: "image/png" };
  } catch {
    return undefined;
  }
}

/**
 * Store a result. Any media type that is not PNG is filed as `.jpg`.
 *
 * A cache write failure is logged and swallowed — the resized bytes are already
 * in hand and the turn should not fail over a missing cache entry.
 */
export async function writeCache(
  cacheDir: string,
  key: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch (e) {
    console.warn(`shore: failed to create resize cache directory: ${String(e)}`);
    return;
  }
  const ext = mediaType === "image/png" ? "png" : "jpg";
  try {
    await writeFile(join(cacheDir, `${key}.${ext}`), bytes);
  } catch (e) {
    console.warn(`shore: failed to write to resize cache: ${String(e)}`);
  }
}

/**
 * {@link smartResize} with a disk cache under `<cacheDir>/resized/`.
 *
 * The same image is re-sent on every turn of a conversation, so without this
 * every turn pays a full decode and re-encode of every attachment.
 */
export async function cachedResize(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  maxBytes: number,
  cacheDir: string,
): Promise<ResizeResult | undefined> {
  // An IO guard, not a correctness one: {@link smartResize} makes the same
  // check and would return `undefined` anyway. What this saves is a `stat`, a
  // SHA-256, and two directory lookups per image per turn, on the path taken
  // by every image small enough not to need resizing — which is most of them.
  if (maxBytes === 0 || bytes.length <= maxBytes) return undefined;

  // A file we cannot stat hashes as the epoch rather than failing, which makes
  // every such image share one key per (path, limit) — acceptable, because a
  // path we cannot stat is one we just read bytes from anyway.
  let mtimeNanos = 0n;
  try {
    // `bigint: true` is what makes this nanoseconds. The default `Stats`
    // carries `mtimeMs` as a float, which cannot represent the nanosecond
    // precision the Rust hashed — and rounding it would give a key that
    // changes between runs on the same unmodified file.
    mtimeNanos = (await stat(path, { bigint: true })).mtimeNs;
  } catch {
    /* epoch */
  }

  const key = computeCacheKey(path, mtimeNanos, maxBytes);
  const resizedDir = join(cacheDir, "resized");

  const hit = await readCache(resizedDir, key);
  if (hit !== undefined) {
    console.info(`shore: using cached resized image for ${path}`);
    return hit;
  }

  const result = await smartResize(bytes, mediaType, maxBytes);
  if (result === undefined) return undefined;
  await writeCache(resizedDir, key, result.bytes, result.mediaType);
  return result;
}

// ── Pre-warming ─────────────────────────────────────────────────────────

/** The shape {@link warmImageCache} reads out of a prompt. */
export interface WarmableMessage {
  images: { path: string }[];
}

/**
 * Populate the cache for every oversized image in a prompt, concurrently.
 *
 * Without this the first turn after a restart pays every resize serially,
 * inside the request path, while the user waits. Only files that are actually
 * over the limit are touched — the size check is a `stat`, so the common case
 * costs one syscall per image and no decode.
 *
 * Failures are swallowed by design: this is an optimisation, and the request
 * path will do the work again if it has to. The size gate is the same kind of
 * guard as the one in {@link cachedResize} and for the same reason: correctness
 * comes from `cachedResize` re-checking, so removing the gate changes nothing
 * observable — it just reads every attachment in the conversation into memory
 * to discover each one was already small enough.
 */
export async function warmImageCache(
  messages: readonly WarmableMessage[],
  maxBytes: number,
  cacheDir: string,
): Promise<void> {
  if (maxBytes === 0) return;

  const work: { path: string; mediaType: string }[] = [];
  for (const msg of messages) {
    for (const img of msg.images) {
      const mediaType = mediaTypeForPath(img.path);
      if (mediaType === undefined) continue;
      try {
        if ((await stat(img.path)).size > maxBytes) work.push({ path: img.path, mediaType });
      } catch {
        /* unreadable images are the request path's problem, not the warmer's */
      }
    }
  }
  if (work.length === 0) return;

  await Promise.all(
    work.map(async ({ path, mediaType }) => {
      try {
        const bytes = await readFile(path);
        await cachedResize(path, bytes, mediaType, maxBytes, cacheDir);
      } catch (e) {
        console.warn(`shore: image cache warm-up task failed for ${path}: ${String(e)}`);
      }
    }),
  );
}
