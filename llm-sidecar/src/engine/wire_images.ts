/**
 * Filling in `ImageRef.data` before a message goes over the wire.
 *
 * Ported from the three embedding helpers in
 * `crates/daemon/src/handler/images.rs`, pinned by the snapshot cases in
 * `tests/engine_fixtures/engine_parity.json`.
 *
 * Images live on disk as paths. A client — the TUI, the matrix bridge — may be
 * on a different machine and cannot open them, so every snapshot that leaves
 * the daemon carries the bytes inline. `Message.serializeForStorage` strips
 * `data` again on the way back to disk, so this is a wire concern only and the
 * stored conversation never grows base64.
 *
 * This lives beside the engine rather than with `llm/images.ts`, which does a
 * different job: that one resolves media types and enforces a size cap for a
 * *provider* request. Here there is no cap and no type check, because the
 * client renders whatever it is handed. When the handler moves (#12, step 3)
 * these will be neighbours again.
 *
 * An unreadable path is not an error. The Rust logged and moved on, leaving
 * `data` absent — a broken attachment costs one missing image, not the whole
 * history snapshot the client needs to render anything at all.
 */

import { readFileSync } from "node:fs";

import type { ImageRef, Message } from "./types";

/** Base64 of whatever is at `path`, or `undefined` if it cannot be read. */
export function imageDataForPath(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64");
  } catch (e) {
    console.warn(`shore: failed to read image for wire embedding at ${path}: ${String(e)}`);
    return undefined;
  }
}

/** Populate `data` on each ref that does not already carry it. */
export function embedImageData(images: ImageRef[] | undefined): void {
  if (images === undefined) return;
  for (const img of images) {
    // An already-inlined ref is left alone: it may have arrived from a client
    // that had bytes we have no path for.
    if (img.data !== undefined) continue;
    const data = imageDataForPath(img.path);
    if (data !== undefined) img.data = data;
  }
}

/** Populate `data` on a message's own images and on every alternative's. */
export function embedMessageImageData(message: Message): void {
  embedImageData(message.images);
  for (const alt of message.alternatives ?? []) {
    embedImageData(alt.images);
  }
}

/** Populate `data` across a whole slice, in place. */
export function embedMessagesImageData(messages: Message[]): void {
  for (const message of messages) {
    embedMessageImageData(message);
  }
}
