import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Definition, Image, ImageReference, Nodes, Text } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { readBoundedFile } from "./file_access.ts";
import { MAX_INLINE_TOOL_IMAGES, MAX_LISTED_MEDIA_NOTES, carryToolMedia, type ToolResultPayload } from "./media.ts";
import { base64Bytes } from "../util/base64.ts";
import { readImageAt } from "./read_image.ts";
import { embeddedPicture, workspaceNames, type WorkspaceNames } from "./workspace_names.ts";
import type { Texts } from "../texts/texts.ts";

const MAX_MARKDOWN_IMAGE_SOURCE_BYTES = 1024 * 1024;

const WIKILINK_IMAGE = /!\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;

const WIKILINK_SIZE = /^\d+(x\d+)?$/;

export interface TextPage {
  output: string;
  ranges: { start: number; end: number; text: string }[];
  lineEnds: { source: number; output: number }[];
}

interface ImageRef {
  alt: string | null | undefined;
  target: string;
  wikilink: boolean;
  end: number;
}

function localImagePath(texts: Texts, url: string, documentPath: string): string | undefined {
  const target = url.split(/[?#]/)[0] ?? "";
  const path = decodeURIComponent(target);
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("\\\\")) return undefined;
  if (path.includes("\0")) throw new Error(texts.always("read_md_nul"));
  return resolve(dirname(documentPath), path);
}

function listSome(items: readonly string[]): string {
  const more = items.length > MAX_LISTED_MEDIA_NOTES ? ` and ${String(items.length - MAX_LISTED_MEDIA_NOTES)} more` : "";
  return items.slice(0, MAX_LISTED_MEDIA_NOTES).join(", ") + more;
}

function wikilinkImages(source: string, node: Text, visible: (start: number, end: number) => boolean): ImageRef[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  return Array.from(source.slice(start, end).matchAll(WIKILINK_IMAGE)).flatMap((match) => {
    const offset = start + match.index;
    let escapes = 0;
    while (offset - escapes > start && source[offset - escapes - 1] === "\\") escapes += 1;
    const target = (match[1] ?? "").trim();
    const option = match[2]?.trim();
    if (escapes % 2 === 1 || !visible(offset, offset + match[0].length)) return [];
    return [{ alt: option === undefined || WIKILINK_SIZE.test(option) ? undefined : option, target, wikilink: true, end: offset + match[0].length }];
  });
}

function imageRefs(source: string, page: TextPage): ImageRef[] {
  const visible = (start: number, end: number) => page.ranges.some((range) => start >= range.start && end <= range.end);
  const pending: Nodes[] = [fromMarkdown(source)];
  const definitions = new Map<string, Definition>();
  const found: ({ node: Image | ImageReference; end: number } | ImageRef)[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === "image" || node.type === "imageReference") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined && visible(start, end)) found.push({ node, end });
    }
    if (node.type === "text") found.push(...wikilinkImages(source, node, visible));
    if ("children" in node) for (const child of node.children.toReversed()) pending.push(child);
  }
  return found.flatMap((ref) => {
    if ("wikilink" in ref) return [ref];
    const { node, end } = ref;
    const url = node.type === "image" ? node.url : definitions.get(node.identifier)?.url;
    return url === undefined ? [] : [{ alt: node.alt, target: url, wikilink: false, end }];
  });
}

function afterLineOf(page: TextPage, end: number): number | undefined {
  return page.lineEnds.find((line) => end <= line.source)?.output;
}

function overBudgetNote(texts: Texts, urls: readonly string[], maxImageBytes: number): string | undefined {
  return maxImageBytes === 0
    ? texts.render("read_md_images_off", { images: listSome(urls) })
    : texts.render("read_md_images_over", { images: listSome(urls), bytes: String(maxImageBytes) });
}

export async function expandMarkdownImages(
  texts: Texts, file: FileHandle, path: string, workspaceDir: string, page: TextPage, maxImageBytes: number, preparedImageBytes: number, signal?: AbortSignal,
): Promise<unknown> {
  if (page.ranges.length === 0) return page.output;
  const notes: string[] = [];
  const note = (text: string | undefined): void => {
    if (text !== undefined) notes.push(text);
  };
  const payload: ToolResultPayload = { value: page.output, media: [], extra: [], notes };
  try {
    const bytes = await readBoundedFile(texts, file, path, MAX_MARKDOWN_IMAGE_SOURCE_BYTES, "file_kind_markdown", signal);
    const source = new TextDecoder().decode(bytes);
    if (page.ranges.some((range) => source.slice(range.start, range.end) !== range.text)) throw new Error(texts.always("read_md_changed"));
    const refs = imageRefs(source, page);
    let names: Promise<WorkspaceNames> | undefined;
    const shownRefs = new Set<string>();
    const paths = new Set<string>();
    const failures: (string | undefined)[] = [];
    const overBudget: string[] = [];
    const budget = { remaining: maxImageBytes };
    const bytesAfterResize = (size: number) => Math.min(size, preparedImageBytes);
    const fits = (size: number) => bytesAfterResize(size) <= budget.remaining;
    for (const { alt, target, wikilink, end } of refs) {
      signal?.throwIfAborted();
      const shown = wikilink ? `![[${target}]]` : target;
      if (shownRefs.has(shown)) continue;
      shownRefs.add(shown);
      try {
        const imagePath = wikilink ? await embeddedPicture(await (names ??= workspaceNames(workspaceDir, signal)), target, MAX_LISTED_MEDIA_NOTES) : localImagePath(texts, target, path);
        if (imagePath === undefined || paths.has(imagePath)) continue;
        paths.add(imagePath);
        if (paths.size > MAX_INLINE_TOOL_IMAGES) continue;
        const image = await readImageAt(texts, imagePath, fits, signal);
        if (image === undefined) {
          overBudget.push(shown);
          continue;
        }
        budget.remaining -= bytesAfterResize(base64Bytes(image.data));
        if (alt) image.label = `${alt} (${imagePath})`;
        const at = afterLineOf(page, end);
        payload.media.push(at === undefined ? image : { ...image, at });
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(texts.render("read_md_image_failed", { image: shown, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    for (const failure of failures.slice(0, MAX_LISTED_MEDIA_NOTES)) note(failure);
    if (failures.length > MAX_LISTED_MEDIA_NOTES) note(texts.render("read_md_more_failed", { count: String(failures.length - MAX_LISTED_MEDIA_NOTES) }));
    if (overBudget.length > 0) note(overBudgetNote(texts, overBudget, maxImageBytes));
    if (paths.size > MAX_INLINE_TOOL_IMAGES) note(texts.render("read_md_more_images", { count: String(paths.size - MAX_INLINE_TOOL_IMAGES), max: String(MAX_INLINE_TOOL_IMAGES) }));
  } catch (error) {
    signal?.throwIfAborted();
    note(texts.render("read_md_failed", { error: error instanceof Error ? error.message : String(error) }));
  }
  return carryToolMedia(payload);
}
