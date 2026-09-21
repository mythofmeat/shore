import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { carryToolMedia } from "./media.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { filePath, openRegularFile } from "./file_access.ts";

export const MAX_READ_LINES = 2000;
export const MAX_READ_LINE_CHARS = 2000;
export const MAX_READ_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function imageMime(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function positiveInteger(input: Record<string, unknown>, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = input[name] === undefined ? fallback : input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArgs(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

export async function handleRead(
  input: Record<string, unknown>, workspaceDir: string, signal?: AbortSignal, maxChars = 50_000,
): Promise<unknown> {
  signal?.throwIfAborted();
  const path = filePath(input, workspaceDir);
  const offset = positiveInteger(input, "offset", 1);
  const limit = positiveInteger(input, "limit", MAX_READ_LINES, MAX_READ_LINES);
  const file = await openRegularFile(path);
  try {
    const header = Buffer.alloc(12);
    const head = await file.read(header, 0, header.length, 0);
    const mime = imageMime(header.subarray(0, head.bytesRead));
    if (mime !== undefined || IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      if (mime === undefined) throw new ToolIoError(`${path}: invalid or unsupported image data`);
      if (input.offset !== undefined || input.limit !== undefined) throw new InvalidArgs("offset and limit apply only to text files");
      const size = (await file.stat()).size;
      if (size > MAX_READ_IMAGE_BYTES) throw new ToolIoError(`${path}: image exceeds the ${MAX_READ_IMAGE_BYTES}-byte input limit`);
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        signal?.throwIfAborted();
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > size) throw new ToolIoError(`${path}: image changed while reading; retry the read`);
      const data = bytes.subarray(0, length);
      const metadata = await new Bun.Image(data).metadata().catch(() => undefined);
      if (metadata === undefined) throw new ToolIoError(`${path}: image could not be decoded`);
      return carryToolMedia({
        value: `${path}: ${mime}, ${metadata.width}×${metadata.height}, ${length} bytes`,
        media: [{ mime_type: mime, data: data.toString("base64"), label: path }],
        extra: [],
      });
    }
    return await readText(file, path, offset, limit, maxChars, signal);
  } finally {
    await file.close();
  }
}

async function readText(file: FileHandle, path: string, offset: number, limit: number, maxChars: number, signal?: AbortSignal): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(32_768);
  const lines: string[] = [];
  let line = "";
  let lineChars = 0;
  let number = 1;
  let position = 0;
  let outputChars = 0;
  let more = false;
  const budget = maxChars === 0 ? 50_000 : Math.max(1, maxChars - 512);
  const lineLimit = Math.min(MAX_READ_LINE_CHARS, Math.max(1, budget - 80));
  const emit = (): boolean => {
    if (number < offset) return true;
    const rendered = `${number}\t${line.replace(/\r$/, "")}${lineChars > lineLimit ? ` [line truncated after ${lineLimit} characters]` : ""}`;
    const length = Array.from(rendered).length + 1;
    if (lines.length > 0 && (lines.length >= limit || outputChars + length > budget)) return false;
    lines.push(rendered);
    outputChars += length;
    return true;
  };
  const consume = (text: string): boolean => {
    for (const char of text) {
      if (char === "\0") throw new ToolIoError(`${path}: binary files are not supported`);
      if (char === "\n") {
        if (!emit()) return false;
        number += 1;
        line = "";
        lineChars = 0;
      } else {
        if (number >= offset && (lines.length >= limit || outputChars >= budget)) return false;
        lineChars += 1;
        if (number >= offset && lineChars <= lineLimit) line += char;
      }
    }
    return true;
  };
  for (;;) {
    signal?.throwIfAborted();
    const read = await file.read(buffer, 0, buffer.length, position);
    position += read.bytesRead;
    let text: string;
    try { text = decoder.decode(buffer.subarray(0, read.bytesRead), { stream: read.bytesRead !== 0 }); }
    catch { throw new ToolIoError(`${path}: not valid UTF-8 text; unsupported binary or encoding`); }
    if (!consume(text)) { more = true; break; }
    if (read.bytesRead === 0) {
      if (lineChars > 0 && !emit()) more = true;
      break;
    }
  }
  if (lines.length === 0) return position === 0 ? `${path}: empty file` : `${path}: offset ${offset} is beyond EOF`;
  const end = offset + lines.length - 1;
  const notice = more ? `Partial view. Continue with offset=${end + 1} and limit=${limit}.` : "End of file.";
  return `${path}: lines ${offset}–${end}\n${lines.join("\n")}\n${notice}`;
}
