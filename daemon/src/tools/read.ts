import { readFile, stat, type FileHandle } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { carryToolMedia, DEFAULT_MAX_INLINE_IMAGE_BYTES, toolMediaOf } from "./media.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { filePath, openRegularFile } from "./file_access.ts";
import { IMAGE_EXTENSIONS, imageMime, readImage, readVideoFrame } from "./read_image.ts";
import { MEDIA_HEADER_BYTES, videoMime } from "./video.ts";
import { expandMarkdownImages, type TextPage } from "./markdown_images.ts";
import { readFolder } from "./read_folder.ts";
import { byteSize, MAX_THREAD_PIN_BYTES, MAX_THREAD_PINS_BYTES, threadFileText } from "./thread_file_text.ts";
import { linkedFile, namedFile, workspaceNames, type WorkspaceNames } from "./workspace_names.ts";
import { WORKSPACE_LINK } from "./workspace_path.ts";
import { defaultImagesConfig, imageSettingsFor, type ImagesConfig } from "../config/app.ts";
import type { Texts } from "../texts/texts.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_LINE_CHARS = 2000;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn"]);

const FOLDER_INDEX = "INDEX.md";

interface Located {
  path: string;
  note?: string | undefined;
  folder?: string;
}

const resultBudget = (maxChars: number) => maxChars === 0 ? 50_000 : Math.max(1, maxChars - 512);

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
}

