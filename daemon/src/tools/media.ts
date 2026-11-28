import { MAX_IMAGE_BYTES } from "../llm/images.ts";
import type { ImageDimensions } from "../llm/image_dimensions.ts";
import { sentImageTokens, type ImageTier } from "../llm/image_tokens.ts";
import type { ImageVersion, ReducedImage } from "../llm/prepare_images.ts";
import type { Texts } from "../texts/texts.ts";

const CARRIER = Symbol("shore.tool_media");

export const MAX_INLINE_TOOL_IMAGES = 20;
export const MAX_LISTED_MEDIA_NOTES = 3;
export const DEFAULT_MAX_INLINE_IMAGE_BYTES = MAX_IMAGE_BYTES;

export interface ToolMediaItem {
  mime_type: string;
  data: string;
  label: string;
  path?: string;
  original?: boolean;
  reducedFrom?: ImageVersion;
  at?: number;
}

export interface ToolResultPayload {
  value: unknown;
  media: ToolMediaItem[];
  extra: string[];
  notes?: string[];
}

export function carryToolMedia(payload: ToolResultPayload): unknown {
  if (payload.media.length === 0 && payload.extra.length === 0 && (payload.notes ?? []).length === 0) return payload.value;
  return { [CARRIER]: payload };
}

export function toolMediaOf(value: unknown): ToolResultPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[CARRIER];
  if (carried === undefined) return undefined;
  return carried as ToolResultPayload;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => Object.hasOwn(right, k) && deepEqual(left[k], right[k]));
}

export function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

export function renderPayload(texts: Texts, payload: ToolResultPayload): string {
  const head = payloadText(payload.value);
  const parts = head === "" ? [] : [head];
  parts.push(...payload.extra, ...(payload.notes ?? []));
  for (const item of payload.media) parts.push(texts.render("tool_media_left_out", { label: item.label }) ?? "");
  return parts.filter((part) => part !== "").join("\n");
}

export function listSome(texts: Texts, items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED_MEDIA_NOTES).join(", ");
  return items.length > MAX_LISTED_MEDIA_NOTES ? texts.render("tool_list_and_more", { list: shown, count: String(items.length - MAX_LISTED_MEDIA_NOTES) }) ?? shown : shown;
}

const FORMAT_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
};

function describeVersion(version: ImageVersion): string {
  const format = FORMAT_NAMES[version.mediaType] ?? version.mediaType;
  const size = version.dimensions;
  return size === undefined ? format : `${String(size.width)}×${String(size.height)} ${format}`;
}

function tokenCost(texts: Texts, dimensions: ImageDimensions | undefined, tier: ImageTier): string {
  const tokens = sentImageTokens(dimensions, tier);
  return texts.render("tool_media_tokens", { count: tokens.toLocaleString("en-US"), one: tokens === 1 ? "yes" : undefined }) ?? "";
}

export interface ReductionNote {
  item: ToolMediaItem;
  reduced: ReducedImage;
  tier: ImageTier;
  fullSize: ImageDimensions | undefined;
  offerOriginal: boolean;
}

export function reductionNote(texts: Texts, { item, reduced, tier, fullSize, offerOriginal }: ReductionNote): string | undefined {
  const firstFrame = reduced.original.mediaType === "image/gif" ? "yes" : undefined;
  const sent = `${describeVersion(reduced.sent)} (${tokenCost(texts, reduced.sent.dimensions, tier)})`;
  if (item.original === true) return texts.render("tool_media_full", { label: item.label, original: describeVersion(reduced.original), sent, first_frame: firstFrame });
  const path = item.path ?? item.label;
  return texts.render("tool_media_reduced", {
    label: item.label,
    original: `${describeVersion(reduced.original)} (${tokenCost(texts, fullSize, tier)})`,
    sent,
    first_frame: firstFrame,
    offer: offerOriginal ? "yes" : undefined,
    path: path === item.label ? undefined : path,
  });
}
