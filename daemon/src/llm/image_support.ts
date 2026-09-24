import { shoreLog } from "../log.ts";

import fs from "node:fs";
import path from "node:path";

import type { ContentBlock } from "../engine/types.ts";
import { describeError } from "./errors.ts";
import { omissionNotice } from "./images.ts";
import { toolResultImages, type WireMessage } from "./types.ts";

const LEARNED_VERSION = 1;

interface LearnedFile {
  version: number;
  models: Record<string, boolean>;
}

export function learnedImageSupportPath(cacheDir: string, providerKey: string): string {
  return path.join(cacheDir, "providers", providerKey, "image_support.json");
}

export function readLearnedImageSupport(
  cacheDir: string,
  providerKey: string,
): Record<string, boolean> {
  let raw: string;
  try {
    raw = fs.readFileSync(learnedImageSupportPath(cacheDir, providerKey), "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null) return {};
  const models = (parsed as { models?: unknown }).models;
  if (typeof models !== "object" || models === null) return {};

  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

export function recordImageRejection(
  cacheDir: string,
  providerKey: string,
  modelId: string,
): void {
  const existing = readLearnedImageSupport(cacheDir, providerKey);
  if (existing[modelId] === false) return;

  const next: LearnedFile = {
    version: LEARNED_VERSION,
    models: { ...existing, [modelId]: false },
  };
  const target = learnedImageSupportPath(cacheDir, providerKey);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    shoreLog.warn(
      `shore: could not record that ${providerKey}/${modelId} refuses images: ${String(e)}`,
    );
    return;
  }
  shoreLog.warn(
    `shore: ${providerKey}/${modelId} refused an image payload; ` +
      `recording it as text-only so later turns drop images instead of failing`,
  );
}

export interface ImageSupportInputs {
  declared?: boolean;
  discovered?: boolean;
  providerKey: string;
  modelId: string;
}

export function imageSupportFor(
  inputs: ImageSupportInputs,
  cacheDir: string,
): boolean | undefined {
  if (inputs.declared !== undefined) return inputs.declared;
  if (inputs.discovered !== undefined) return inputs.discovered;
  return readLearnedImageSupport(cacheDir, inputs.providerKey)[inputs.modelId];
}

const REJECTION_PATTERNS: readonly RegExp[] = [
  /messages\.content\.type is invalid/i,
  /does not support (image|vision)/i,
  /images? (?:are|is) not supported/i,
  /vision is not supported/i,
  /image input is not supported/i,
];

export function isImageRejection(error: unknown): boolean {
  const text = describeError(error);
  if (!REJECTION_PATTERNS.some((p) => p.test(text))) return false;
  const status = statusOf(error);
  return status === undefined || (status >= 400 && status < 500);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const kind = (error as { kind?: unknown }).kind;
  if (kind === "http_status") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

function imagesOf(block: ContentBlock): ImageBlock[] {
  if (block.type === "image") return [block];
  return block.type === "tool_result" ? toolResultImages(block.content) : [];
}

export function countImageBlocks(messages: readonly WireMessage[]): number {
  return messages.reduce((total, message) => total + message.content.reduce((n, block) => n + imagesOf(block).length, 0), 0);
}

export interface StripOutcome {
  messages: WireMessage[];
  stripped: number;
}

export function stripImageBlocks(
  messages: readonly WireMessage[],
  reason: string,
  dropOldest = Number.POSITIVE_INFINITY,
): StripOutcome {
  const images = messages.flatMap((message) => message.content.flatMap(imagesOf));
  const kept = images.map((_, i) => i >= dropOldest);
  let stripped = 0;
  let position = 0;
  const notice = (label: string): ContentBlock => {
    stripped += 1;
    return { type: "text", text: omissionNotice(label, reason) };
  };

  const out = messages.map((message) => {
    const start = position;
    position += message.content.reduce((n, block) => n + imagesOf(block).length, 0);
    if (kept.slice(start, position).every(Boolean)) return message;
    let next = start;
    const drops = (b: ContentBlock): boolean => b.type === "image" && !kept[next++];
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type === "image") return drops(block) ? notice("an attached image") : block;
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      const dropped = block.content.map(drops);
      return {
        ...block,
        is_error: dropped.some(Boolean) || block.is_error === true,
        content: block.content.map((b, i) => (dropped[i] === true ? notice("a tool result image") : b)),
      };
    });
    return { ...message, content };
  });
  return { messages: out, stripped };
}

export const MAX_REQUEST_IMAGES = 100;
export const MAX_REQUEST_IMAGE_BASE64_CHARS = 20_000_000;
export const REQUEST_IMAGE_DROP_STEP = 50;
export const REQUEST_IMAGE_DROP_STEP_CHARS = 10_000_000;

// Drops the oldest images in whole steps, so the cutoff stays put (and the prompt cache stays valid) until history grows by another step.
export function capRequestImages(messages: readonly WireMessage[]): StripOutcome {
  const sizes = messages.flatMap((message) => message.content.flatMap(imagesOf)).map((image) => image.source.data.length);
  const excessImages = sizes.length - MAX_REQUEST_IMAGES;
  const excessChars = sizes.reduce((total, size) => total + size, 0) - MAX_REQUEST_IMAGE_BASE64_CHARS;
  let drop = excessImages > 0 ? Math.ceil(excessImages / REQUEST_IMAGE_DROP_STEP) * REQUEST_IMAGE_DROP_STEP : 0;
  if (excessChars > 0) {
    const target = Math.ceil(excessChars / REQUEST_IMAGE_DROP_STEP_CHARS) * REQUEST_IMAGE_DROP_STEP_CHARS;
    let dropped = 0;
    let count = 0;
    while (count < sizes.length && dropped < target) dropped += sizes[count++] ?? 0;
    drop = Math.max(drop, count);
  }
  if (drop === 0) return { messages: [...messages], stripped: 0 };
  return stripImageBlocks(
    messages,
    `only the newest ${String(MAX_REQUEST_IMAGES)} images, up to ${String(MAX_REQUEST_IMAGE_BASE64_CHARS)} base64 characters in total, are sent per request; older ones are dropped in batches`,
    drop,
  );
}

export function textOnlyReason(providerKey: string, modelId: string): string {
  return `${providerKey}/${modelId} does not accept images`;
}
