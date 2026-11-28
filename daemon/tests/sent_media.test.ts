import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { imageDataForPath } from "../src/engine/wire_images.ts";
import { firstSentPicture, pictureProblems, sendPictures } from "../src/handler/pictures.ts";
import { displayCopyPath, keepSentPicture, keepSentVideo, MAX_SENT_VIDEO_BYTES, shownPicturePath } from "../src/storage/sent_pictures.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { handleRead } from "../src/tools/read.ts";
import * as workspaceNames from "../src/tools/workspace_names.ts";
import { animatedPng, noisePng, transparentPng, withTextChunk } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";
import { Texts } from "../src/texts/texts.ts";

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

test("a picture is sent from wherever it can be read: by its full path, by a path that leaves the workspace, or through a link in it", async () => {
  const { dir, sender } = await world();
  const elsewhere = join(dirname(dir), "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "harbor.png"), transparentPng(8, 8));
  await symlink(join(elsewhere, "harbor.png"), join(dir, "linked.png"));
  const text = `![](${join(elsewhere, "harbor.png")}) ![](../elsewhere/harbor.png) ![](linked.png)`;
  const images = await sendPictures([text], sender);
  expect(images.map(({ name, problem }) => ({ name, problem }))).toEqual([
    { name: "harbor.png", problem: undefined },
    { name: "harbor.png", problem: undefined },
    { name: "linked.png", problem: undefined },
  ]);
  for (const image of images) expect(await readFile(image.path)).toEqual(await readFile(join(elsewhere, "harbor.png")));
  expect(await pictureProblems([text], sender.workspace)).toEqual([]);
});

test("a reply stopped while its pictures are looked up keeps none of them, whether it was stopped before or during the search", async () => {
  const { dir, sent, sender } = await world();
  await writeFile(join(dir, "harbor.png"), transparentPng(4, 4));
  expect(await refusal(sendPictures(["![](harbor.png)"], sender, AbortSignal.abort()))).toContain("AbortError");
  const stop = new AbortController();
  const search = spyOn(workspaceNames, "workspaceNames").mockImplementation(async () => {
    stop.abort();
    throw stop.signal.reason;
  });
  try {
    expect(await refusal(sendPictures(["![[harbor]]"], sender, stop.signal))).toContain("AbortError");
  } finally {
    search.mockRestore();
  }
  expect(await readdir(sent)).toEqual([]);
});

test("pictures the workspace can't be searched for, or one found but not read, are kept back with why", async () => {
  const { dir, sender } = await world();
  await writeFile(join(dir, "harbor.png"), transparentPng(4, 4));
  const call = sender.workspace.call.bind(sender.workspace);
  const helper = spyOn(sender.workspace, "call").mockRejectedValueOnce(new Error("the helper is gone"));
  try {
    expect((await sendPictures(["![[harbor]] ![[tide]]"], sender)).map(({ embed, problem }) => ({ embed, problem }))).toEqual([
      { embed: "![[harbor]]", problem: "the workspace could not be searched: the helper is gone" },
      { embed: "![[tide]]", problem: "the workspace could not be searched: the helper is gone" },
    ]);
    helper.mockImplementation((async (op: string, args: never, signal?: AbortSignal) => op === "readFiles" ? [{ error: { message: "the disk is gone" } }] : await call(op as never, args, signal)) as never);
    expect((await sendPictures(["![[harbor]]"], sender)).map(({ problem }) => problem)).toEqual(["it could not be sent: the disk is gone"]);
  } finally {
    helper.mockRestore();
  }
});

test("only the first ten pictures in a message are sent, the rest saying so, and a link that names no file is left alone", async () => {
  const { dir, sender } = await world();
  for (let n = 1; n <= 11; n += 1) await writeFile(join(dir, `p${String(n)}.png`), transparentPng(2, 2));
  const text = Array.from({ length: 11 }, (_, n) => `![[p${String(n + 1)}]]`).join(" ");
  expect(await pictureProblems([text], sender.workspace)).toEqual(["![[p11]]: only the first 10 pictures in a message are sent"]);
  const images = await sendPictures([text], sender);
  expect(images.map(({ problem }) => problem)).toEqual([...Array.from({ length: 10 }, () => undefined), "only the first 10 pictures in a message are sent"]);
  expect(await sendPictures(["see ![[#top]]"], sender)).toEqual([]);
  expect(await pictureProblems(["see ![[#top]]"], sender.workspace)).toEqual([]);
});

test("a message with no pictures in it doesn't look in the workspace at all", async () => {
  const { sender } = await world();
  const helper = spyOn(sender.workspace, "call");
  try {
    expect(await sendPictures(["just words"], sender)).toEqual([]);
    expect(await pictureProblems(["just words"], sender.workspace)).toEqual([]);
    expect(helper).not.toHaveBeenCalled();
  } finally {
    helper.mockRestore();
  }
});

test("a picture whose file turns out not to be one, or can't be read and says no more, is kept back with why, and a stop while it is kept is passed on", async () => {
  const { dir, sender } = await world();
  await writeFile(join(dir, "harbor.png"), transparentPng(4, 4));
  const call = sender.workspace.call.bind(sender.workspace);
  const read = (answer: unknown, before?: () => void) => spyOn(sender.workspace, "call").mockImplementation((async (op: string, args: never, signal?: AbortSignal) => {
    if (op !== "readFiles") return await call(op as never, args, signal);
    before?.();
    return answer;
  }) as never);
  const notPicture = read([{ data: Buffer.from("plain text here").toString("base64") }]);
  try {
    expect((await sendPictures(["![[harbor]]"], sender)).map(({ problem }) => problem)).toEqual(["it could not be sent: it is not a PNG, JPEG, GIF or WebP picture, or an MP4 or WebM video"]);
  } finally {
    notPicture.mockRestore();
  }
  const silent = read([{ error: {} }]);
  try {
    expect((await sendPictures(["![[harbor]]"], sender)).map(({ problem }) => problem)).toEqual(["it could not be sent: it could not be read"]);
  } finally {
    silent.mockRestore();
  }
  const stop = new AbortController();
  const stopped = read([{ error: { message: "interrupted" } }], () => { stop.abort(new Error("the reply was stopped")); });
  try {
    expect(await refusal(sendPictures(["![[harbor]]"], sender, stop.signal))).toBe("Error: the reply was stopped");
  } finally {
    stopped.mockRestore();
  }
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
  const page = toolMediaOf(await handleRead({ file_path: "note.md" }, dir, new Texts()));
  expect(page?.media).toEqual([]);
  expect(JSON.stringify(page)).toContain("clip.mp4 is not a picture");
});

test("reading a video that can't be decoded says so instead of reading it as text", async () => {
  const { dir } = await world();
  await writeFile(join(dir, "clip.mp4"), Buffer.concat([mp4Header(), Buffer.alloc(64)]));
  expect(await refusal(handleRead({ file_path: "clip.mp4" }, dir, new Texts()))).toContain("its first frame could not be read");
});
