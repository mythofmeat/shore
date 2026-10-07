import { MAX_IMAGE_BYTES } from "../llm/images.ts";
import type { ImageDimensions } from "../llm/image_dimensions.ts";
import { sentImageTokens, type ImageTier } from "../llm/image_tokens.ts";
import type { ImageVersion, ReducedImage } from "../llm/prepare_images.ts";

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

export function renderPayload(payload: ToolResultPayload): string {
  const head = payloadText(payload.value);
  const parts = head === "" ? [] : [head];
  parts.push(...payload.extra, ...(payload.notes ?? []));
  for (const item of payload.media) parts.push(`[${item.label} returned, not included here]`);
  return parts.join("\n");
}

export function renderToolValue(value: unknown): string {
  const payload = toolMediaOf(value);
  return payload === undefined ? payloadText(value) : renderPayload(payload);
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

function tokenCost(dimensions: ImageDimensions | undefined, tier: ImageTier): string {
  const tokens = sentImageTokens(dimensions, tier);
  return `${tokens.toLocaleString("en-US")} ${tokens === 1 ? "token" : "tokens"}`;
}

export interface ReductionNote {
  item: ToolMediaItem;
  reduced: ReducedImage;
  tier: ImageTier;
  fullSize: ImageDimensions | undefined;
  offerOriginal: boolean;
}

export function reductionNote({ item, reduced, tier, fullSize, offerOriginal }: ReductionNote): string {
  const firstFrame = reduced.original.mediaType === "image/gif" ? ", first frame only" : "";
  const sent = `${describeVersion(reduced.sent)} (${tokenCost(reduced.sent.dimensions, tier)})`;
  if (item.original === true) {
    return `[${item.label}: ${describeVersion(reduced.original)} sent at ${sent}, the full resolution this model accepts${firstFrame}.]`;
  }
  const original = `${describeVersion(reduced.original)} (${tokenCost(fullSize, tier)})`;
  const path = item.path ?? item.label;
  const offer = !offerOriginal ? "" : path === item.label
    ? " Read it with original: true for the full image."
    : ` Read ${path} with original: true for the full image.`;
  return `[${item.label}: reduced from ${original} to ${sent}${firstFrame}.${offer}]`;
}
