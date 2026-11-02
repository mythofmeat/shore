import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { imageDataForPath } from "../src/engine/wire_images.ts";
import { firstSentPicture, pictureProblems, sendPictures } from "../src/handler/pictures.ts";
import { displayCopyPath, keepSentPicture, keepSentVideo, MAX_SENT_VIDEO_BYTES, shownPicturePath } from "../src/storage/sent_pictures.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { handleRead } from "../src/tools/read.ts";
import { animatedPng, noisePng, transparentPng, withTextChunk } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

const MB = 1024 * 1024;

const mp4Header = (brand = "isom") => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);

const webmHeader = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);

const refusal = async (attempt: Promise<unknown>): Promise<string> => await attempt.then(() => "it went through", (error: unknown) => String(error));

async function world() {
  const root = testTmp(`sent-media-${crypto.randomUUID()}`);
  const dir = join(root, "workspace");
  const sent = join(root, "media", "ada", "sent");
  await mkdir(dir, { recursive: true });
  await mkdir(sent, { recursive: true });
  return { dir, sent, sender: { workspace: new CharacterWorkspace(dir), dir: sent } };
}

function animatedWebp(size: number): Buffer {
  const canvas = Buffer.from([0x02, 0, 0, 0, 0x0f, 0, 0, 0x0f, 0, 0]);
  const padding = Buffer.alloc(size - 12 - 18 - 8);
  const body = Buffer.concat([Buffer.from("WEBPVP8X"), Buffer.from([10, 0, 0, 0]), canvas, Buffer.from("JUNK"), Buffer.alloc(4), padding]);
  body.writeUInt32LE(padding.length, 22);
  const head = Buffer.from("RIFF0000");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

test("an animated PNG keeps moving past the still-picture limit, where a still PNG gets a flat copy", async () => {
  const { sent } = await world();
  const small = transparentPng(16, 16);
  const still = await keepSentPicture(sent, withTextChunk(small, 2 * MB), "image/png");
  expect(shownPicturePath(still)).toBe(displayCopyPath(still));
  const moving = await keepSentPicture(sent, withTextChunk(animatedPng(small), 2 * MB), "image/png");
  expect(shownPicturePath(moving)).toBe(moving);
  const huge = await keepSentPicture(sent, withTextChunk(animatedPng(small), 8 * MB), "image/png");
  expect(shownPicturePath(huge)).toBe(displayCopyPath(huge));
});

test("sending an animated picture again drops the flat copy an older version made of it", async () => {
  const { sent } = await world();
  const moving = animatedPng(transparentPng(16, 16));
  const first = await keepSentPicture(sent, moving, "image/png");
  await mkdir(join(sent, "display"), { recursive: true });
  await writeFile(displayCopyPath(first), "flat");
  expect(await keepSentPicture(sent, moving, "image/png")).toBe(first);
  expect(existsSync(displayCopyPath(first))).toBe(false);
});

test("an animated WebP is shown as it is up to the gif limit and refused past it, because it has no flat copy to fall back on", async () => {
  const { sent } = await world();
  const fits = await keepSentPicture(sent, animatedWebp(2 * MB), "image/webp");
  expect(shownPicturePath(fits)).toBe(fits);
  expect(await refusal(keepSentPicture(sent, animatedWebp(8 * MB + 1), "image/webp"))).toContain("limit for an animated WebP");
});

test("a video in a message is kept by its hash, under its own limit, and its bytes never go inline", async () => {
  const { dir, sender } = await world();
  await writeFile(join(dir, "clip.mp4"), Buffer.concat([mp4Header(), Buffer.alloc(4096)]));
  await writeFile(join(dir, "loop.webm"), Buffer.concat([webmHeader(), Buffer.alloc(4096)]));
  await writeFile(join(dir, "large.webm"), webmHeader());
  await truncate(join(dir, "large.webm"), MAX_SENT_VIDEO_BYTES + 1);
  const text = "![[clip]] ![looping](loop.webm) ![[large.webm]]";
  const [clip, loop, large] = await sendPictures([text], sender);
  expect(clip).toMatchObject({ embed: "![[clip]]", name: "clip.mp4" });
  expect(clip?.path).toMatch(/\/sent\/[0-9a-f]{64}\.mp4$/);
  expect(loop).toMatchObject({ embed: "![looping](loop.webm)", name: "loop.webm", caption: "looping" });
  expect(loop?.path).toMatch(/\/sent\/[0-9a-f]{64}\.webm$/);
  expect(large?.path).toBe("");
  expect(large?.problem).toContain("limit for videos");
  expect(await pictureProblems([text], sender.workspace)).toEqual([`![[large.webm]]: ${large?.problem ?? ""}`]);
  expect(await readFile(clip?.path ?? "")).toEqual(await readFile(join(dir, "clip.mp4")));
  expect(imageDataForPath(clip?.path ?? "")).toBeUndefined();
  expect(firstSentPicture([clip ?? { path: "" }])).toBeUndefined();
});

test("a video's poster is what goes inline and what notifications show, so the player never ships its bytes", async () => {
  const { sent } = await world();
  const video = await keepSentVideo(sent, Buffer.concat([mp4Header(), Buffer.alloc(64)]), "video/mp4", async () => await noisePng(32, 24));
  const poster = displayCopyPath(video);
  expect(poster).toEndWith(".webp");
  expect(existsSync(poster)).toBe(true);
  expect(imageDataForPath(video)).toBe((await readFile(poster)).toString("base64"));
  expect(firstSentPicture([{ path: video, embed: "![[clip]]", name: "clip.mp4" }])).toEqual({ path: poster, name: "clip.webp" });
  expect(await keepSentVideo(sent, Buffer.concat([mp4Header(), Buffer.alloc(64)]), "video/mp4", () => { throw new Error("the poster is already there"); })).toBe(video);
  const unreadable = await keepSentVideo(sent, Buffer.concat([mp4Header(), Buffer.alloc(65)]), "video/mp4", async () => Buffer.from("not a picture"));
  expect(shownPicturePath(unreadable)).toBe(unreadable);
});

test("an animated PNG can go by the name its tools give it", async () => {
  const { dir, sender } = await world();
  await writeFile(join(dir, "loop.apng"), animatedPng(transparentPng(16, 16)));
  const [loop] = await sendPictures(["![[loop]]"], sender);
  expect(loop?.problem).toBeUndefined();
  expect(loop?.path).toEndWith(".png");
});

test("only MP4 and WebM go through as videos, whatever the file is called", async () => {
  const { dir, sender } = await world();
  await writeFile(join(dir, "quicktime.mp4"), Buffer.concat([mp4Header("qt  "), Buffer.alloc(64)]));
  await writeFile(join(dir, "still.mp4"), Buffer.concat([mp4Header("avif"), Buffer.alloc(64)]));
  await writeFile(join(dir, "matroska.webm"), Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from("matroska"), Buffer.alloc(64)]));
  await writeFile(join(dir, "clip.txt"), "not a video");
  const images = await sendPictures(["![[quicktime.mp4]] ![[still.mp4]] ![[matroska.webm]] ![[clip.txt]]"], sender);
  for (const image of images.slice(0, 3)) expect(image.problem).toContain("not a PNG, JPEG, GIF or WebP picture, or an MP4 or WebM video");
  expect(images[3]?.problem).toBe("clip.txt is not a picture or video");
});

test("reading a note shows pictures only: a video it embeds is reported, not read", async () => {
  const { dir } = await world();
  await writeFile(join(dir, "clip.mp4"), Buffer.concat([mp4Header(), Buffer.alloc(64)]));
  await writeFile(join(dir, "note.md"), "see ![[clip.mp4]]\n");
  const page = toolMediaOf(await handleRead({ file_path: "note.md" }, dir));
  expect(page?.media).toEqual([]);
  expect(JSON.stringify(page)).toContain("clip.mp4 is not a picture");
});

test("reading a video that can't be decoded says so instead of reading it as text", async () => {
  const { dir } = await world();
  await writeFile(join(dir, "clip.mp4"), Buffer.concat([mp4Header(), Buffer.alloc(64)]));
  expect(await refusal(handleRead({ file_path: "clip.mp4" }, dir))).toContain("its first frame could not be read");
});