async function isFolder(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

async function withIndex(located: Located): Promise<Located> {
  const index = join(located.path, FOLDER_INDEX);
  return await isFile(index) ? { ...located, path: index, folder: located.path } : located;
}

async function locate(texts: Texts, input: Record<string, unknown>, requested: string, workspaceDir: string, signal?: AbortSignal): Promise<Located> {
  const value = String(input.file_path).trim();
  const link = WORKSPACE_LINK.exec(value);
  if (link !== null) {
    try {
      return await withIndex({ path: await linkedFile(await workspaceNames(workspaceDir, signal), link[1] === "!", link[2] ?? "") });
    } catch (error) {
      signal?.throwIfAborted();
      throw new ToolIoError(`${value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const name = relative(workspaceDir, requested);
  const folder = await isFolder(requested);
  const looked = folder ? !/[\\/]$/.test(value) : await missing(requested);
  if (!looked || name === "" || name === ".." || name.startsWith(`..${sep}`)) return { path: requested };
  try {
    const found = await namedFile(await workspaceNames(workspaceDir, signal), name.split(sep), !folder);
    return await withIndex({ path: found.path, note: texts.render(folder ? "read_found_folder" : "read_found", { asked: value, link: found.link }) });
  } catch (error) {
    signal?.throwIfAborted();
    if (folder) return { path: requested };
    throw new ToolIoError(texts.always("read_missing", { path: requested, why: error instanceof Error ? error.message : String(error) }));
  }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

async function promptFile(value: string, workspaceDir: string, names: () => Promise<WorkspaceNames>): Promise<string> {
  const link = WORKSPACE_LINK.exec(value);
  if (link !== null) {
    const found = await linkedFile(await names(), link[1] === "!", link[2] ?? "").catch((error: unknown) => {
      throw new Error(`${value}: ${messageOf(error)}`);
    });
    if (!await isFolder(found)) return found;
    const index = join(found, FOLDER_INDEX);
    if (await isFile(index)) return index;
    throw new Error(`${value}: ${relative(workspaceDir, found)}/ has no ${FOLDER_INDEX}`);
  }
  const path = join(workspaceDir, value);
  const stats = await stat(path).catch(() => undefined);
  if (stats?.isFile() === true) return path;
  if (stats !== undefined) throw new Error(`${value} is ${stats.isDirectory() ? "a folder" : "not a regular file"}`);
  const hint = await namedFile(await names(), value.split("/"), false).then((found) => `did you mean ${found.link}?`, messageOf);
  throw new Error(`${value} does not exist; ${hint}`);
}

async function promptFileBytes(value: string, path: string, shown: string): Promise<number> {
  const label = WORKSPACE_LINK.test(value) ? `${value} (${shown})` : shown;
  const { size } = await stat(path);
  if (size > MAX_THREAD_PIN_BYTES) throw new Error(`${label} is ${byteSize(size)}; a pinned file can be at most ${byteSize(MAX_THREAD_PIN_BYTES)}`);
  const read = threadFileText(path, await readFile(path));
  if ("reason" in read) throw new Error(`${label} ${read.reason}; a pinned file must be text`);
  return size;
}

export async function locateWorkspaceFiles(files: readonly string[], workspaceDir: string, signal?: AbortSignal): Promise<{ paths: string[]; problems: string[] }> {
  let names: Promise<WorkspaceNames> | undefined;
  const lookUp = () => names ??= workspaceNames(workspaceDir, signal);
  const paths: string[] = [];
  const problems: string[] = [];
  const sizes = new Map<string, number>();
  for (const file of files) {
    try {
      const path = await promptFile(file, workspaceDir, lookUp);
      const shown = relative(workspaceDir, path).split(sep).join("/");
      sizes.set(shown, await promptFileBytes(file.trim(), path, shown));
      paths.push(shown);
    } catch (error) {
      signal?.throwIfAborted();
      problems.push(messageOf(error));
    }
  }
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (problems.length === 0 && total > MAX_THREAD_PINS_BYTES) {
    problems.push(`together these files are ${byteSize(total)}; a thread's pins can be at most ${byteSize(MAX_THREAD_PINS_BYTES)} together`);
  }
  return { paths, problems };
}

function withNote(value: unknown, note: string | undefined): unknown {
  if (note === undefined) return value;
  const payload = toolMediaOf(value) ?? { value, media: [], extra: [] };
  return carryToolMedia({ ...payload, notes: [note, ...(payload.notes ?? [])] });
}

async function withListing(texts: Texts, page: TextPage, folder: string, workspaceDir: string, maxChars: number, signal?: AbortSignal): Promise<TextPage> {
  const listing = await readFolder(texts, folder, resultBudget(maxChars) - page.output.length - 2, signal);
  const after = listing.cut ? texts.render("read_index_cut", { folder: relative(workspaceDir, folder) }) : listing.text;
  return { ...page, output: after === undefined ? page.output : `${page.output}\n\n${after}` };
}

export async function handleRead(
  input: Record<string, unknown>, workspaceDir: string, texts: Texts, signal?: AbortSignal, maxChars = 50_000,
  maxImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES, images: ImagesConfig = defaultImagesConfig(),
): Promise<unknown> {
  signal?.throwIfAborted();
  const requested = filePath(input, workspaceDir);
  const offset = (input.offset ?? 1) as number;
  const limit = (input.limit ?? MAX_READ_LINES) as number;
  const original = input.original === true;
  const { path, note, folder } = await locate(texts, input, requested, workspaceDir, signal);
  if (await isFolder(path)) {
    if (input.offset !== undefined || input.limit !== undefined || original) throw new InvalidArgs(texts.always("read_folder_options"));
    return withNote((await readFolder(texts, path, resultBudget(maxChars), signal)).text, note);
  }
  const file = await openRegularFile(path);
  try {
    const header = Buffer.alloc(MEDIA_HEADER_BYTES);
    const head = await file.read(header, 0, header.length, 0);
    const sniffed = header.subarray(0, head.bytesRead);
    const video = videoMime(sniffed);
    const mime = imageMime(sniffed) ?? video;
    if (mime !== undefined || IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      if (mime === undefined) throw new ToolIoError(texts.always("read_image_data", { path }));
      if (input.offset !== undefined || input.limit !== undefined) throw new InvalidArgs(texts.always("read_text_options"));
      if (original && !images.read.allow_original) throw new InvalidArgs(texts.always("read_original_off"));
      const { description, image } = await (video === undefined ? readImage : readVideoFrame)(texts, file, path, mime, signal);
      return withNote(carryToolMedia({ value: description, media: [original ? { ...image, original } : image], extra: [] }), note);
    }
    if (original) throw new InvalidArgs(texts.always("read_original_image"));
    const text = await readText(texts, file, path, offset, limit, maxChars, signal);
    const page = folder === undefined ? text : await withListing(texts, text, folder, workspaceDir, maxChars, signal);
    return withNote(MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())
      ? await expandMarkdownImages(texts, file, path, workspaceDir, page, maxImageBytes, imageSettingsFor(images, "read").max_bytes, signal)
      : page.output, note);
  } finally {
    await file.close();
  }
}

async function readText(texts: Texts, file: FileHandle, path: string, offset: number, limit: number, maxChars: number, signal?: AbortSignal): Promise<TextPage> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(32_768);
  const lines: string[] = [];
  const ranges: TextPage["ranges"] = [];
  const lineEnds: { source: number; output: number }[] = [];
  let renderedChars = 0;
  let sourceOffset = 0;
  let lineStart = 0;
  let line = "";
  let lineChars = 0;
  let number = 1;
  let position = 0;
  let outputChars = 0;
  let more = false;
  const budget = resultBudget(maxChars);
  const lineLimit = Math.min(MAX_READ_LINE_CHARS, Math.max(1, budget - 80));
  const lineCut = texts.render("read_line_cut", { chars: String(lineLimit) });
  const emit = (newline: boolean): boolean => {
    if (number < offset) return true;
    const cut = lineChars > lineLimit;
    const rendered = `${number}\t${line.replace(/\r$/, "")}${cut && lineCut !== undefined ? ` ${lineCut}` : ""}`;
    const length = Array.from(rendered).length + 1;
    if (lines.length > 0 && (lines.length >= limit || outputChars + length > budget)) return false;
    lines.push(rendered);
    const text = line + (newline && !cut ? "\n" : "");
    renderedChars += rendered.length + 1;
    lineEnds.push({ source: lineStart + text.length, output: renderedChars });
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
      if (char === "\0") throw new ToolIoError(texts.always("read_binary", { path }));
      if (char === "\n") {
        if (!emit(true)) return false;
        number += 1;
        lineStart = sourceOffset;
        line = "";
        lineChars = 0;
      } else {
        if (lines.length >= limit || outputChars >= budget) return false;
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
    catch { throw new ToolIoError(texts.always("read_not_utf8", { path })); }
    if (!consume(text)) { more = true; break; }
    if (read.bytesRead === 0) {
      if (lineChars > 0 && !emit(false)) more = true;
      break;
    }
  }
  if (lines.length === 0) return { output: position === 0 ? texts.always("read_empty", { path }) : texts.always("read_past_end", { path, offset: String(offset) }), ranges, lineEnds: [] };
  const end = offset + lines.length - 1;
  const notice = more ? texts.render("read_more", { offset: String(end + 1), limit: String(limit) }) : texts.render("read_end");
  const heading = texts.render("read_lines", { path, from: String(offset), to: String(end) });
  const header = heading === undefined ? "" : `${heading}\n`;
  return {
    output: `${header}${lines.join("\n")}${notice === undefined ? "" : `\n${notice}`}`,
    ranges,
    lineEnds: lineEnds.map(({ source, output }) => ({ source, output: header.length + output })),
  };
}
