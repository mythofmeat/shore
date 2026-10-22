import { attachmentCacheDir, keepCachedImage, markImagesUsed, noteCachedImages } from "../storage/image_cache.ts";
import { shoreLog } from "../log.ts";

import { readFile } from "node:fs/promises";

import type { ContentBlock, ImageRef } from "../engine/types.ts";
import { base64Rejection } from "../tools/images.ts";
import { findModelCopy, modelCopyPath, omissionNotice, resolveImage } from "../llm/images.ts";
import { prepareImageBlock, reduceImage } from "../llm/prepare_images.ts";
import { DEFAULT_IMAGE_SETTINGS, type ImageSettings } from "../llm/image_settings.ts";
import { atomicWrite } from "../engine/atomic.ts";

export interface ImageUpload {
  filename: string;
  mime_type?: string;
  data: string;
}

export function mediaTypeForPath(path: string): string | undefined {
  const ext = asciiLowercase(path.split(".").pop() ?? "");
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && bytes.length >= 12 && matchesAt(bytes, 8, ascii("WEBP"))) {
    return "image/webp";
  }
  return undefined;
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return matchesAt(bytes, 0, prefix);
}

function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((b, i) => bytes[offset + i] === b);
}

export function extensionForMediaType(mediaType: string): string | undefined {
  const essence = asciiLowercase((mediaType.split(";")[0] ?? mediaType).trim());
  switch (essence) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return undefined;
  }
}

export function sanitizeFilename(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? name;
  const base = last.replaceAll("\u0000", "");
  return base === "" || base === "." || base === ".." ? "image" : base;
}

export function attachmentFileName(
  filename: string,
  declaredMime: string | undefined,
  bytes: Uint8Array,
): string {
  const safe = sanitizeFilename(filename);
  if (mediaTypeForPath(safe) !== undefined) return safe;

  const sniffed = sniffMediaType(bytes);
  const extension =
    (sniffed === undefined ? undefined : extensionForMediaType(sniffed)) ??
    (declaredMime === undefined ? undefined : extensionForMediaType(declaredMime));

  if (extension !== undefined) return `${safe}.${extension}`;
  shoreLog.warn(
    `shore: could not determine image type from bytes, declared mime, or extension for ` +
      `${safe}; the LLM pipeline will skip this attachment`,
  );
  return safe;
}

async function saveAttachment(
  attachmentsDir: string,
  sourceName: string,
  declaredMime: string | undefined,
  bytes: Uint8Array,
): Promise<{ ref: ImageRef; added: boolean } | undefined> {
  const name = attachmentFileName(sourceName, declaredMime, bytes);
  const extension = mediaTypeForPath(name) === undefined ? undefined : asciiLowercase(name.slice(name.lastIndexOf(".") + 1));
  let kept: Awaited<ReturnType<typeof keepCachedImage>>;
  try {
    kept = await keepCachedImage(attachmentsDir, bytes, extension);
  } catch (e) {
    shoreLog.warn(`shore: failed to save image to attachments for ${sourceName}: ${String(e)}`);
    return undefined;
  }
  if (kept.added) shoreLog.info(`shore: saved incoming image to attachments: ${sourceName} -> ${kept.path}`);
  return { ref: { path: kept.path, name: sanitizeFilename(sourceName), sha256: kept.sha256 }, added: kept.added };
}

export async function ingestImages(
  cacheDir: string,
  charName: string,
  imagePaths: readonly string[],
  imageData: readonly ImageUpload[],
  settings: Readonly<ImageSettings> = DEFAULT_IMAGE_SETTINGS,
): Promise<{ images: ImageRef[]; blocks: ContentBlock[] }> {
  const attachmentsDir = attachmentCacheDir(cacheDir, charName);
  const images: ImageRef[] = [];
  const blocks: ContentBlock[] = [];

  const keep = async (label: string, saved: { ref: ImageRef; added: boolean; bytes: Uint8Array } | undefined): Promise<void> => {
    if (saved === undefined) {
      blocks.push({ type: "text", text: omissionNotice(label, "it could not be attached") });
      return;
    }
    const added = saved.added ? saved.bytes.byteLength : 0;
    const resolution = resolveImage(saved.ref);
    if ("omitted" in resolution) {
      blocks.push({ type: "text", text: omissionNotice(label, resolution.omitted) });
      if (added > 0) noteCachedImages(cacheDir, added);
      return;
    }
    const copied = findModelCopy(saved.ref.path) === undefined ? await saveModelCopy(saved.ref.path, saved.bytes, settings) : 0;
    images.push(saved.ref);
    if (added + copied > 0) noteCachedImages(cacheDir, added + copied);
  };

  for (const upload of imageData) {
    await keep(upload.filename, await ingestUpload(attachmentsDir, upload));
  }

  let uploadIndex = 0;
  for (const src of imagePaths) {
    const label = src.split(/[/\\]/).pop() ?? src;
    if (imageData[uploadIndex]?.filename === label) {
      uploadIndex += 1;
    } else {
      blocks.push({
        type: "text",
        text: omissionNotice(label, "the client could not upload it"),
      });
    }
  }

  return { images, blocks };
}

async function ingestUpload(
  attachmentsDir: string,
  upload: ImageUpload,
): Promise<{ ref: ImageRef; added: boolean; bytes: Uint8Array } | undefined> {
  const rejection = base64Rejection(upload.data);
  if (rejection !== undefined) {
    shoreLog.warn(
      `shore: failed to decode base64 image data for ${upload.filename}: ${rejection}`,
    );
    return undefined;
  }
  const bytes = decodeBase64(upload.data);
  const saved = await saveAttachment(attachmentsDir, upload.filename, upload.mime_type, bytes);
  return saved === undefined ? undefined : { ...saved, bytes };
}

async function saveModelCopy(original: string, bytes: Uint8Array, settings: Readonly<ImageSettings>): Promise<number> {
  const mediaType = sniffMediaType(bytes);
  if (mediaType === undefined) return 0;
  try {
    const reduced = await reduceImage({ type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") }, settings);
    const target = modelCopyPath(original, reduced.source.media_type);
    if (target === undefined) return 0;
    const copy = Buffer.from(reduced.source.data, "base64");
    await atomicWrite(target, copy);
    return copy.byteLength;
  } catch (e) {
    shoreLog.warn(`shore: could not reduce ${original} for the model; it will be sent the way older attachments are: ${String(e)}`);
    return 0;
  }
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

export async function encodeImageBlock(
  img: ImageRef,
  markUsed = false,
): Promise<{ type: "base64"; media_type: string; data: string } | undefined> {
  const copy = findModelCopy(img.path);
  if (markUsed) markImagesUsed([img.path]);
  if (copy !== undefined) {
    try {
      return { type: "base64", media_type: copy.mediaType, data: (await readFile(copy.path)).toString("base64") };
    } catch (e) {
      shoreLog.warn(`shore: failed to read the model's copy of ${img.path}; sending the original instead: ${String(e)}`);
    }
  }

  const mediaType = mediaTypeForPath(img.path);
  if (mediaType === undefined) {
    shoreLog.warn(`shore: skipping image with unsupported extension: ${img.path}`);
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(img.path);
  } catch (e) {
    shoreLog.warn(`shore: failed to read image file for LLM: ${img.path}: ${String(e)}`);
    return undefined;
  }

  try {
    const prepared = await prepareImageBlock({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
    });
    return prepared.type === "image" ? prepared.source : undefined;
  } catch (e) {
    shoreLog.warn(`shore: failed to prepare image for LLM: ${img.path}: ${String(e)}`);
    return undefined;
  }
}
