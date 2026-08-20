import { shoreLog } from "../log.ts";

import fs from "node:fs";
import path from "node:path";

import type { ContentBlock } from "../engine/types.ts";
import { describeError } from "./errors.ts";
import { omissionNotice } from "./images.ts";
import type { WireMessage } from "./types.ts";

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

export function countImageBlocks(messages: readonly WireMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "image") total += 1;
    }
  }
  return total;
}

export interface StripOutcome {
  messages: WireMessage[];
  stripped: number;
}

export function stripImageBlocks(
  messages: readonly WireMessage[],
  reason: string,
): StripOutcome {
  let stripped = 0;
  const out = messages.map((message) => {
    if (!message.content.some((b) => b.type === "image")) return message;
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type !== "image") return block;
      stripped += 1;
      return { type: "text", text: omissionNotice("an attached image", reason) };
    });
    return { ...message, content };
  });
  return { messages: out, stripped };
}

export function textOnlyReason(providerKey: string, modelId: string): string {
  return `${providerKey}/${modelId} does not accept images`;
}
