import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { ImageRef } from "./types.ts";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pictureFileLabel(path: string): string {
  return `[picture: ${path}]`;
}

const hashedFiles = new Map<string, { ino: number; size: number; mtimeMs: number; sha256: string }>();

function fileSha256(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return undefined;
  const known = hashedFiles.get(path);
  if (known !== undefined && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha256;
  let sha256: string;
  try {
    sha256 = sha256Hex(readFileSync(path));
  } catch {
    return undefined;
  }
  hashedFiles.set(path, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}

export function namedByHash(path: string, sha256: string): boolean {
  return basename(path).split(".")[0] === sha256;
}

export function pictureFileMatches(image: ImageRef): boolean {
  if (image.sha256 === undefined || namedByHash(image.path, image.sha256)) return true;
  return fileSha256(image.path) === image.sha256;
}
