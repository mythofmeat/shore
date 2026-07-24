/**
 * Image attachment helpers for LLM requests.
 *
 * Reads an `ImageRef` (path on disk OR inline base64 data already on the
 * ref) and produces the canonical mime type + base64 bytes. Adapters
 * wrap those into their respective image block shapes:
 *   - Anthropic: `{type:"image", source:{type:"base64", media_type, data}}`
 *   - OpenAI:    `{type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}`
 *
 * The Rust impl had a resize + cache layer (`handler/resize.rs`); we omit
 * it for 4c.1 polish. Images larger than `DEFAULT_MAX_IMAGE_BYTES` are
 * skipped with a console warning rather than failing the whole turn.
 */
import fs from "node:fs";
import path from "node:path";

import type { ImageRef } from "../engine/types.ts";

/** Default cap matches Anthropic's documented 5 MiB per-image limit. */
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ResolvedImage {
  mediaType: string;
  base64: string;
}

const SUPPORTED_MIME = new Set(Object.values(MIME_BY_EXT));

/** Decoded byte count of a base64 payload (4 chars ≈ 3 bytes), so an oversized
 * image is dropped before it reaches an adapter. */
function base64Bytes(data: string): number {
  const normalized = data.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

/**
 * Resolve an inlined `image` content block into the same `ResolvedImage` the
 * `ImageRef` path produces.
 *
 * This is the shape the daemon actually sends: it synthesizes base64 `image`
 * blocks from a message's images and inlines them into the wire `content`
 * array (`encode_image_block` in `handler/images.rs`), and never populates a
 * separate `images` field. Adapters must therefore read images off `content`.
 *
 * Returns `undefined` — logging, never throwing — for an unsupported media
 * type or an oversized payload, matching `resolveImage`: a bad attachment
 * drops out of the turn rather than failing it.
 */
export function resolveImageBlock(
  source: { media_type: string; data: string },
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ResolvedImage | undefined {
  const mediaType = source.media_type?.toLowerCase();
  if (!mediaType || !SUPPORTED_MIME.has(mediaType)) {
    console.warn(`[image] unsupported media type ${source.media_type}; skipping`);
    return undefined;
  }
  if (!source.data) return undefined;
  const bytes = base64Bytes(source.data);
  if (bytes > maxBytes) {
    console.warn(
      `[image] inline image block is ${bytes} bytes; exceeds cap ${maxBytes}; skipping`,
    );
    return undefined;
  }
  return { mediaType, base64: source.data };
}

/**
 * Resolve an `ImageRef` into base64 bytes + media type, ready for either
 * adapter to wrap. Returns `undefined` if the file is missing, the MIME
 * type can't be detected, or the file exceeds the size cap — none of
 * these should fail the whole turn (consistent with the Rust impl,
 * which logs + drops the image).
 */
export function resolveImage(
  ref: ImageRef,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ResolvedImage | undefined {
  const mediaType = MIME_BY_EXT[path.extname(ref.path).toLowerCase()];
  if (!mediaType) {
    console.warn(`[image] unsupported extension for ${ref.path}; skipping`);
    return undefined;
  }

  if (ref.data !== undefined && ref.data.length > 0) {
    const inlineBytes = base64Bytes(ref.data);
    if (inlineBytes > maxBytes) {
      console.warn(
        `[image] inline image ${ref.path} is ${inlineBytes} bytes; exceeds cap ${maxBytes}; skipping`,
      );
      return undefined;
    }
    return { mediaType, base64: ref.data };
  }

  try {
    // Check the on-disk size before reading so an oversized file never gets
    // loaded into memory in full.
    const size = fs.statSync(ref.path).size;
    if (size > maxBytes) {
      console.warn(
        `[image] ${ref.path} is ${size} bytes; exceeds cap ${maxBytes}; skipping`,
      );
      return undefined;
    }
    const bytes = fs.readFileSync(ref.path);
    return { mediaType, base64: bytes.toString("base64") };
  } catch (e) {
    console.warn(`[image] could not read ${ref.path}: ${(e as Error).message}`);
    return undefined;
  }
}

// NOTE: an `imageRefFromInline({filename, data})` helper used to live here,
// unreferenced by anything. It encoded the same wrong assumption as the
// `turn.images` path: that the sidecar receives client-shaped inline uploads.
// It does not. The daemon ingests `image_data` uploads to disk
// (`handler/images.rs::ingest_images`) and hands this process fully-encoded
// `image` content blocks — see `resolveImageBlock`. Removed so it can't be
// mistaken for a live path.
