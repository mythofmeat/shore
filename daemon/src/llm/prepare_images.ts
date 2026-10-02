import { createHash } from "node:crypto";
import type { Sdk, SidecarRequest } from "./types.ts";
import type { ContentBlock } from "../engine/types.ts";
import { base64ImageDimensions, mayBeTransparent, type ImageDimensions } from "./image_dimensions.ts";
import { fitLongEdge, HIGH_RESOLUTION_IMAGE_TIER, imageTierForModel, reducedSize, sizeForTier, type ImageTier } from "./image_tokens.ts";
import {
  API_MAX_IMAGE_EDGE,
  DEFAULT_IMAGE_SETTINGS,
  MANY_IMAGES,
  MANY_IMAGES_MAX_EDGE,
  MAX_SENT_IMAGE_BYTES,
  type ImageSettings,
} from "./image_settings.ts";
import { countImageBlocks } from "./image_support.ts";
import { base64Bytes } from "../util/base64.ts";

type ImageSource = Extract<ContentBlock, { type: "image" }>["source"];

type Encoding = "png" | "jpeg" | "webp";

const MEDIA_TYPES: Record<Encoding, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

const MAX_CACHED_IMAGES = 32;
const LOSSY_QUALITY_FLOOR = 50;
const QUALITY_STEP = 10;
const SHRINK_STEP = 0.8;
const prepared = new Map<string, ReducedImage>();

export interface ImageLimits {
  tier: ImageTier;
  maxEdge: number;
}

export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = Object.freeze({
  tier: HIGH_RESOLUTION_IMAGE_TIER,
  maxEdge: API_MAX_IMAGE_EDGE,
});

export const ORIGINAL_IMAGE_SETTINGS: Readonly<ImageSettings> = Object.freeze({
  ...DEFAULT_IMAGE_SETTINGS,
  max_edge: API_MAX_IMAGE_EDGE,
  max_bytes: MAX_SENT_IMAGE_BYTES,
});

export function imageLimitsFor(sdk: Sdk, model: string): ImageLimits {
  return { tier: imageTierForModel(model), maxEdge: sdk === "claude_agent" ? MANY_IMAGES_MAX_EDGE : API_MAX_IMAGE_EDGE };
}

export interface ImageVersion {
  mediaType: string;
  dimensions: ImageDimensions | undefined;
}

export interface ReducedImage {
  source: ImageSource;
  original: ImageVersion;
  sent: ImageVersion;
  changed: boolean;
}

export interface ReduceOptions {
  maxEdge?: number;
  tier?: ImageTier;
}

interface Reduction {
  result?: ReducedImage;
  encode: () => Promise<ReducedImage>;
}

interface Sizing {
  original: ImageDimensions;
  target: ImageDimensions;
}

type Encoded = { data: string; encoding: Encoding; size: ImageDimensions | undefined };

export async function reduceImage(
  source: ImageSource,
  settings: Readonly<ImageSettings>,
  options: ReduceOptions = {},
): Promise<ReducedImage> {
  const reduction = await planReduction(source, settings, options);
  return reduction.result ?? await reduction.encode();
}

