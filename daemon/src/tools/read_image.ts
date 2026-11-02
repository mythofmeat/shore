import type { FileHandle } from "node:fs/promises";
import { ToolIoError } from "./errors.ts";
import { openRegularFile, readBoundedFile } from "./file_access.ts";
import type { ToolMediaItem } from "./media.ts";
import { MAX_IMAGE_BYTES } from "../llm/images.ts";
import { DEFAULT_IMAGE_LIMITS, ORIGINAL_IMAGE_SETTINGS, reduceImage } from "../llm/prepare_images.ts";
import { firstVideoFrame } from "./video.ts";

export const MAX_READ_IMAGE_BYTES = 64 * 1024 * 1024;

export const IMAGE_EXTENSIONS = new Set([".png", ".apng", ".jpg", ".jpeg", ".webp", ".gif"]);

export function imageMime(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function withinImageLimit(path: string, image: ToolMediaItem, bytes: number): Promise<ToolMediaItem> {
  if (bytes <= MAX_IMAGE_BYTES) return image;
  const fitted = await reduceImage({ type: "base64", media_type: image.mime_type, data: image.data }, ORIGINAL_IMAGE_SETTINGS, DEFAULT_IMAGE_LIMITS)
    .catch((error: unknown) => { throw new ToolIoError(`${path}: image could not be reduced: ${error instanceof Error ? error.message : String(error)}`); });
  return { ...image, mime_type: fitted.source.media_type, data: fitted.source.data, reducedFrom: fitted.original };
}

export async function readImage(file: FileHandle, path: string, mime: string, signal?: AbortSignal): Promise<{ description: string; image: ToolMediaItem }> {
  const data = await readBoundedFile(file, path, MAX_READ_IMAGE_BYTES, "image", signal);
  const metadata = await new Bun.Image(data).metadata().catch(() => undefined);
  if (metadata === undefined) throw new ToolIoError(`${path}: image could not be decoded`);
  const description = `${path}: ${mime}, ${metadata.width}×${metadata.height}, ${data.length} bytes`;
  return { description, image: await withinImageLimit(path, { mime_type: mime, data: data.toString("base64"), label: path, path }, data.length) };
}

export async function readVideoFrame(file: FileHandle, path: string, mime: string, signal?: AbortSignal): Promise<{ description: string; image: ToolMediaItem }> {
  const size = String((await file.stat()).size);
  const frame = await firstVideoFrame(path, signal);
  if (frame === undefined) throw new ToolIoError(`${path}: ${mime}, ${size} bytes; its first frame could not be read, because ffmpeg is missing or could not decode it`);
  const description = `${path}: ${mime}, ${size} bytes; this is its first frame`;
  return { description, image: await withinImageLimit(path, { mime_type: "image/png", data: frame.toString("base64"), label: path }, frame.length) };
}

export async function readImageAt(path: string, accept: (bytes: number) => boolean, signal?: AbortSignal): Promise<ToolMediaItem | undefined> {
  signal?.throwIfAborted();
  const file = await openRegularFile(path);
  try {
    if (!accept((await file.stat()).size)) return undefined;
    const header = Buffer.alloc(12);
    const head = await file.read(header, 0, header.length, 0);
    const mime = imageMime(header.subarray(0, head.bytesRead));
    if (mime === undefined) throw new ToolIoError(`${path}: invalid or unsupported image data`);
    return (await readImage(file, path, mime, signal)).image;
  } finally {
    await file.close();
  }
}
