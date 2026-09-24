import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Definition, Image, ImageReference, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { readBoundedFile } from "./file_access.ts";
import { MAX_INLINE_TOOL_IMAGES, MAX_LISTED_MEDIA_NOTES, carryToolMedia, type ToolResultPayload } from "./media.ts";
import { MAX_PREPARED_IMAGE_BYTES } from "../llm/prepare_images.ts";
import { base64Bytes } from "../util/base64.ts";
import { readImageAt } from "./read_image.ts";

export const MAX_MARKDOWN_IMAGE_SOURCE_BYTES = 1024 * 1024;

export interface TextPage {
  output: string;
  ranges: { start: number; end: number; text: string }[];
}

function localImagePath(url: string, documentPath: string): string | undefined {
  const target = url.split(/[?#]/, 1)[0] ?? "";
  const path = decodeURIComponent(target);
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("\\\\")) return undefined;
  if (path.includes("\0")) throw new Error("image path contains a NUL byte");
  return resolve(dirname(documentPath), path);
}

function imageNodes(source: string, page: TextPage): { node: Image | ImageReference; url: string }[] {
  const pending: Nodes[] = [fromMarkdown(source)];
  const definitions = new Map<string, Definition>();
  const images: (Image | ImageReference)[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) for (const child of node.children.toReversed()) pending.push(child);
  }
  return images.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !page.ranges.some((range) => start >= range.start && end <= range.end)) return [];
    const url = node.type === "image" ? node.url : definitions.get(node.identifier)?.url;
    return url === undefined ? [] : [{ node, url }];
  });
}

function overBudgetNote(urls: readonly string[], maxImageBytes: number): string {
  const listed = urls.slice(0, MAX_LISTED_MEDIA_NOTES).join(", ");
  const more = urls.length > MAX_LISTED_MEDIA_NOTES ? ` and ${String(urls.length - MAX_LISTED_MEDIA_NOTES)} more` : "";
  const reason = maxImageBytes === 0
    ? "inline images are disabled for this tool"
    : `they would not fit the ${String(maxImageBytes)}-byte inline image budget for this read. Read those image files directly to view them.`;
  return `[Markdown image(s) ${listed}${more} not read: ${reason}]`;
}

export async function expandMarkdownImages(file: FileHandle, path: string, page: TextPage, maxImageBytes: number, signal?: AbortSignal): Promise<unknown> {
  if (page.ranges.length === 0) return page.output;
  const notes: string[] = [];
  const payload: ToolResultPayload = { value: page.output, media: [], extra: [], notes };
  try {
    const bytes = await readBoundedFile(file, path, MAX_MARKDOWN_IMAGE_SOURCE_BYTES, "Markdown image source", signal);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (page.ranges.some((range) => source.slice(range.start, range.end) !== range.text)) throw new Error("file changed while reading; retry to expand images");
    const paths = new Set<string>();
    const failures: string[] = [];
    const overBudget: string[] = [];
    // Preparation never yields more than MAX_PREPARED_IMAGE_BYTES, so only skip sources that cannot fit even after resizing.
    const budget = { remaining: maxImageBytes };
    const cost = (size: number) => Math.min(size, MAX_PREPARED_IMAGE_BYTES);
    const fits = (size: number) => cost(size) <= budget.remaining;
    for (const { node, url } of imageNodes(source, page)) {
      signal?.throwIfAborted();
      try {
        const imagePath = localImagePath(url, path);
        if (imagePath === undefined || paths.has(imagePath)) continue;
        paths.add(imagePath);
        if (paths.size > MAX_INLINE_TOOL_IMAGES) continue;
        const image = await readImageAt(imagePath, fits, signal);
        if (image === undefined) {
          overBudget.push(url);
          continue;
        }
        budget.remaining -= cost(base64Bytes(image.data));
        if (node.alt) image.label = `${node.alt} (${imagePath})`;
        payload.media.push(image);
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(`[Markdown image ${url} not attached: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
    notes.push(...failures.slice(0, MAX_LISTED_MEDIA_NOTES));
    if (failures.length > MAX_LISTED_MEDIA_NOTES) notes.push(`[${String(failures.length - MAX_LISTED_MEDIA_NOTES)} more Markdown image reference(s) could not be attached]`);
    if (overBudget.length > 0) notes.push(overBudgetNote(overBudget, maxImageBytes));
    if (paths.size > MAX_INLINE_TOOL_IMAGES) notes.push(`[${String(paths.size - MAX_INLINE_TOOL_IMAGES)} more local image reference(s) not read; at most ${String(MAX_INLINE_TOOL_IMAGES)} are expanded per read. Read those image files directly to view them.]`);
  } catch (error) {
    signal?.throwIfAborted();
    notes.push(`[Markdown images not expanded: ${error instanceof Error ? error.message : String(error)}]`);
  }
  return carryToolMedia(payload);
}
