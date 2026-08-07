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

const SUPPORTED_MIME = new Set(Object.values(MIME_BY_EXT));

function base64Bytes(data: string): number {
  const normalized = data.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

export function resolveImageBlock(
  source: { media_type: string; data: string },
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ResolvedImage | undefined {
  const mediaType = source.media_type?.toLowerCase();
  if (!mediaType || !SUPPORTED_MIME.has(mediaType)) {
    console.warn(`[image] unsupported media type ${source.media_type}; skipping`);
    return undefined;
  }
  if (!source.data) return undefined;
  const bytes = base64Bytes(source.data);
  if (bytes > maxBytes) {
    console.warn(
      `[image] inline image block is ${bytes} bytes; exceeds cap ${maxBytes}; skipping`,
    );
    return undefined;
  }
  return { mediaType, base64: source.data };
}

export function resolveImage(
  ref: ImageRef,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ResolvedImage | undefined {
  const mediaType = MIME_BY_EXT[path.extname(ref.path).toLowerCase()];
  if (!mediaType) {
    console.warn(`[image] unsupported extension for ${ref.path}; skipping`);
    return undefined;
  }

  if (ref.data !== undefined && ref.data.length > 0) {
    const inlineBytes = base64Bytes(ref.data);
    if (inlineBytes > maxBytes) {
      console.warn(
        `[image] inline image ${ref.path} is ${inlineBytes} bytes; exceeds cap ${maxBytes}; skipping`,
      );
      return undefined;
    }
    return { mediaType, base64: ref.data };
  }

  try {
    const size = fs.statSync(ref.path).size;
    if (size > maxBytes) {
      console.warn(
        `[image] ${ref.path} is ${size} bytes; exceeds cap ${maxBytes}; skipping`,
      );
      return undefined;
    }
    const bytes = fs.readFileSync(ref.path);
    return { mediaType, base64: bytes.toString("base64") };
  } catch (e) {
    console.warn(`[image] could not read ${ref.path}: ${(e as Error).message}`);
    return undefined;
  }
}

