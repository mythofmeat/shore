import { shoreLog } from "../log.ts";

import { readFileSync } from "node:fs";

import type { ImageRef, Message } from "./types";

export function imageDataForPath(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64");
  } catch (e) {
    shoreLog.warn(`shore: failed to read image for wire embedding at ${path}: ${String(e)}`);
    return undefined;
  }
}

export function embedImageData(images: ImageRef[] | undefined): void {
  if (images === undefined) return;
  for (const img of images) {
    if (img.data !== undefined) continue;
    const data = imageDataForPath(img.path);
    if (data !== undefined) img.data = data;
  }
}

function embedMessageImageData(message: Message): void {
  embedImageData(message.images);
  for (const alt of message.alternatives ?? []) {
    embedImageData(alt.images);
  }
}

export function embedMessagesImageData(messages: Message[]): void {
  for (const message of messages) {
    embedMessageImageData(message);
  }
}
