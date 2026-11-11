import { shoreLog } from "../log.ts";

import { readFileSync } from "node:fs";

import type { ImageRef, Message } from "./types";
import { isSentPicture, isSentVideo, shownPicturePath } from "../storage/sent_pictures.ts";
import { pictureFileMatches } from "./picture_files.ts";

export function imageDataForPath(path: string): string | undefined {
  if (path === "") return undefined;
  try {
    const shown = isSentPicture(path) ? shownPicturePath(path) : path;
    return isSentVideo(shown) ? undefined : readFileSync(shown).toString("base64");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") shoreLog.debug(`shore: no image file to embed at ${path}`);
    else shoreLog.warn(`shore: failed to read image for wire embedding at ${path}: ${String(e)}`);
    return undefined;
  }
}

export function imageDataFor(image: ImageRef): string | undefined {
  return pictureFileMatches(image) ? imageDataForPath(image.path) : undefined;
}

export function embedImageData(images: ImageRef[] | undefined): void {
  if (images === undefined) return;
  for (const img of images) {
    if (img.data !== undefined) continue;
    const data = imageDataFor(img);
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
