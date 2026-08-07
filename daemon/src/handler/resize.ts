import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import sharp, { type Sharp } from "sharp";

import { mediaTypeForPath } from "./images.ts";

export const DIMENSION_FLOOR = 2048;

export interface ResizeResult {
  bytes: Uint8Array;
  mediaType: string;
}

const U32_MAX = 4_294_967_295;

function saturatingU32(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  return value >= U32_MAX ? U32_MAX : value;
}

export function scaledDims(w: number, h: number, scale: number): [number, number] {
  return [
    saturatingU32(Math.max(Math.round(w * scale), 1)),
    saturatingU32(Math.max(Math.round(h * scale), 1)),
  ];
}

export function planTransparentDims(
  srcW: number,
  srcH: number,
  srcBytes: number,
  maxBytes: number,
): [number, number] {
  return scaledDims(srcW, srcH, Math.min(Math.sqrt(maxBytes / srcBytes) * 0.85, 1.0));
}

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

export function planRetryDims(
  w: number,
  h: number,
  encodedLen: number,
  maxBytes: number,
  factor: number,
): [number, number] {
  return scaledDims(w, h, Math.min(Math.sqrt(maxBytes / encodedLen) * factor, 1.0));
}

export async function hasMeaningfulAlpha(image: Sharp): Promise<boolean> {
  const metadata = await image.metadata();
  if (metadata.hasAlpha !== true) return false;
  try {
    return !(await image.stats()).isOpaque;
  } catch {
    return true;
  }
}

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
    console.warn(
      `shore: transparent image still exceeds limit after retry (${second.length} > ${maxBytes}); ` +
        `sending best-effort result`,
    );
  }
  logResize(srcW, srcH, retryW, retryH, srcBytes, second.length);
  return { bytes: second, mediaType: "image/png" };
}

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

  if (Math.max(srcW, srcH) <= DIMENSION_FLOOR) {
    return (
      (await resizeQualityOnly(image, srcW, srcH, maxBytes)) ??
      (await resizeWithDims(image, srcW, srcH, bytes.length, maxBytes))
    );
  }
  return await resizeWithDims(image, srcW, srcH, bytes.length, maxBytes);
}

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

export async function readCache(cacheDir: string, key: string): Promise<ResizeResult | undefined> {
  try {
    return { bytes: await readFile(join(cacheDir, `${key}.jpg`)), mediaType: "image/jpeg" };
  } catch {
  }
  try {
    return { bytes: await readFile(join(cacheDir, `${key}.png`)), mediaType: "image/png" };
  } catch {
    return undefined;
  }
}

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

export async function cachedResize(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  maxBytes: number,
  cacheDir: string,
): Promise<ResizeResult | undefined> {
  if (maxBytes === 0 || bytes.length <= maxBytes) return undefined;

  let mtimeNanos = 0n;
  try {
    mtimeNanos = (await stat(path, { bigint: true })).mtimeNs;
  } catch {
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

export interface WarmableMessage {
  images: { path: string }[];
}

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
