import fs from "node:fs";
import path from "node:path";

import { namedByHash, sha256Hex } from "../engine/picture_files.ts";
import type { ContentBlock, ImageRef } from "../engine/types.ts";
import { Texts, type TextValues } from "../texts/texts.ts";
import { base64Bytes } from "../util/base64.ts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".apng": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ResolvedImage {
  mediaType: string;
  base64: string;
}

export interface Omission {
  reason: string;
  values?: TextValues;
}

export type ImageResolution = { image: ResolvedImage } | { omitted: Omission };

export function requestTexts(request: { texts?: Texts | undefined }): Texts {
  return request.texts ?? new Texts();
}

export function omissionNotice(texts: Texts, image: string, omission: Omission): string | undefined {
  return texts.render("image_omitted", { image, reason: texts.render(omission.reason, omission.values) });
}

export type ImagePlace = "image_in_message" | "image_in_tool_result";

export function unnamedOmission(texts: Texts, place: ImagePlace, omission: Omission): ContentBlock[] {
  const text = omissionNotice(texts, texts.render(place) ?? "", omission);
  return text === undefined ? [] : [{ type: "text", text }];
}

const SUPPORTED_MIME = new Set(Object.values(MIME_BY_EXT));

function tooLarge(bytes: number, maxBytes: number): Omission {
  return { reason: "image_too_big", values: { bytes: String(bytes), limit: String(maxBytes) } };
}

export function resolveImageBlock(
  source: { media_type: string; data: string },
  maxBytes: number = MAX_IMAGE_BYTES,
): ImageResolution {
  const mediaType = source.media_type?.toLowerCase();
  if (!mediaType || !SUPPORTED_MIME.has(mediaType)) {
    return { omitted: { reason: "image_type", values: { type: source.media_type } } };
  }
  if (!source.data) return { omitted: { reason: "image_no_data" } };
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
    return { omitted: { reason: "image_extension", values: { extension: path.extname(ref.path) } } };
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
    if (ref.sha256 !== undefined && !namedByHash(ref.path, ref.sha256) && sha256Hex(bytes) !== ref.sha256) return { omitted: { reason: "image_changed" } };
    return { image: { mediaType, base64: bytes.toString("base64") } };
  } catch (e) {
    return { omitted: { reason: "image_unreadable", values: { error: (e as Error).message } } };
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
