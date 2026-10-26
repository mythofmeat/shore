import { extname } from "node:path";
import { IMAGE_EXTENSIONS, imageMime } from "./read_image.ts";

export const MAX_THREAD_FILE_BYTES = 32 * 1024;

export const MAX_THREAD_FILES_BYTES = 128 * 1024;

export function byteSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${String(Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function threadFileText(path: string, bytes: Uint8Array): { text: string } | { reason: string } {
  if (imageMime(Buffer.from(bytes.subarray(0, 12))) !== undefined || IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return { reason: "is a picture" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? { reason: "isn't UTF-8 text" } : { text };
  } catch {
    return { reason: "isn't UTF-8 text" };
  }
}

export function cutToBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const head = bytes.subarray(0, Math.max(0, limit));
  const newline = head.lastIndexOf(0x0a);
  return (newline > 0 ? head.subarray(0, newline) : head).toString("utf8").replace(/\uFFFD+$/, "");
}

export function threadFilePromptText(path: string, bytes: Uint8Array): string {
  const read = threadFileText(path, bytes);
  if ("reason" in read) return `(${path} ${read.reason}, so it isn't shown. A thread file must be text.)`;
  if (bytes.length <= MAX_THREAD_FILE_BYTES) return read.text;
  return `${cutToBytes(read.text, MAX_THREAD_FILE_BYTES).trimEnd()}\n\n[Cut at ${byteSize(MAX_THREAD_FILE_BYTES)} of ${byteSize(bytes.length)}; \`read\` ${path} for the rest.]`;
}
