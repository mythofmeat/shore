import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Definition, Image, ImageReference, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { readBoundedFile } from "./file_access.ts";
import { DEFAULT_MAX_INLINE_IMAGE_BYTES, carryToolMedia, type ToolResultPayload } from "./media.ts";
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

export async function expandMarkdownImages(file: FileHandle, path: string, page: TextPage, signal?: AbortSignal, maxInlineImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES): Promise<unknown> {
  if (page.ranges.length === 0) return page.output;
  const payload: ToolResultPayload = { value: page.output, media: [], extra: [] };
  try {
    const bytes = await readBoundedFile(file, path, MAX_MARKDOWN_IMAGE_SOURCE_BYTES, "Markdown image source", signal);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (page.ranges.some((range) => source.slice(range.start, range.end) !== range.text)) throw new Error("file changed while reading; retry to expand images");
    const paths = new Set<string>();
    let remainingBytes = maxInlineImageBytes;
    for (const { node, url } of imageNodes(source, page)) {
      signal?.throwIfAborted();
      try {
        const imagePath = localImagePath(url, path);
        if (imagePath === undefined || paths.has(imagePath)) continue;
        paths.add(imagePath);
        const image = await readImageAt(imagePath, signal, remainingBytes);
        if (node.alt) image.label = `${node.alt} (${imagePath})`;
        payload.media.push(image);
        remainingBytes -= base64Bytes(image.data);
      } catch (error) {
        signal?.throwIfAborted();
        payload.extra.push(`[Markdown image ${url} not attached: ${error instanceof Error ? error.message : String(error)}. Read the image file directly to view it.]`);
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    payload.extra.push(`[Markdown images not expanded: ${error instanceof Error ? error.message : String(error)}]`);
  }
  return carryToolMedia(payload);
}
