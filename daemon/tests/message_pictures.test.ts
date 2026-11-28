import { expect, test } from "bun:test";
import { mkdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_SENT_VIDEO_BYTES } from "../src/storage/sent_pictures.ts";
import { lookUpPictures } from "../src/tools/message_pictures.ts";
import { MAX_READ_IMAGE_BYTES } from "../src/tools/read_image.ts";
import { transparentPng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

async function workspace(): Promise<string> {
  const dir = testTmp(`message-pictures-${crypto.randomUUID()}`);
  await mkdir(join(dir, "folder.png"), { recursive: true });
  await writeFile(join(dir, "words.png"), "just some words");
  for (const [name, head, size] of [["limit.png", transparentPng(2, 2), MAX_READ_IMAGE_BYTES], ["over.png", transparentPng(2, 2), MAX_READ_IMAGE_BYTES + 1], ["over.mp4", mp4, MAX_SENT_VIDEO_BYTES + 1]] as const) {
    await writeFile(join(dir, name), head);
    await truncate(join(dir, name), size);
  }
  return dir;
}

test("a picture in a message is looked up as a file that is a picture or video within its size limit, and refused with why otherwise", async () => {
  const dir = await workspace();
  const found = await lookUpPictures({ workspaceDir: dir, texts: {}, targets: ["limit.png", "folder.png", "words.png", "over.png", "over.mp4"].map((target) => ({ target, wikilink: false })) });
  expect(found).toEqual([
    { path: join(dir, "limit.png") },
    { problem: `${join(dir, "folder.png")} is not a regular file` },
    { problem: "it is not a PNG, JPEG, GIF or WebP picture, or an MP4 or WebM video" },
    { problem: `it is ${String(MAX_READ_IMAGE_BYTES + 1)} bytes, over the ${String(MAX_READ_IMAGE_BYTES)}-byte limit for pictures` },
    { problem: `it is ${String(MAX_SENT_VIDEO_BYTES + 1)} bytes, over the ${String(MAX_SENT_VIDEO_BYTES)}-byte limit for videos` },
  ]);
});
