import { shoreLog } from "../log.ts";

import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContentBlock, ImageRef } from "../engine/types.ts";
import { base64Rejection } from "../tools/images.ts";
import { omissionNotice, resolveImage } from "../llm/images.ts";

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

export function attachmentStamp(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

const MAX_NAME_ATTEMPTS = 1000;

export async function createAttachmentFile(
  attachmentsDir: string,
  fileName: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const dotExt = dot > 0 ? fileName.slice(dot) : "";

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? fileName : `${stem}_${attempt}${dotExt}`;
    const path = join(attachmentsDir, candidate);
    try {
      return { path, handle: await open(path, "wx") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not find a free attachment name for ${fileName}`);
}

async function saveAttachment(
  attachmentsDir: string,
  sourceName: string,
  declaredMime: string | undefined,
  bytes: Uint8Array,
  now: Date = new Date(),
): Promise<ImageRef | undefined> {
  try {
    await mkdir(attachmentsDir, { recursive: true });
  } catch (e) {
    shoreLog.warn(`shore: failed to create attachments directory: ${String(e)}`);
    return undefined;
  }

  const destName = `${attachmentStamp(now)}_${attachmentFileName(sourceName, declaredMime, bytes)}`;
  let claimed: Awaited<ReturnType<typeof createAttachmentFile>>;
  try {
    claimed = await createAttachmentFile(attachmentsDir, destName);
  } catch (e) {
    shoreLog.warn(`shore: failed to create attachment file for ${sourceName}: ${String(e)}`);
    return undefined;
  }

  try {
    await claimed.handle.write(bytes);
  } catch (e) {
    shoreLog.warn(`shore: failed to write image to attachments for ${sourceName}: ${String(e)}`);
    await claimed.handle.close().catch(() => {});
    await Bun.file(claimed.path)
      .unlink()
      .catch(() => {});
    return undefined;
  } finally {
    await claimed.handle.close().catch(() => {});
  }

  shoreLog.info(`shore: saved incoming image to attachments: ${sourceName} -> ${claimed.path}`);
  return { path: claimed.path };
}

export async function ingestImages(
  dataDir: string,
  charName: string,
  imagePaths: readonly string[],
  imageData: readonly ImageUpload[],
  now: Date = new Date(),
): Promise<{ images: ImageRef[]; blocks: ContentBlock[] }> {
  const attachmentsDir = join(dataDir, charName, "images", "attachments");
  const images: ImageRef[] = [];
  const blocks: ContentBlock[] = [];

  const keep = (label: string, ref: ImageRef | undefined): void => {
    if (ref === undefined) {
      blocks.push({ type: "text", text: omissionNotice(label, "it could not be attached") });
      return;
    }
    const resolution = resolveImage(ref);
    if ("omitted" in resolution) {
      blocks.push({ type: "text", text: omissionNotice(label, resolution.omitted) });
      return;
    }
    images.push(ref);
  };

  for (const upload of imageData) {
    keep(upload.filename, await ingestUpload(attachmentsDir, upload, now));
  }

  if (imageData.length === 0) {
    for (const src of imagePaths) {
      keep(src.split(/[/\\]/).pop() ?? src, await ingestLegacyPath(attachmentsDir, src, now));
    }
  } else {
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
  }

  return { images, blocks };
}

async function ingestUpload(
  attachmentsDir: string,
  upload: ImageUpload,
  now: Date,
): Promise<ImageRef | undefined> {
  const rejection = base64Rejection(upload.data);
  if (rejection !== undefined) {
    shoreLog.warn(
      `shore: failed to decode base64 image data for ${upload.filename}: ${rejection}`,
    );
    return undefined;
  }
  const bytes = decodeBase64(upload.data);
  return await saveAttachment(attachmentsDir, upload.filename, upload.mime_type, bytes, now);
}

async function ingestLegacyPath(
  attachmentsDir: string,
  srcPath: string,
  now: Date,
): Promise<ImageRef | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(srcPath);
  } catch {
    if (!(await Bun.file(srcPath).exists())) {
      shoreLog.warn(`shore: skipping non-existent image: ${srcPath}`);
      return undefined;
    }
    shoreLog.warn(`shore: failed to read image for attachments copy: ${srcPath}`);
    return { path: srcPath };
  }

  const name = srcPath.split(/[/\\]/).pop();
  const saved = await saveAttachment(
    attachmentsDir,
    name === undefined || name === "" ? "image" : name,
    undefined,
    bytes,
    now,
  );
  return saved ?? { path: srcPath };
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

export async function buildContent(
  text: string,
  images: readonly ImageRef[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  for (const img of images) {
    const source = await encodeImageBlock(img);
    if (source !== undefined) blocks.push({ type: "image", source });
  }

  if (text.trim() !== "") blocks.push({ type: "text", text });

  return blocks;
}

export async function encodeImageBlock(
  img: ImageRef,
): Promise<{ type: "base64"; media_type: string; data: string } | undefined> {
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

  return {
    type: "base64",
    media_type: mediaType,
    data: Buffer.from(bytes).toString("base64"),
  };
}
