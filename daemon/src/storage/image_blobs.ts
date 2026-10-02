import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { extensionForMediaType, sniffMediaType } from "../handler/images.ts";
import { omissionNotice } from "../llm/images.ts";
import { shoreLog } from "../log.ts";
import { imageCacheDir, markImagesUsed, noteCachedImages } from "./image_cache.ts";

const CACHED_IMAGE_SOURCE = "shore_image";
export const EVICTED_IMAGE = "no longer cached";

interface ImageReference {
  sha256: string;
  media_type: string;
  bytes: number;
}

export interface ImageBlobs {
  store(mediaType: string, data: string): ImageReference | undefined;
  load(reference: ImageReference): string | undefined;
}

const caches = new Map<string, string>();

export function useImageCacheFor(data: string, cache: string): void {
  caches.set(resolve(data), cache);
}

export function imageCacheFor(data: string): string | undefined {
  return caches.get(resolve(data));
}

export const imageBlobDir = (cache: string, character: string): string => join(imageCacheDir(cache, character), "blobs");

function blobPath(cache: string, character: string, reference: ImageReference): string {
  return join(imageBlobDir(cache, character), `${reference.sha256}.${extensionForMediaType(reference.media_type) ?? "bin"}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageBlobs(cache: string, character: string, markUsed: boolean): ImageBlobs {
  return {
    store(mediaType, data) {
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("base64") !== data) return undefined;
      const reference: ImageReference = { sha256: sha256(bytes), media_type: mediaType, bytes: bytes.byteLength };
      const path = blobPath(cache, character, reference);
      const partial = `${path}.${randomUUID()}.partial`;
      try {
        if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) return reference;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(partial, bytes);
        renameSync(partial, path);
      } catch (error) {
        if (existsSync(partial)) rmSync(partial);
        shoreLog.warn(`shore: could not keep an image in the image cache at ${path}, so it stays where it was: ${String(error)}`);
        return undefined;
      }
      noteCachedImages(cache, bytes.byteLength);
      return reference;
    },
    load(reference) {
      const path = blobPath(cache, character, reference);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        return undefined;
      }
      if (markUsed) markImagesUsed([path]);
      return bytes.toString("base64");
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineImage(value: unknown): { media_type: string; data: string } | undefined {
  if (!isObject(value) || value["type"] !== "image" || !isObject(value["source"])) return undefined;
  const source = value["source"];
  if (source["type"] !== "base64" || typeof source["media_type"] !== "string" || typeof source["data"] !== "string") return undefined;
  return { media_type: source["media_type"], data: source["data"] };
}

function cachedReference(value: unknown): ImageReference | undefined {
  if (!isObject(value) || value["type"] !== "image" || !isObject(value["source"])) return undefined;
  const source = value["source"];
  if (source["type"] !== CACHED_IMAGE_SOURCE || typeof source["sha256"] !== "string" || typeof source["media_type"] !== "string" || typeof source["bytes"] !== "number") return undefined;
  return { sha256: source["sha256"], media_type: source["media_type"], bytes: source["bytes"] };
}

function mapJson(value: unknown, replace: (value: unknown) => unknown): unknown {
  const replaced = replace(value);
  if (replaced !== value) return replaced;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = mapJson(item, replace);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (isObject(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const next = mapJson(item, replace);
      if (next !== item) changed = true;
      return [key, next] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

export function withImageReferences<T>(value: T, blobs: ImageBlobs): T {
  return mapJson(value, (item) => {
    const image = inlineImage(item);
    if (image === undefined) return item;
    const reference = blobs.store(image.media_type, image.data);
    if (reference === undefined) return item;
    return { ...(item as Record<string, unknown>), source: { type: CACHED_IMAGE_SOURCE, ...reference } };
  }) as T;
}

export function withImageData<T>(value: T, blobs: ImageBlobs | undefined): T {
  return mapJson(value, (item) => {
    const reference = cachedReference(item);
    if (reference === undefined) return item;
    const data = blobs?.load(reference);
    if (data === undefined) return { type: "text", text: omissionNotice(referenceLabel(reference), EVICTED_IMAGE) };
    const { source: _source, ...rest } = item as Record<string, unknown>;
    return { ...rest, source: { type: "base64", media_type: reference.media_type, data } };
  }) as T;
}

function referenceLabel(reference: ImageReference): string {
  return `${reference.sha256.slice(0, 12)}.${extensionForMediaType(reference.media_type) ?? "bin"}`;
}

const BASE64_IMAGE = /(?<="|base64,)(?:iVBORw0KGg|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/]{64,}={0,2}(?=")/g;

function imageToken(reference: ImageReference): string {
  return `shore-image:sha256=${reference.sha256};type=${reference.media_type};bytes=${String(reference.bytes)}`;
}

export function withImageTokens(text: string): string {
  return text.replace(BASE64_IMAGE, (match) => {
    const bytes = Buffer.from(match, "base64");
    const mediaType = sniffMediaType(bytes);
    if (mediaType === undefined) return match;
    return imageToken({ sha256: sha256(bytes), media_type: mediaType, bytes: bytes.byteLength });
  });
}
