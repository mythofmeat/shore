import { readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { characterCacheDir } from "../config/dirs.ts";
import { shoreLog } from "../log.ts";

export const DEFAULT_IMAGE_CACHE_BYTES = 512 * 1024 * 1024;
export const RECENT_USE_MS = 60 * 60 * 1000;

const CHARACTERS_DIR = "characters";
const IMAGES_DIR = "images";
const MODEL_COPIES_DIR = "model";

export const imageCacheDir = (cache: string, character: string): string =>
  join(characterCacheDir(cache, character), IMAGES_DIR);
export const attachmentCacheDir = (cache: string, character: string): string =>
  join(imageCacheDir(cache, character), "attachments");
export const toolImageCacheDir = (cache: string, character: string): string =>
  join(imageCacheDir(cache, character), "tools");

let limitBytes = DEFAULT_IMAGE_CACHE_BYTES;
const totals = new Map<string, number>();

export function setImageCacheLimit(bytes: number): void {
  limitBytes = bytes;
}

export function imageCacheLimit(): number {
  return limitBytes;
}

export function markImagesUsed(paths: readonly string[], now: Date = new Date()): void {
  for (const path of paths) {
    try {
      utimesSync(path, now, now);
    } catch {}
  }
}

export function noteCachedImages(cache: string, bytes: number, nowMs: number = Date.now()): void {
  const known = totals.get(cache);
  const total = known === undefined ? cachedImageBytes(cache) : known + bytes;
  totals.set(cache, total > limitBytes ? evictCachedImages(cache, limitBytes, nowMs).remaining : total);
}

export function forgetImageCacheTotals(): void {
  totals.clear();
}

export interface CachedImage {
  key: string;
  paths: string[];
  bytes: number;
  usedAt: number;
}

export function cachedImages(cache: string): CachedImage[] {
  const byKey = new Map<string, CachedImage>();
  for (const character of entriesOf(join(cache, CHARACTERS_DIR))) {
    for (const file of filesUnder(join(cache, CHARACTERS_DIR, character, IMAGES_DIR))) {
      const key = imageKey(file.path);
      const image = byKey.get(key) ?? { key, paths: [], bytes: 0, usedAt: 0 };
      image.paths.push(file.path);
      image.bytes += file.bytes;
      image.usedAt = Math.max(image.usedAt, file.usedAt);
      byKey.set(key, image);
    }
  }
  return [...byKey.values()];
}

export function cachedImageBytes(cache: string): number {
  return cachedImages(cache).reduce((total, image) => total + image.bytes, 0);
}

export interface Eviction {
  removed: number;
  freed: number;
  remaining: number;
}

export function evictCachedImages(cache: string, limit: number = limitBytes, nowMs: number = Date.now()): Eviction {
  const images = cachedImages(cache).sort((a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const eviction: Eviction = { removed: 0, freed: 0, remaining: images.reduce((total, image) => total + image.bytes, 0) };
  for (const image of images) {
    if (eviction.remaining <= limit || nowMs - image.usedAt < RECENT_USE_MS) break;
    for (const path of image.paths) rmSync(path, { force: true });
    eviction.removed += 1;
    eviction.freed += image.bytes;
    eviction.remaining -= image.bytes;
  }
  if (eviction.removed > 0) {
    shoreLog.info(
      `shore: the image cache was over ${megabytes(limit)} MB; removed the ${String(eviction.removed)} least recently used images ` +
        `(${megabytes(eviction.freed)} MB), ${megabytes(eviction.remaining)} MB remain`,
    );
  }
  totals.set(cache, eviction.remaining);
  return eviction;
}

function imageKey(path: string): string {
  const parent = dirname(path);
  if (basename(parent) !== MODEL_COPIES_DIR) return path;
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return join(dirname(parent), dot > 0 ? name.slice(0, dot) : name);
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function filesUnder(dir: string): { path: string; bytes: number; usedAt: number }[] {
  const files: { path: string; bytes: number; usedAt: number }[] = [];
  for (const name of entriesOf(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) files.push(...filesUnder(path));
    else if (stat.isFile()) files.push({ path, bytes: stat.size, usedAt: stat.mtimeMs });
  }
  return files;
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}
