import { extname } from "node:path";
import { IMAGE_EXTENSIONS, imageMime } from "./read_image.ts";
import type { Texts } from "../texts/texts.ts";

export const MAX_THREAD_PIN_BYTES = 32 * 1024;

export const MAX_THREAD_PINS_BYTES = 128 * 1024;

export function byteSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${String(Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function threadFileText(texts: Texts, path: string, bytes: Uint8Array): { text: string } | { reason: string } {
  if (imageMime(Buffer.from(bytes)) !== undefined || IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return { reason: texts.always("pin_is_picture") };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? { reason: texts.always("pin_not_utf8") } : { text };
  } catch {
    return { reason: texts.always("pin_not_utf8") };
  }
}

export function cutToBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const head = bytes.subarray(0, Math.max(0, limit));
  const newline = head.lastIndexOf(0x0a);
  return (newline > 0 ? head.subarray(0, newline) : head).toString("utf8").replace(/\uFFFD+$/, "");
}

export function threadFilePromptText(texts: Texts, path: string, bytes: Uint8Array): string {
  const read = threadFileText(texts, path, bytes);
  if ("reason" in read) return texts.render("pin_file_unshown", { path, reason: read.reason }) ?? "";
  if (bytes.length <= MAX_THREAD_PIN_BYTES) return read.text;
  const cut = texts.render("pin_file_cut", { limit: byteSize(MAX_THREAD_PIN_BYTES), total: byteSize(bytes.length), path });
  const head = cutToBytes(read.text, MAX_THREAD_PIN_BYTES).trimEnd();
  return cut === undefined ? head : `${head}\n\n${cut}`;
}
