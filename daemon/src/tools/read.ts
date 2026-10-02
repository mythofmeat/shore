import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { carryToolMedia, DEFAULT_MAX_INLINE_IMAGE_BYTES } from "./media.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { filePath, openRegularFile } from "./file_access.ts";
import { imageMime, readImage } from "./read_image.ts";
import { expandMarkdownImages, type TextPage } from "./markdown_images.ts";
import { defaultImagesConfig, imageSettingsFor, type ImagesConfig } from "../config/app.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_LINE_CHARS = 2000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn"]);

function positiveInteger(input: Record<string, unknown>, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = input[name] === undefined ? fallback : input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArgs(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

export async function handleRead(
  input: Record<string, unknown>, workspaceDir: string, signal?: AbortSignal, maxChars = 50_000,
  maxImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES, images: ImagesConfig = defaultImagesConfig(),
): Promise<unknown> {
  signal?.throwIfAborted();
  const path = filePath(input, workspaceDir);
  const offset = positiveInteger(input, "offset", 1);
  const limit = positiveInteger(input, "limit", MAX_READ_LINES, MAX_READ_LINES);
  const original = input.original ?? false;
  if (typeof original !== "boolean") throw new InvalidArgs("original must be true or false");
  const file = await openRegularFile(path);
  try {
    const header = Buffer.alloc(12);
    const head = await file.read(header, 0, header.length, 0);
    const mime = imageMime(header.subarray(0, head.bytesRead));
    if (mime !== undefined || IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      if (mime === undefined) throw new ToolIoError(`${path}: invalid or unsupported image data`);
      if (input.offset !== undefined || input.limit !== undefined) throw new InvalidArgs("offset and limit apply only to text files");
      if (original && !images.read.allow_original) throw new InvalidArgs("original is turned off by images.read.allow_original; images are sent at the configured size");
      const { description, image } = await readImage(file, path, mime, signal);
      return carryToolMedia({ value: description, media: [original ? { ...image, original } : image], extra: [] });
    }
    if (original) throw new InvalidArgs("original applies only to image files");
    const page = await readText(file, path, offset, limit, maxChars, signal);
    return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())
      ? await expandMarkdownImages(file, path, page, maxImageBytes, imageSettingsFor(images, "read").max_bytes, signal)
      : page.output;
  } finally {
    await file.close();
  }
}

async function readText(file: FileHandle, path: string, offset: number, limit: number, maxChars: number, signal?: AbortSignal): Promise<TextPage> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(32_768);
  const lines: string[] = [];
  const ranges: TextPage["ranges"] = [];
  let sourceOffset = 0;
  let lineStart = 0;
  let line = "";
  let lineChars = 0;
  let number = 1;
  let position = 0;
  let outputChars = 0;
  let more = false;
  const budget = maxChars === 0 ? 50_000 : Math.max(1, maxChars - 512);
  const lineLimit = Math.min(MAX_READ_LINE_CHARS, Math.max(1, budget - 80));
  const emit = (newline: boolean): boolean => {
    if (number < offset) return true;
    const rendered = `${number}\t${line.replace(/\r$/, "")}${lineChars > lineLimit ? ` [line truncated after ${lineLimit} characters]` : ""}`;
    const length = Array.from(rendered).length + 1;
    if (lines.length > 0 && (lines.length >= limit || outputChars + length > budget)) return false;
    lines.push(rendered);
    const text = line + (newline && lineChars <= lineLimit ? "\n" : "");
    const previous = ranges.at(-1);
    if (previous?.end === lineStart) {
      previous.end += text.length;
      previous.text += text;
    } else {
      ranges.push({ start: lineStart, end: lineStart + text.length, text });
    }
    outputChars += length;
    return true;
  };
  const consume = (text: string): boolean => {
    for (const char of text) {
      sourceOffset += char.length;
      if (char === "\0") throw new ToolIoError(`${path}: binary files are not supported`);
      if (char === "\n") {
        if (!emit(true)) return false;
        number += 1;
        lineStart = sourceOffset;
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
      if (lineChars > 0 && !emit(false)) more = true;
      break;
    }
  }
  if (lines.length === 0) return { output: position === 0 ? `${path}: empty file` : `${path}: offset ${offset} is beyond EOF`, ranges };
  const end = offset + lines.length - 1;
  const notice = more ? `Partial view. Continue with offset=${end + 1} and limit=${limit}.` : "End of file.";
  return { output: `${path}: lines ${offset}–${end}\n${lines.join("\n")}\n${notice}`, ranges };
}
