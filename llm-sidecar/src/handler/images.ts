/**
 * Image ingest and wire-block building for the message pipeline.
 *
 * Ported from `crates/daemon/src/handler/images.rs`, pinned by
 * `tests/handler_fixtures/images_parity.json`. The three `data`-embedding
 * helpers from that file already live in `engine/wire_images.ts`; what is here
 * is the other half — getting bytes off the wire onto disk safely, and getting
 * them back off disk into a provider request.
 *
 * Two jobs, opposite directions:
 *
 * - **Ingest.** A client sends base64 (`image_data`) or, on the legacy
 *   same-machine path, a filesystem path. Either way the bytes are copied into
 *   the character's `images/attachments/` directory under a name the client
 *   does not get to choose freely, and the conversation stores a path.
 * - **Encode.** A stored path is read back, resized if it exceeds the
 *   configured cap, and base64'd into the `image` block a provider wants.
 *
 * This supersedes `llm/images.ts`, which was a stopgap: it skipped an
 * oversized image with a warning where the Rust resized it.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContentBlock, ImageRef } from "../engine/types.ts";
import { base64Rejection } from "../tools/images.ts";

/** An `ImageUpload` off the wire: base64 bytes plus what the client called them. */
export interface ImageUpload {
  filename: string;
  mime_type?: string;
  data: string;
}

/**
 * Resize hook. Returns the replacement bytes and media type, or `undefined` to
 * send the original.
 *
 * Injected rather than imported so this module stays free of an image codec.
 * `handler/resize.ts` supplies the real one; leaving it out sends originals.
 */
export type CachedResize = (
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  maxBytes: number,
  cacheDir: string,
) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;

// ── Media types ─────────────────────────────────────────────────────────

/**
 * The media type implied by a path's extension, or `undefined`.
 *
 * **A path with no dot at all is treated as its own extension**, so a file
 * literally named `png` reads as a PNG. That is what `rsplit('.').next()` does
 * — on a string with no separator it yields the whole string — and it is
 * reproduced rather than fixed, because the same spelling decides which
 * attachments reach the model and a stored conversation may already rely on it.
 *
 * Matching is ASCII-lowercase because `to_ascii_lowercase` was. For the four
 * extensions in the table the two rules happen to agree — there is no
 * non-ASCII character that Unicode-lowercases *into* `jpg`, `jpeg`, `png`,
 * `gif` or `webp` — so this is a guarantee about the alphabet rather than a
 * difference you can observe today. It is kept because adding an extension is
 * what would make it observable, and that is the wrong moment to discover it.
 */
export function mediaTypeForPath(path: string): string | undefined {
  const ext = asciiLowercase(path.split(".").pop() ?? "");
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/** `str::to_ascii_lowercase` — ASCII only, so `İ` is left alone. */
function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The media type implied by an image's magic bytes.
 *
 * Consulted before the client's declared MIME type, because the bytes are the
 * only claim in an upload that the client cannot get wrong.
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  // The four-CC lives at offset 8, after `RIFF` and a four-byte length. A
  // buffer too short for that slice matches nothing rather than throwing.
  if (startsWith(bytes, ascii("RIFF")) && bytes.length >= 12 && matchesAt(bytes, 8, ascii("WEBP"))) {
    return "image/webp";
  }
  return undefined;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return matchesAt(bytes, 0, prefix);
}

function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((b, i) => bytes[offset + i] === b);
}

/**
 * The canonical file extension for a media type.
 *
 * Tolerates case and parameters as they arrive off the wire
 * (`Image/PNG; charset=binary`), by taking the essence before the first `;`.
 * A value that *starts* with `;` has an empty essence and matches nothing.
 */
export function extensionForMediaType(mediaType: string): string | undefined {
  const essence = asciiLowercase((mediaType.split(";")[0] ?? mediaType).trim());
  switch (essence) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return undefined;
  }
}

// ── Naming ──────────────────────────────────────────────────────────────

/**
 * Reduce a client-supplied filename to one safe path component.
 *
 * Upload filenames come straight off the wire, so they may carry separators,
 * NUL bytes, or be empty; joined into the attachments directory unchecked they
 * could escape it or fail the write. The last segment after either separator is
 * kept, NULs are dropped, and anything that reduces to nothing, `.`, or `..`
 * becomes `image`.
 *
 * The order matters: NULs are stripped *after* the split and *before* the
 * empty/dot check, so `..\0` is `..` by the time it is tested and becomes
 * `image` — a NUL cannot be used to smuggle a dot-dot past the guard.
 */
export function sanitizeFilename(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? name;
  const base = last.replaceAll("\u0000", "");
  return base === "" || base === "." || base === ".." ? "image" : base;
}