async function planReduction(
  source: ImageSource,
  settings: Readonly<ImageSettings>,
  options: ReduceOptions,
): Promise<Reduction> {
  const input = Buffer.from(source.data, "base64");
  const metadata = await new Bun.Image(input).metadata().catch(() => undefined);
  const sizing = metadata === undefined ? undefined : sizingFor({ width: metadata.width, height: metadata.height }, settings, options);
  const original: ImageVersion = { mediaType: source.media_type, dimensions: sizing?.original };
  const gif = source.media_type === "image/gif";
  const bytes = gif ? Buffer.from(await new Bun.Image(input).png().bytes()) : input;
  const mediaType = gif ? "image/png" : source.media_type;
  const encoding = encodingFor(settings.format, bytes, mediaType);
  const fits = (data: string): boolean => base64Bytes(data) <= settings.max_bytes;
  const data = gif ? bytes.toString("base64") : source.data;
  const reduced = (sent: string, encoded: string, size: ImageDimensions | undefined): ReducedImage => ({
    source: { type: "base64", media_type: encoded, data: sent },
    original,
    sent: { mediaType: encoded, dimensions: size },
    changed: sent !== source.data,
  });
  const reencode = async (): Promise<ReducedImage> => {
    const encoded = await encodeWithin(bytes, sizing, encoding, settings, fits);
    return reduced(encoded.data, MEDIA_TYPES[encoded.encoding], encoded.size);
  };
  const keeps = encoding === undefined || MEDIA_TYPES[encoding] === mediaType;
  const unresized = sizing === undefined || sameSize(sizing.target, sizing.original);
  return keeps && unresized && fits(data)
    ? { result: reduced(data, mediaType, sizing?.original), encode: reencode }
    : { encode: reencode };
}

export function fullResolution(dimensions: ImageDimensions | undefined, limits: ImageLimits): ImageDimensions | undefined {
  return dimensions === undefined ? undefined : sizingFor(dimensions, ORIGINAL_IMAGE_SETTINGS, limits).target;
}

function sizingFor(original: ImageDimensions, settings: Readonly<ImageSettings>, options: ReduceOptions): Sizing {
  const reduced = reducedSize(original, settings);
  const seen = options.tier === undefined ? reduced : sizeForTier(reduced, options.tier);
  return { original, target: fitLongEdge(seen, options.maxEdge ?? API_MAX_IMAGE_EDGE) };
}

function sameSize(a: ImageDimensions, b: ImageDimensions): boolean {
  return a.width === b.width && a.height === b.height;
}

function encodingFor(format: ImageSettings["format"], bytes: Buffer, mediaType: string): Encoding | undefined {
  switch (format) {
    case "keep":
      return undefined;
    case "jpeg":
      return mediaType === "image/webp" && mayBeTransparent(bytes) ? "webp" : "jpeg";
    default:
      return format;
  }
}

async function encodeWithin(
  bytes: Buffer,
  sizing: Sizing | undefined,
  encoding: Encoding | undefined,
  settings: Readonly<ImageSettings>,
  fits: (data: string) => boolean,
): Promise<Encoded> {
  const target = sizing?.target;
  const encodeAt = (size: ImageDimensions | undefined, as: Encoding, quality: number): Promise<string> =>
    encode(bytes, sizing === undefined || size === undefined || sameSize(size, sizing.original) ? undefined : size, as, quality, settings);
  const attempt = async (size: ImageDimensions | undefined, as: Encoding, quality: number): Promise<Encoded | undefined> => {
    const data = await encodeAt(size, as, quality);
    return fits(data) ? { data, encoding: as, size } : undefined;
  };
  const shrinking = async (as: Encoding, quality: number, fromTarget: boolean): Promise<Encoded> => {
    if (sizing !== undefined) {
      const longEdge = Math.max(sizing.target.width, sizing.target.height);
      for (let edge = fromTarget ? longEdge : Math.floor(longEdge * SHRINK_STEP); edge >= 1; edge = Math.floor(edge * SHRINK_STEP)) {
        const result = await attempt(edge === longEdge ? sizing.target : fitLongEdge(sizing.original, edge), as, quality);
        if (result !== undefined) return result;
      }
    }
    throw new Error(`Image could not be reduced below ${String(settings.max_bytes)} bytes`);
  };
  if (encoding === undefined) {
    return await attempt(target, "png", settings.quality) ?? await shrinking("webp", settings.quality, true);
  }
  if (encoding === "png") return await attempt(target, "png", settings.quality) ?? await shrinking("png", settings.quality, false);
  const floor = Math.min(settings.quality, LOSSY_QUALITY_FLOOR);
  let quality = settings.quality;
  let as = encoding;
  let first: string | undefined;
  if (as === "jpeg" && mayBeTransparent(bytes)) {
    const probe = await encodeAt(target, "webp", quality);
    if (mayBeTransparent(Buffer.from(probe, "base64"))) {
      as = "webp";
      first = probe;
    }
  }
  for (;;) {
    const data = first ?? await encodeAt(target, as, quality);
    first = undefined;
    if (fits(data)) return { data, encoding: as, size: target };
    if (quality - QUALITY_STEP < floor) break;
    quality -= QUALITY_STEP;
  }
  return await shrinking(as, quality, false);
}

