import { realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { MAX_LISTED_MEDIA_NOTES } from "./media.ts";
import { openRegularFile } from "./file_access.ts";
import { imageMime, MAX_READ_IMAGE_BYTES } from "./read_image.ts";
import { embeddedPicture, workspaceNames, type WorkspaceNames } from "./workspace_names.ts";

export interface PictureTarget {
  target: string;
  wikilink: boolean;
}

export type PictureLookup = { path: string } | { problem: string } | null;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

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
    if (size > MAX_READ_IMAGE_BYTES) throw new Error(`it is ${String(size)} bytes, over the ${String(MAX_READ_IMAGE_BYTES)}-byte limit for pictures`);
    const header = Buffer.alloc(12);
    const head = await file.read(header, 0, header.length, 0);
    if (imageMime(header.subarray(0, head.bytesRead)) === undefined) throw new Error("it is not a PNG, JPEG, GIF or WebP picture");
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
  const root = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const results: PictureLookup[] = [];
  for (const { target, wikilink } of targets) {
    signal?.throwIfAborted();
    try {
      const requested = resolve(workspaceDir, target);
      if (!wikilink && await exists(requested)) {
        const real = await realpath(requested);
        if (!inside(root, real)) throw new Error(`${target} is outside the workspace`);
        results.push(await checked(real));
        continue;
      }
      const path = embeddedPicture(await found(), target, MAX_LISTED_MEDIA_NOTES);
      results.push(path === undefined ? null : await checked(path));
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