/**
 * Choose the attachment file name for incoming bytes.
 *
 * A recognized extension is kept as-is and the bytes are never consulted;
 * otherwise one is appended, derived from the magic bytes first and the
 * client-declared type second. Everything downstream keys the media type off
 * the saved extension, so an upload without one — routine for content-addressed
 * media, where the type travels out of band — would otherwise be silently
 * dropped from every request.
 */
export function attachmentFileName(
  filename: string,
  declaredMime: string | undefined,
  bytes: Uint8Array,
): string {
  const safe = sanitizeFilename(filename);
  if (mediaTypeForPath(safe) !== undefined) return safe;

  const sniffed = sniffMediaType(bytes);
  const extension =
    (sniffed === undefined ? undefined : extensionForMediaType(sniffed)) ??
    (declaredMime === undefined ? undefined : extensionForMediaType(declaredMime));

  if (extension !== undefined) return `${safe}.${extension}`;
  console.warn(
    `shore: could not determine image type from bytes, declared mime, or extension for ` +
      `${safe}; the LLM pipeline will skip this attachment`,
  );
  return safe;
}

/** `%Y%m%d_%H%M%S` in local time, the prefix every attachment name carries. */
export function attachmentStamp(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

// ── Writing ─────────────────────────────────────────────────────────────

/** How many `_1`, `_2`, … suffixes to try before giving up. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * Atomically claim a destination file, de-duplicating on collision.
 *
 * The timestamp in attachment names is second-granular, so two uploads sharing
 * a filename within the same second would otherwise overwrite each other.
 * `wx` is `O_CREAT | O_EXCL`, which makes the claim atomic; on collision the
 * name gains `_1`, `_2`, … *before* the extension.
 *
 * A name whose only dot is leading — `.hidden` — has no stem, so it is treated
 * as having no extension at all and de-duplicates to `.hidden_1`. That falls
 * out of `rsplit_once` plus the non-empty-stem guard, and is pinned.
 */
export async function createAttachmentFile(
  attachmentsDir: string,
  fileName: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const dotExt = dot > 0 ? fileName.slice(dot) : "";

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? fileName : `${stem}_${attempt}${dotExt}`;
    const path = join(attachmentsDir, candidate);
    try {
      return { path, handle: await open(path, "wx") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not find a free attachment name for ${fileName}`);
}

/**
 * Write bytes into the attachments directory under a timestamped,
 * extension-corrected name.
 *
 * Returns `undefined` on any failure, having logged it. A failed attachment
 * costs one image, never the turn — the message it arrived with is still worth
 * sending.
 */
export async function saveAttachment(
  attachmentsDir: string,
  sourceName: string,
  declaredMime: string | undefined,
  bytes: Uint8Array,
  now: Date = new Date(),
): Promise<ImageRef | undefined> {
  try {
    await mkdir(attachmentsDir, { recursive: true });
  } catch (e) {
    console.warn(`shore: failed to create attachments directory: ${String(e)}`);
    return undefined;
  }

  const destName = `${attachmentStamp(now)}_${attachmentFileName(sourceName, declaredMime, bytes)}`;
  let claimed: Awaited<ReturnType<typeof createAttachmentFile>>;
  try {
    claimed = await createAttachmentFile(attachmentsDir, destName);
  } catch (e) {
    console.warn(`shore: failed to create attachment file for ${sourceName}: ${String(e)}`);
    return undefined;
  }

  try {
    await claimed.handle.write(bytes);
  } catch (e) {
    console.warn(`shore: failed to write image to attachments for ${sourceName}: ${String(e)}`);
    // Remove the claim so the name is free again rather than leaving a
    // zero-byte file that later reads as a corrupt image.
    await claimed.handle.close().catch(() => {});
    await Bun.file(claimed.path)
      .unlink()
      .catch(() => {});
    return undefined;
  } finally {
    await claimed.handle.close().catch(() => {});
  }

  console.info(`shore: saved incoming image to attachments: ${sourceName} -> ${claimed.path}`);
  return { path: claimed.path };
}

// ── Ingest ──────────────────────────────────────────────────────────────

/**
 * Copy incoming images into the character's attachments directory.
 *
 * `imageData` wins outright: when a client sends base64 the legacy path list is
 * **not consulted at all**, even for paths the uploads do not cover. The two
 * lists describe the same attachments from clients of different vintages, so
 * reading both would double every image.
 *
 * The second return is the model-facing content blocks, and it is deliberately
 * always empty: attachment *paths* are kept out of what the model reads, and it
 * receives the images through the returned refs instead.
 */
export async function ingestImages(
  dataDir: string,
  charName: string,
  imagePaths: readonly string[],
  imageData: readonly ImageUpload[],
  now: Date = new Date(),
): Promise<{ images: ImageRef[]; blocks: ContentBlock[] }> {
  const attachmentsDir = join(dataDir, charName, "images", "attachments");
  const images: ImageRef[] = [];

  for (const upload of imageData) {
    const ref = await ingestUpload(attachmentsDir, upload, now);
    if (ref !== undefined) images.push(ref);
  }

  if (imageData.length === 0) {
    for (const src of imagePaths) {
      const ref = await ingestLegacyPath(attachmentsDir, src, now);
      if (ref !== undefined) images.push(ref);
    }
  }

  return { images, blocks: [] };
}

/** Decode and persist one base64 upload. `undefined` means skipped and logged. */
async function ingestUpload(
  attachmentsDir: string,
  upload: ImageUpload,
  now: Date,
): Promise<ImageRef | undefined> {
  // `Buffer.from(…, "base64")` is lenient: it skips characters outside the
  // alphabet and accepts unpadded input, so `"!!!not base64!!!"` decodes to
  // *something*. The Rust engine rejected both, and the difference is an
  // upload being skipped versus a junk file landing in the attachments
  // directory under a name that later reads as a corrupt image.
  const rejection = base64Rejection(upload.data);
  if (rejection !== undefined) {
    console.warn(
      `shore: failed to decode base64 image data for ${upload.filename}: ${rejection}`,
    );
    return undefined;
  }
  const bytes = decodeBase64(upload.data);
  return await saveAttachment(attachmentsDir, upload.filename, upload.mime_type, bytes, now);
}

/**
 * Copy one legacy filesystem path into attachments.
 *
 * Reads and re-writes rather than copying the file, so a source with no
 * extension still gains one from its magic bytes. When the copy fails but the
 * source exists, the original path is referenced instead — a same-machine
 * client can still render it, and the alternative is losing the image outright.
 */
async function ingestLegacyPath(
  attachmentsDir: string,
  srcPath: string,
  now: Date,
): Promise<ImageRef | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(srcPath);
  } catch {
    // The Rust checked existence first and logged a different line for a file
    // that was there but unreadable. Both end here, and both fall back to
    // referencing the original path — except a missing file, which is skipped.
    if (!(await Bun.file(srcPath).exists())) {
      console.warn(`shore: skipping non-existent image: ${srcPath}`);
      return undefined;
    }
    console.warn(`shore: failed to read image for attachments copy: ${srcPath}`);
    return { path: srcPath };
  }

  const name = srcPath.split(/[/\\]/).pop();
  const saved = await saveAttachment(
    attachmentsDir,
    name === undefined || name === "" ? "image" : name,
    undefined,
    bytes,
    now,
  );
  return saved ?? { path: srcPath };
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

// ── Encode ──────────────────────────────────────────────────────────────

/**
 * Build the content blocks for one message: images first, then text.
 *
 * **An empty or whitespace-only text yields no text block.** Anthropic rejects
 * `{"type":"text","text":""}` with "text content blocks must be non-empty" and
 * fails the whole request, so an image-only message must not carry one. A
 * message whose images all failed to encode and which has no text yields no
 * blocks at all, and the caller drops the turn rather than sending an empty one.
 *
 * Pass `0` for `maxImageSize` to disable resizing.
 */
export async function buildContent(
  text: string,
  images: readonly ImageRef[],
  maxImageSize: number,
  cacheDir: string,
  resize?: CachedResize,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  for (const img of images) {
    const source = await encodeImageBlock(img, maxImageSize, cacheDir, resize);
    if (source !== undefined) blocks.push({ type: "image", source });
  }

  // `trim` here is JavaScript's, which is a wider set than Rust's
  // `char::is_whitespace` for a handful of code points. Both agree on
  // everything a client actually sends as "blank", and the difference decides
  // only whether an exotic-whitespace-only message ships a text block.
  if (text.trim() !== "") blocks.push({ type: "text", text });

  return blocks;
}

/**
 * Read one image off disk and encode it for a provider request.
 *
 * Returns `undefined` — having said why — for an unsupported extension or an
 * unreadable file. The extension check happens first and without touching the
 * disk, so a `.bmp` that exists is skipped exactly like one that does not.
 */
export async function encodeImageBlock(
  img: ImageRef,
  maxImageSize: number,
  cacheDir: string,
  resize?: CachedResize,
): Promise<{ type: "base64"; media_type: string; data: string } | undefined> {
  const mediaType = mediaTypeForPath(img.path);
  if (mediaType === undefined) {
    console.warn(`shore: skipping image with unsupported extension: ${img.path}`);
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(img.path);
  } catch (e) {
    console.warn(`shore: failed to read image file for LLM: ${img.path}: ${String(e)}`);
    return undefined;
  }

  const resized = await resize?.(img.path, bytes, mediaType, maxImageSize, cacheDir);
  const final = resized ?? { bytes, mediaType };

  return {
    type: "base64",
    media_type: final.mediaType,
    data: Buffer.from(final.bytes).toString("base64"),
  };
}
