import type { FileHandle } from "node:fs/promises";
import { ToolIoError } from "./errors.ts";
import { openRegularFile, readBoundedFile } from "./file_access.ts";
import type { ToolMediaItem } from "./media.ts";
import { MAX_IMAGE_BYTES } from "../llm/images.ts";

export function imageMime(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function readImage(file: FileHandle, path: string, mime: string, signal?: AbortSignal): Promise<{ description: string; image: ToolMediaItem }> {
  const data = await readBoundedFile(file, path, MAX_IMAGE_BYTES, "image", signal);
  const metadata = await new Bun.Image(data).metadata().catch(() => undefined);
  if (metadata === undefined) throw new ToolIoError(`${path}: image could not be decoded`);
  return {
    description: `${path}: ${mime}, ${metadata.width}×${metadata.height}, ${data.length} bytes`,
    image: { mime_type: mime, data: data.toString("base64"), label: path, path },
  };
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
