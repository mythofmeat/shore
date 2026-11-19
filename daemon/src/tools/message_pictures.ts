import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_LISTED_MEDIA_NOTES } from "./media.ts";
import { openRegularFile } from "./file_access.ts";
import { imageMime, MAX_READ_IMAGE_BYTES } from "./read_image.ts";
import { MEDIA_HEADER_BYTES, videoMime } from "./video.ts";
import { embeddedPicture, PICTURES_AND_VIDEOS, workspaceNames, type WorkspaceNames } from "./workspace_names.ts";
import { MAX_SENT_VIDEO_BYTES } from "../storage/sent_pictures.ts";

export interface PictureTarget {
  target: string;
  wikilink: boolean;
}

export type PictureLookup = { path: string } | { problem: string } | null;

export const CANNOT_BE_SENT = "it is not a PNG, JPEG, GIF or WebP picture, or an MP4 or WebM video";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function checked(path: string): Promise<{ path: string }> {
  const file = await openRegularFile(path);
  try {
    const size = (await file.stat()).size;
    const header = Buffer.alloc(MEDIA_HEADER_BYTES);
    const head = await file.read(header, 0, header.length, 0);
    const sniffed = header.subarray(0, head.bytesRead);
    const video = videoMime(sniffed) !== undefined;
    const limit = video ? MAX_SENT_VIDEO_BYTES : MAX_READ_IMAGE_BYTES;
    if (size > limit) throw new Error(`it is ${String(size)} bytes, over the ${String(limit)}-byte limit for ${video ? "videos" : "pictures"}`);
    if (!video && imageMime(sniffed) === undefined) throw new Error(CANNOT_BE_SENT);
    return { path };
  } finally {
    await file.close();
  }
}

export async function lookUpPictures(
  { workspaceDir, targets }: { workspaceDir: string; targets: PictureTarget[] },
  signal?: AbortSignal,
): Promise<PictureLookup[]> {
  let names: Promise<WorkspaceNames> | undefined;
  const found = () => names ??= workspaceNames(workspaceDir, signal);
  const results: PictureLookup[] = [];
  for (const { target, wikilink } of targets) {
    signal?.throwIfAborted();
    try {
      const requested = resolve(workspaceDir, target);
      if (!wikilink && await exists(requested)) {
        results.push(await checked(requested));
        continue;
      }
      const path = await embeddedPicture(await found(), target, MAX_LISTED_MEDIA_NOTES, PICTURES_AND_VIDEOS);
      results.push(path === undefined ? null : await checked(path));
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
