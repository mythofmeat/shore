import type { ContentBlock } from "../protocol/ContentBlock.ts";
import type { Message } from "../protocol/Message.ts";
import type { SendImage } from "../protocol/SendImage.ts";
import type { LiveTurn } from "./workspace.ts";
import { MAX_LIVE_MEDIA_CHARS, recentItems } from "./live_limits.ts";

export const MAX_LIVE_IMAGES = 128;
export interface LiveImage extends SendImage { manual?: boolean; toolId?: string; previewData?: string | null | undefined; messageId?: string }
export interface GalleryImage { id: string; caption: string; data: string | null | undefined; mime: string | undefined }
export type OpenImage = (source: string, caption?: string) => void;

export function retainLiveImages(images: readonly LiveImage[]): { items: LiveImage[]; limited: boolean } {
  return recentItems(images, MAX_LIVE_IMAGES, MAX_LIVE_MEDIA_CHARS, (image) => Object.values(image).reduce<number>((size, value) => size + (typeof value === "string" ? value.length : 0), 256));
}

export function mediaSource(data: string | null | undefined, mime?: string): string | undefined {
  if (data === undefined || data === null || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return undefined;
  const type = mime ?? (data.startsWith("iVBOR") ? "image/png" : data.startsWith("/9j/") ? "image/jpeg" : data.startsWith("R0lGOD") ? "image/gif" : data.startsWith("UklGR") ? "image/webp" : undefined);
  return type !== undefined && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type) ? `data:${type};base64,${data}` : undefined;
}

function blockImages(blocks: readonly ContentBlock[], prefix: string): GalleryImage[] {
  return blocks.flatMap((block, index) => {
    const id = `${prefix}:${String(index)}`;
    switch (block.type) {
      case "image": return [{ id, caption: "Inline image", data: block.source.data, mime: block.source.media_type }];
      case "tool_result": return typeof block.content === "string" ? [] : blockImages(block.content, id);
      case "text": case "thinking": case "redacted_thinking": case "tool_use": return [];
      default: { const unsupported: never = block; throw new Error(`Unsupported image block: ${JSON.stringify(unsupported)}`); }
    }
  });
}

function ownsToolImage(blocks: readonly ContentBlock[], image: LiveImage): boolean {
  return toolImageBlock(blocks, image) !== undefined;
}

function toolImageBlock(blocks: readonly ContentBlock[], image: LiveImage): ContentBlock | undefined {
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    if (block.tool_use_id === image.toolId && (block.is_error === true || (typeof block.content !== "string" && blockImages(block.content, "").some((entry) => image.previewData === undefined || image.previewData === null || entry.data === image.previewData)))) return block;
    if (typeof block.content !== "string") {
      const nested = toolImageBlock(block.content, image);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function reconcileImages(images: readonly LiveImage[], messages: readonly Message[], previous: readonly Message[]): LiveImage[] {
  const storedPaths = new Set(messages.flatMap((message) => message.images.map((image) => image.path)));
  return images.flatMap((image) => {
    if (storedPaths.has(image.path)) return [];
    if (image.messageId !== undefined) {
      if (messages.some((message) => message.msg_id === image.messageId && ownsToolImage(message.content_blocks, image))) return [image];
      const old = previous.find((message) => message.msg_id === image.messageId);
      const block = old === undefined ? undefined : toolImageBlock(old.content_blocks, image);
      const merged = block === undefined || messages.some((message) => message.msg_id === image.messageId) ? undefined : messages.find((message) => !previous.some((prior) => prior.msg_id === message.msg_id) && JSON.stringify(toolImageBlock(message.content_blocks, image)) === JSON.stringify(block));
      return merged === undefined ? [] : [{ ...image, messageId: merged.msg_id }];
    }
    if (image.manual === true || image.toolId === undefined) return [image];
    const owner = messages.find((message) => ownsToolImage(message.content_blocks, image) && !previous.some((old) => old.msg_id === message.msg_id && ownsToolImage(old.content_blocks, image)));
    return [owner === undefined ? image : { ...image, messageId: owner.msg_id }];
  });
}

export function conversationImages(messages: readonly Message[], streams: readonly LiveTurn[], liveImages: readonly SendImage[]): GalleryImage[] {
  const storedPaths = new Set(messages.flatMap((message) => message.images.map((image) => image.path)));
  const namedData = new Set([...messages.flatMap((message) => message.images), ...liveImages].flatMap((image) => typeof image.data === "string" ? [image.data] : []));
  const inline = (blocks: readonly ContentBlock[], prefix: string) => blockImages(blocks, prefix).filter((image) => image.data === undefined || image.data === null || !namedData.has(image.data));
  return [
    ...messages.flatMap((message) => [
      ...message.images.map((image, index) => ({ id: `message:${message.msg_id}:image:${String(index)}`, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Attached image", data: image.data, mime: undefined })),
      ...inline(message.content_blocks, `message:${message.msg_id}:block`),
    ]),
    ...streams.filter((stream) => !(stream.final && messages.some((message) => message.msg_id === stream.msgId))).flatMap((stream) => inline(stream.blocks, `stream:${stream.key}`)),
    ...liveImages.filter((image) => !storedPaths.has(image.path)).map((image) => ({ id: `live:${image.path}`, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Live image", data: image.data, mime: undefined })),
  ];
}

export function imageFilename(caption: string, source: string): string {
  const printable = Array.from(caption, (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character).join("");
  const name = printable.replace(/[\\/<>:"|?*]/g, "_").trim().slice(0, 180) || "shore-image";
  const suffix = source.startsWith("data:image/jpeg;") ? "jpg" : source.startsWith("data:image/gif;") ? "gif" : source.startsWith("data:image/webp;") ? "webp" : "png";
  return /\.(?:png|jpe?g|gif|webp)$/i.test(name) ? name : `${name}.${suffix}`;
}
