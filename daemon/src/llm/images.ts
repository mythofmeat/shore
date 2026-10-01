import fs from "node:fs";
import path from "node:path";

import type { ImageRef } from "../engine/types.ts";
import { base64Bytes } from "../util/base64.ts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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

function tooLarge(bytes: number, maxBytes: number): string {
  return `it is ${String(bytes)} bytes, over the ${String(maxBytes)}-byte limit`;
}

export function resolveImageBlock(
  source: { media_type: string; data: string },
  maxBytes: number = MAX_IMAGE_BYTES,
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
  maxBytes: number = MAX_IMAGE_BYTES,
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

const MODEL_COPY_TYPES: readonly (readonly [string, string])[] = [["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"]];

function modelCopyAt(original: string, extension: string): string {
  return path.join(path.dirname(original), "model", `${path.basename(original)}.${extension}`);
}

export function modelCopyPath(original: string, mediaType: string): string | undefined {
  const extension = MODEL_COPY_TYPES.find(([, type]) => type === mediaType)?.[0];
  return extension === undefined ? undefined : modelCopyAt(original, extension);
}

export function modelCopies(original: string): string[] {
  return MODEL_COPY_TYPES
    .map(([extension]) => modelCopyAt(original, extension))
    .filter((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
}

export function findModelCopy(original: string): { path: string; mediaType: string } | undefined {
  for (const [extension, mediaType] of MODEL_COPY_TYPES) {
    const candidate = modelCopyAt(original, extension);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) return { path: candidate, mediaType };
  }
  return undefined;
}
