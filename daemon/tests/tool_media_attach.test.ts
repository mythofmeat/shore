import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ContentBlock } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { Texts } from "../src/texts/texts.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { carryToolMedia, type ToolMediaItem } from "../src/tools/media.ts";
import { transparentPng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

const PNG = transparentPng(1, 1).toString("base64");

const picture = (label: string, extra: Partial<ToolMediaItem> = {}): ToolMediaItem => ({ mime_type: "image/png", data: PNG, label, ...extra });

async function world(media: ToolMediaItem[], options: { cache?: boolean; maxBytes?: number; rid?: string; value?: string } = {}) {
  const root = testTmp(`tool-media-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const frames: ServerMessage[] = [];
  const ctx: ToolContext = {
    texts: new Texts(), characterName: "ada", workspaceDir: join(root, "workspace"), characterDataDir: root, conversationDir: root,
    historyDbPath: join(root, "h.db"), configDir: root, ...(options.cache === true ? { cacheDir: join(root, "cache") } : {}),
    mcpCall: () => Promise.resolve(carryToolMedia({ value: options.value ?? "looked", media, extra: [] })),
  };
  const exec: ToolExecution = {
    ctx, sendDirect: (frame) => frames.push(frame),
    limits: { timeout_ms: 0, max_result_chars: 0, ...(options.maxBytes === undefined ? {} : { max_inline_image_bytes: options.maxBytes }) },
    now: () => "2026-11-24T00:00:00Z", newMessageId: () => "m_1",
    ...(options.rid === undefined ? {} : { rid: options.rid }),
  };
  const run = await runToolUse({ id: "t1", name: "mcp__camera__look", input: {} }, exec);
  const content = (run.block as Extract<ContentBlock, { type: "tool_result" }>).content;
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const shape = blocks.map((block) => block.type === "text" ? block.text : block.type);
  return { run, frames, shape, images: frames.flatMap((frame) => frame.type === "tool_result" ? frame.images ?? [] : []) };
}

async function preparedBytes(): Promise<number> {
  const { images } = await world([picture("probe")]);
  return Buffer.from(images[0]?.data ?? "", "base64").byteLength;
}

test("a picture with nowhere to keep a copy is still sent, and says its copy couldn't be saved", async () => {
  const { run, frames, shape, images } = await world([picture("the lamp")], { rid: "r1" });
  expect(shape).toEqual(["looked\n[the lamp: a separate media copy could not be saved]\n[the lamp attached]", "image"]);
  expect(frames.filter((frame) => frame.type === "send_image")).toEqual([]);
  expect(images.map((image) => image.path)).toEqual(["tool-image:t1:0"]);
  expect(frames.find((frame) => frame.type === "tool_result")).toMatchObject({ type: "tool_result", rid: "r1", is_error: false });
  expect(run.pictures).toEqual([]);
});

test("a picture kept in the cache is sent to the user's screen, and its result says where its file is", async () => {
  const { run, frames, shape } = await world([picture("the lamp")], { cache: true, rid: "r1" });
  const sent = frames.find((frame) => frame.type === "send_image");
  expect(sent).toMatchObject({ type: "send_image", rid: "r1", caption: "the lamp", data: PNG });
  const path = (sent as { path: string }).path;
  expect(shape).toEqual([`looked\n[the lamp attached; its file is ${path}]`, "image"]);
  expect(run.pictures.map(({ path: kept, caption, sha256 }) => [kept, caption, /^[0-9a-f]{64}$/.test(sha256 ?? "")])).toEqual([[path, "the lamp", true]]);
  expect((await world([picture("the lamp")], { cache: true })).frames.find((frame) => frame.type === "send_image")).not.toHaveProperty("rid");
});

test("at most twenty pictures go to the model in one result, and the rest are named", async () => {
  const many = Array.from({ length: 21 }, (_, n) => picture(`shot ${String(n + 1)}`));
  const { shape, images } = await world(many, { cache: true });
  expect(shape.filter((part) => part === "image")).toHaveLength(20);
  expect(shape[0]).toStartWith("looked\n[shot 21 not sent to the model: at most 20 images and 5242880 bytes of prepared image data are sent per tool result]\n[shot 1 attached");
  expect(images).toHaveLength(21);
});

test("pictures go to the model until their prepared bytes reach the limit, the limit itself included, and the rest are named", async () => {
  const bytes = await preparedBytes();
  const exact = await world([picture("one"), picture("two")], { maxBytes: bytes * 2, cache: true });
  expect(exact.shape.filter((part) => part === "image")).toHaveLength(2);
  const over = await world([picture("one"), picture("two"), picture("three")], { maxBytes: bytes * 2 - 1, cache: true });
  expect(over.shape.filter((part) => part === "image")).toHaveLength(1);
  expect(over.shape[0]).toStartWith(`looked\n[two, three not sent to the model: at most 20 images and ${String(bytes * 2 - 1)} bytes of prepared image data are sent per tool result]\n[one attached`);
  const full = await world([picture("one"), picture("odd", { mime_type: "image/x-unknown" })], { maxBytes: bytes, cache: true });
  expect(full.run.isError).toBe(false);
  expect(full.shape[0]).toStartWith(`looked\n[odd not sent to the model: at most 20 images and ${String(bytes)} bytes of prepared image data are sent per tool result]\n[one attached`);
});

test("pictures switched off for a tool are all named as not sent, and say so", async () => {
  const { shape } = await world([picture("one"), picture("two")], { maxBytes: 0, cache: true });
  expect(shape).toEqual(["looked\n[one, two not sent to the model: inline images are disabled for this tool]"]);
});

test("a picture that can't be prepared makes the result an error and says why, and one placed in the text goes where it was", async () => {
  const broken = await world([picture("a drawing", { mime_type: "image/x-unknown" })], { cache: true });
  expect(broken.run.isError).toBe(true);
  expect(broken.shape).toEqual(["looked\n[a drawing not sent to the model: image/x-unknown is not a supported format]"]);
  const placed = await world([picture("the map", { at: 4 })], { value: "see:\nthe map above", cache: true });
  expect(placed.shape.slice(1)).toEqual(["image", "\nthe map above"]);
  expect(placed.shape[0]).toStartWith("see:\n[the map attached; its file is ");
});
