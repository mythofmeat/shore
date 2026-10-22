import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HistoryStore } from "../src/engine/history_store.ts";
import { sha256Hex } from "../src/engine/picture_ids.ts";
import type { ImageRef, Message } from "../src/engine/types.ts";
import { repointArchivedImages } from "../src/storage/archived_images.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { useImageCacheFor } from "../src/storage/image_blobs.ts";
import { attachmentCacheDir } from "../src/storage/image_cache.ts";
import { moveImagesToCache } from "../src/storage/image_migration.ts";
import { sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { noisePng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

function install(root: string) {
  const data = join(root, "data");
  const cache = join(root, "cache");
  initializeDatabase(data);
  useImageCacheFor(data, cache);
  return { data, cache };
}

function shown(images: ImageRef[]): Message {
  return {
    msg_id: crypto.randomUUID(), role: "user", content: "look", images,
    content_blocks: [{ type: "text", text: "look" }], timestamp: "2026-10-01T10:00:00+10:00",
  };
}

function archive(data: string, messages: Message[]): void {
  const store = HistoryStore.open(join(data, "shore.db"));
  try {
    store.putSegment("ada", 0, { file: "0001.jsonl", message_count: messages.length, compacted_at: "2026-10-01T11:00:00+10:00" }, messages);
  } finally {
    store.close();
  }
}

function archivedImages(data: string): ImageRef[] {
  const store = HistoryStore.open(join(data, "shore.db"));
  try {
    return store.readSegment("ada", 0).flatMap((message) => message.images);
  } finally {
    store.close();
  }
}

async function png(seed: number): Promise<Buffer<ArrayBuffer>> {
  return Buffer.from(await noisePng(4, 4, seed));
}

async function put(path: string, bytes: Buffer): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

test("archived pictures still open after the data and cache dirs move", async () => {
  const root = testTmp(`archived-pictures-${crypto.randomUUID()}`);
  const before = install(join(root, "old"));
  const cat = await png(1);
  const drawing = await png(2);
  const attachment = await put(join(attachmentCacheDir(before.cache, "ada"), "20261001_100000_cat.png"), cat);
  const sent = await put(join(sentPicturesDir(before.data, "ada"), `${sha256Hex(drawing)}.png`), drawing);
  archive(before.data, [shown([{ path: attachment, sha256: sha256Hex(cat) }]), shown([{ path: sent, embed: "![[drawing.png]]", name: "drawing.png" }])]);

  await rename(join(root, "old"), join(root, "new"));
  const after = install(join(root, "new"));

  const images = archivedImages(after.data);
  expect(images.map((image) => image.path)).toEqual([
    join(attachmentCacheDir(after.cache, "ada"), "20261001_100000_cat.png"),
    join(sentPicturesDir(after.data, "ada"), `${sha256Hex(drawing)}.png`),
  ]);
  expect(images.map((image) => readFileSync(image.path))).toEqual([cat, drawing]);
});

test("archived pictures at paths from an older layout are repointed to where the file is now", async () => {
  const { data, cache } = install(testTmp(`archived-pictures-${crypto.randomUUID()}`));
  const cat = await png(3);
  const drawing = await png(4);
  const lost = await png(5);
  archive(data, [
    shown([{ path: "/home/someone/.local/share/shore/media/ada/attachments/20260901_090000_cat.png" }]),
    shown([{ path: `/data/media/ada/sent/${sha256Hex(drawing)}.png`, embed: "![[drawing.png]]" }]),
    shown([{ path: "/cache/characters/ada/images/attachments/20260902_090000_lost.png", sha256: sha256Hex(lost) }]),
  ]);
  const catNow = await put(join(attachmentCacheDir(cache, "ada"), "20260901_090000_cat.png"), cat);
  const drawingNow = await put(join(sentPicturesDir(data, "ada"), `${sha256Hex(drawing)}.png`), drawing);

  expect(repointArchivedImages(data, cache)).toEqual({ kept: 0, repointed: 2, missing: 1 });

  expect(archivedImages(data)).toEqual([
    { path: catNow, sha256: sha256Hex(cat) },
    { path: drawingNow, embed: "![[drawing.png]]" },
    { path: "/cache/characters/ada/images/attachments/20260902_090000_lost.png", sha256: sha256Hex(lost) },
  ]);
  expect(repointArchivedImages(data, cache)).toBeUndefined();
});

test("moving legacy attachments into the cache keeps the pictures archived messages show", async () => {
  const { data, cache } = install(testTmp(`archived-pictures-${crypto.randomUUID()}`));
  const cat = await png(6);
  const legacy = await put(join(data, "media", "ada", "attachments", "20260915_120000_cat.png"), cat);
  await put(join(data, "media", "ada", "attachments", "20260915_130000_unused.png"), await png(7));
  archive(data, [shown([{ path: legacy }])]);

  expect(moveImagesToCache(data, cache)).toEqual({ moved: 1, removed: 1 });

  expect(existsSync(legacy)).toBe(false);
  const [image] = archivedImages(data);
  expect(image?.path).toBe(join(attachmentCacheDir(cache, "ada"), "20260915_120000_cat.png"));
  expect(readFileSync(image?.path ?? "")).toEqual(cat);
});
