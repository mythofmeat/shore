import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../src/engine/picture_files.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { stripImageBlocks, textOnlyReason } from "../src/llm/image_support.ts";
import { findModelCopy, resolveImage, resolveImageBlock } from "../src/llm/images.ts";
import type { WireMessage } from "../src/llm/types.ts";
import * as imageCache from "../src/storage/image_cache.ts";
import { Texts } from "../src/texts/texts.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const GIF = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const GIF_BYTES = Buffer.from(GIF, "base64");

describe("deciding whether a picture can be sent", () => {
  test("a block is sent at exactly its limit and left out one byte past it", () => {
    expect(resolveImageBlock({ media_type: "image/gif", data: GIF }, GIF_BYTES.length)).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImageBlock({ media_type: "image/gif", data: GIF }, GIF_BYTES.length - 1)).toEqual({ omitted: { reason: "image_too_big", values: { bytes: String(GIF_BYTES.length), limit: String(GIF_BYTES.length - 1) } } });
  });

  test("a picture carried inline is sent from what it carries, unless it is over the limit, and one carrying nothing is read from its file", async () => {
    const dir = await mkdtemp(testTmp("resolve-image-"));
    const path = join(dir, "dot.gif");
    await writeFile(path, GIF_BYTES);
    expect(resolveImage({ path: join(dir, "elsewhere.gif"), data: GIF })).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImage({ path: join(dir, "elsewhere.gif"), data: GIF }, GIF_BYTES.length - 1)).toEqual({ omitted: { reason: "image_too_big", values: { bytes: String(GIF_BYTES.length), limit: String(GIF_BYTES.length - 1) } } });
    expect(resolveImage({ path, data: "" })).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImage({ path: join(dir, "elsewhere.gif"), data: GIF }, GIF_BYTES.length)).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImage({ path: join(dir, "elsewhere.gif"), data: "R" })).toEqual({ image: { mediaType: "image/gif", base64: "R" } });
  });

  test("a file is sent at exactly its limit, left out past it, and left out when it can't be read", async () => {
    const dir = await mkdtemp(testTmp("resolve-image-"));
    const path = join(dir, "dot.gif");
    await writeFile(path, GIF_BYTES);
    expect(resolveImage({ path }, GIF_BYTES.length)).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImage({ path }, GIF_BYTES.length - 1)).toEqual({ omitted: { reason: "image_too_big", values: { bytes: String(GIF_BYTES.length), limit: String(GIF_BYTES.length - 1) } } });
    await mkdir(join(dir, "folder.gif"));
    expect(resolveImage({ path: join(dir, "folder.gif") })).toMatchObject({ omitted: { reason: "image_unreadable" } });
    const gone = resolveImage({ path: join(dir, "gone.gif") });
    expect(gone).toMatchObject({ omitted: { reason: "image_unreadable" } });
    expect(String("omitted" in gone ? gone.omitted.values?.["error"] : "")).toContain("ENOENT");
  });

  test("a file whose contents no longer match the hash it was shown with is left out, unless the file is named by that hash or no hash was kept", async () => {
    const dir = await mkdtemp(testTmp("resolve-image-"));
    const path = join(dir, "dot.gif");
    await writeFile(path, GIF_BYTES);
    const right = sha256Hex(GIF_BYTES);
    const wrong = "0".repeat(64);
    expect(resolveImage({ path, sha256: right })).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    expect(resolveImage({ path, sha256: wrong })).toEqual({ omitted: { reason: "image_changed" } });
    expect(resolveImage({ path })).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
    const named = join(dir, `${wrong}.gif`);
    await writeFile(named, GIF_BYTES);
    expect(resolveImage({ path: named, sha256: wrong })).toEqual({ image: { mediaType: "image/gif", base64: GIF } });
  });
});

describe("leaving pictures out of a request", () => {
  const texts = new Texts();
  const image = (): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/gif", data: GIF } });

  test("only the pictures counted out are replaced, text beside them in a tool's result stays, and a tool result is an error only when it lost a picture or already was one", () => {
    const messages: WireMessage[] = [{ role: "user", content: [
      image(),
      { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "kept words" }, image()] },
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "no pictures" }], is_error: true },
      { type: "tool_result", tool_use_id: "c", content: "plain" },
      { type: "tool_result", tool_use_id: "d", content: [{ type: "text", text: "fine" }] },
      image(),
    ] }];
    const out = stripImageBlocks(texts, messages, textOnlyReason("p", "m"), 2).messages[0]?.content ?? [];
    expect(out.map((block) => block.type)).toEqual(["text", "tool_result", "tool_result", "tool_result", "tool_result", "image"]);
    expect(out[1]).toEqual({ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "kept words" }, { type: "text", text: "[image omitted: a tool result image — p/m does not accept images]" }] });
    expect(out[2]).toMatchObject({ tool_use_id: "b", is_error: true });
    expect(out[3]).toEqual({ type: "tool_result", tool_use_id: "c", content: "plain" });
    expect(out[4]).toMatchObject({ tool_use_id: "d", is_error: false });
  });
});

describe("taking in pictures a client sends", () => {
  async function cache(): Promise<string> {
    return await mkdtemp(testTmp("ingest-cache-"));
  }

  test("a new picture is kept with a copy for the model, and what that adds to the cache is counted once; sending it again adds nothing", async () => {
    const dir = await cache();
    const png = (await sizedImage(4, 4)).toString("base64");
    const counted = spyOn(imageCache, "noteCachedImages");
    try {
      const first = await ingestImages(new Texts(), dir, "ada", ["lamp.png"], [{ filename: "lamp.png", data: png }]);
      expect(first.blocks).toEqual([]);
      expect(first.images).toHaveLength(1);
      const copy = findModelCopy(first.images[0]?.path ?? "");
      expect(copy).toBeDefined();
      const copyBytes = Bun.file(copy?.path ?? "").size;
      expect(counted.mock.calls.map(([, bytes]) => bytes)).toEqual([Buffer.from(png, "base64").length + copyBytes]);
      await ingestImages(new Texts(), dir, "ada", ["lamp.png"], [{ filename: "lamp.png", data: png }]);
      expect(counted.mock.calls).toHaveLength(1);
    } finally {
      counted.mockRestore();
    }
  });

  test("a new file that isn't a picture models take is noted, counted in the cache and not sent", async () => {
    const dir = await cache();
    const counted = spyOn(imageCache, "noteCachedImages");
    try {
      const data = Buffer.from("just words").toString("base64");
      const taken = await ingestImages(new Texts(), dir, "ada", [], [{ filename: "notes.txt", data }]);
      expect(taken.images).toEqual([]);
      expect(taken.blocks).toEqual([{ type: "text", text: "[image omitted: notes.txt — no extension is not a supported format]" }]);
      expect(counted.mock.calls.map(([, bytes]) => bytes)).toEqual([Buffer.from(data, "base64").length]);
      await ingestImages(new Texts(), dir, "ada", [], [{ filename: "notes.txt", data }]);
      expect(counted.mock.calls).toHaveLength(1);
    } finally {
      counted.mockRestore();
    }
  });

  test("each picture the client names is matched to the next one it sent, so only the ones it didn't send are noted", async () => {
    const dir = await cache();
    const png = (await sizedImage(2, 2)).toString("base64");
    const taken = await ingestImages(new Texts(), dir, "ada", ["a.png", "b.png", "c.png"], [{ filename: "a.png", data: png }, { filename: "b.png", data: png }]);
    expect(taken.images).toHaveLength(2);
    expect(taken.blocks).toEqual([{ type: "text", text: "[image omitted: c.png — the client could not upload it]" }]);
  });
});
