import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import type { ImageRef } from "./types.ts";

const PICTURE_ID_LENGTH = 8;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pictureId(sha256: string): string {
  return sha256.slice(0, PICTURE_ID_LENGTH);
}

export function pictureLabel(sha256: string): string {
  return `[picture ${pictureId(sha256)}]`;
}

const hashedFiles = new Map<string, { ino: number; size: number; sha256: string }>();

export function pictureSha256(image: ImageRef): string | undefined {
  if (image.sha256 !== undefined) return image.sha256;
  if (image.path === "") return undefined;
  const stat = statSync(image.path, { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return undefined;
  const known = hashedFiles.get(image.path);
  if (known !== undefined && known.ino === stat.ino && known.size === stat.size) return known.sha256;
  let sha256: string;
  try {
    sha256 = sha256Hex(readFileSync(image.path));
  } catch {
    return undefined;
  }
  hashedFiles.set(image.path, { ino: stat.ino, size: stat.size, sha256 });
  return sha256;
}