async function encode(
  bytes: Buffer,
  resize: ImageDimensions | undefined,
  as: Encoding,
  quality: number,
  settings: Readonly<ImageSettings>,
): Promise<string> {
  const image = resize === undefined ? new Bun.Image(bytes) : new Bun.Image(bytes).resize(resize.width, resize.height, { fit: "fill" });
  switch (as) {
    case "png":
      return await image.png({ compressionLevel: settings.png_compression, ...(settings.png_palette ? { palette: true } : {}) }).toBase64();
    case "jpeg":
      return await image.jpeg({ quality }).toBase64();
    case "webp":
      return await image.webp({ quality }).toBase64();
  }
}

export async function prepareImageBlock(
  block: ContentBlock,
  settings: Readonly<ImageSettings> = DEFAULT_IMAGE_SETTINGS,
): Promise<ContentBlock> {
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    return { ...block, content: await prepareImageBlocks(block.content, settings) };
  }
  if (block.type !== "image") return block;
  const reduction = await planReduction(block.source, settings, {});
  if (reduction.result !== undefined) {
    return reduction.result.changed ? { ...block, source: { ...reduction.result.source } } : block;
  }
  const key = createHash("sha256").update(JSON.stringify(settings)).update("\0")
    .update(block.source.media_type).update("\0").update(block.source.data).digest("hex");
  const result = prepared.get(key) ?? await reduction.encode();
  prepared.delete(key);
  prepared.set(key, result);
  if (prepared.size > MAX_CACHED_IMAGES) prepared.delete(prepared.keys().next().value as string);
  return { ...block, source: { ...result.source } };
}

export async function prepareImageBlocks(
  blocks: readonly ContentBlock[],
  settings: Readonly<ImageSettings> = DEFAULT_IMAGE_SETTINGS,
): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    out.push(await prepareImageBlock(block, settings));
  }
  return out;
}

export async function limitImageBlock(block: ContentBlock, maxEdge: number = API_MAX_IMAGE_EDGE): Promise<ContentBlock> {
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    return { ...block, content: await limitImageBlocks(block.content, maxEdge) };
  }
  if (block.type !== "image") return block;
  const dimensions = base64ImageDimensions(block.source.data);
  if (
    block.source.media_type !== "image/gif" &&
    base64Bytes(block.source.data) <= MAX_SENT_IMAGE_BYTES &&
    (dimensions === undefined || Math.max(dimensions.width, dimensions.height) <= maxEdge)
  ) return block;
  return await prepareImageBlock(block, { ...DEFAULT_IMAGE_SETTINGS, max_edge: maxEdge, max_bytes: MAX_SENT_IMAGE_BYTES });
}

export async function limitImageBlocks(blocks: readonly ContentBlock[], maxEdge: number = API_MAX_IMAGE_EDGE): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    out.push(await limitImageBlock(block, maxEdge));
  }
  return out;
}

function requestMaxImageEdge(request: Pick<SidecarRequest, "sdk" | "messages">): number {
  return request.sdk === "claude_agent" || countImageBlocks(request.messages) > MANY_IMAGES
    ? MANY_IMAGES_MAX_EDGE
    : API_MAX_IMAGE_EDGE;
}

export async function limitRequestImages(request: SidecarRequest): Promise<SidecarRequest> {
  const maxEdge = requestMaxImageEdge(request);
  const messages = [];
  for (const message of request.messages) {
    messages.push({ ...message, content: await limitImageBlocks(message.content, maxEdge) });
  }
  return { ...request, messages };
}
