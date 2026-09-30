import type { ImageDimensions } from "./image_dimensions.ts";
import { DEFAULT_IMAGE_SETTINGS, type ImageSettings } from "./image_settings.ts";

export interface ImageTier {
  maxEdge: number;
  maxTokens: number;
}

export const STANDARD_IMAGE_TIER: ImageTier = { maxEdge: 1568, maxTokens: 1568 };

export const HIGH_RESOLUTION_IMAGE_TIER: ImageTier = { maxEdge: 2576, maxTokens: 4784 };

const PATCH_PIXELS = 28;

const CLAUDE_VERSIONS = [
  /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/,
  /claude-(\d+)(?:[-.](\d{1,2}))?-(?:opus|sonnet|haiku)/,
];

export function imageTierForModel(modelId: string): ImageTier {
  const id = modelId.toLowerCase();
  for (const pattern of CLAUDE_VERSIONS) {
    const match = pattern.exec(id);
    if (match === null) continue;
    const major = Number(match[1]);
    const minor = Number(match[2] ?? "0");
    return major > 4 || (major === 4 && minor >= 7) ? HIGH_RESOLUTION_IMAGE_TIER : STANDARD_IMAGE_TIER;
  }
  return HIGH_RESOLUTION_IMAGE_TIER;
}

export function imageTokens(dimensions: ImageDimensions | undefined, tier: ImageTier): number {
  return sentImageTokens(dimensions === undefined ? undefined : reducedSize(dimensions, DEFAULT_IMAGE_SETTINGS), tier);
}

export function sentImageTokens(dimensions: ImageDimensions | undefined, tier: ImageTier): number {
  if (dimensions === undefined) return tier.maxTokens;
  const seen = sizeForTier(dimensions, tier);
  return visualTokens(seen.width, seen.height);
}

export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH_PIXELS) * Math.ceil(height / PATCH_PIXELS);
}

export function sizeForTier({ width, height }: ImageDimensions, tier: ImageTier): ImageDimensions {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&
    Math.ceil(h / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&
    visualTokens(w, h) <= tier.maxTokens;
  if (fits(width, height)) return { width, height };
  if (height > width) {
    const turned = sizeForTier({ width: height, height: width }, tier);
    return { width: turned.height, height: turned.width };
  }
  const aspect = width / height;
  const shortEdge = (longEdge: number): number => Math.max(roundHalfToEven(longEdge / aspect), 1);
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, shortEdge(mid))) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: shortEdge(lo) };
}

export function reducedSize(dimensions: ImageDimensions, settings: Readonly<ImageSettings>): ImageDimensions {
  const edged = fitLongEdge(dimensions, settings.max_edge);
  return settings.max_tokens > 0 ? sizeForTier(edged, { maxEdge: Number.MAX_SAFE_INTEGER, maxTokens: settings.max_tokens }) : edged;
}

export function fitLongEdge({ width, height }: ImageDimensions, edge: number): ImageDimensions {
  const scale = edge / Math.max(width, height);
  if (scale >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}
