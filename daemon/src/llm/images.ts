import fs from "node:fs";
import path from "node:path";

import type { ImageRef } from "../engine/types.ts";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ResolvedImage {
  mediaType: string;
  base64: string;
}

export type ImageResolution = { image: ResolvedImage } | { omitted: string };

export function resolvedImage(resolution: ImageResolution): ResolvedImage | undefined {
  return "image" in resolution ? resolution.image : undefined;
}

export function omissionNotice(label: string, reason: string): string {
  return `[image omitted: ${label} — ${reason}]`;
}

const SUPPORTED_MIME = new Set(Object.values(MIME_BY_EXT));

function base64Bytes(data: string): number {
  const normalized = data.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function tooLarge(bytes: number, maxBytes: number): string {
  return `it is ${String(bytes)} bytes, over the ${String(maxBytes)}-byte limit`;
}

export function resolveImageBlock(
  source: { media_type: string; data: string },
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImageResolution {
  const mediaType = source.media_type?.toLowerCase();
  if (!mediaType || !SUPPORTED_MIME.has(mediaType)) {
    return { omitted: `${source.media_type || "an unlabelled type"} is not a supported format` };
  }
  if (!source.data) return { omitted: "it carried no image data" };
  const bytes = base64Bytes(source.data);
  if (bytes > maxBytes) return { omitted: tooLarge(bytes, maxBytes) };
  return { image: { mediaType, base64: source.data } };
}

export function resolveImage(
  ref: ImageRef,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImageResolution {
  const mediaType = MIME_BY_EXT[path.extname(ref.path).toLowerCase()];
  if (!mediaType) {
    return { omitted: `${path.extname(ref.path) || "no extension"} is not a supported format` };
  }

  if (ref.data !== undefined && ref.data.length > 0) {
    const inlineBytes = base64Bytes(ref.data);
    if (inlineBytes > maxBytes) return { omitted: tooLarge(inlineBytes, maxBytes) };
    return { image: { mediaType, base64: ref.data } };
  }

  try {
    const size = fs.statSync(ref.path).size;
    if (size > maxBytes) return { omitted: tooLarge(size, maxBytes) };
    const bytes = fs.readFileSync(ref.path);
    return { image: { mediaType, base64: bytes.toString("base64") } };
  } catch (e) {
    return { omitted: `it could not be read (${(e as Error).message})` };
  }
}

export function imageLabel(ref: ImageRef): string {
  return path.basename(ref.path);
}
