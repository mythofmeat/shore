import { describe, expect, test } from "bun:test";
import { DEFAULT_IMAGE_SETTINGS, type ImageSettings } from "../src/llm/image_settings.ts";
import { limitImageBlock, reduceImage } from "../src/llm/prepare_images.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { base64Bytes } from "../src/util/base64.ts";
import { sizedImage } from "./support/sized_image.ts";
import { noisePng, noisyTransparentPng, ONE_PIXEL_GIF, transparentPng } from "./support/test_images.ts";

const source = (media_type: string, data: Buffer | string) => ({ type: "base64" as const, media_type, data: typeof data === "string" ? data : data.toString("base64") });
const settings = (over: Partial<ImageSettings>): ImageSettings => ({ ...DEFAULT_IMAGE_SETTINGS, ...over });
const encoded = async (bytes: Buffer, as: "jpeg" | "webp", quality: number, size?: { width: number; height: number }): Promise<string> => {
  const image = size === undefined ? new Bun.Image(bytes) : new Bun.Image(bytes).resize(size.width, size.height, { fit: "fill" });
  return await (as === "jpeg" ? image.jpeg({ quality }) : image.webp({ quality })).toBase64();
};

describe("reducing a picture", () => {
  test("a GIF goes as a PNG even when nothing else changes, and a PNG that fits as it is goes untouched", async () => {
    const gif = await reduceImage(source("image/gif", ONE_PIXEL_GIF), DEFAULT_IMAGE_SETTINGS);
    expect(gif).toMatchObject({ changed: true, original: { mediaType: "image/gif" }, sent: { mediaType: "image/png" }, source: { media_type: "image/png" } });
    expect(Buffer.from(gif.source.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const png = await sizedImage(40, 30);
    expect(await reduceImage(source("image/png", png), DEFAULT_IMAGE_SETTINGS)).toMatchObject({ changed: false, source: source("image/png", png) });
  });

  test("a JPEG asked for as JPEG stays as it is, a PNG asked for as JPEG becomes one, and one past the edge is resized", async () => {
    const jpeg = await sizedImage(40, 30, (image) => image.jpeg());
    expect(await reduceImage(source("image/jpeg", jpeg), settings({ format: "jpeg" }))).toMatchObject({ changed: false });
    expect(await reduceImage(source("image/png", await sizedImage(40, 30)), settings({ format: "jpeg" }))).toMatchObject({ changed: true, source: { media_type: "image/jpeg" } });
    expect(await reduceImage(source("image/png", await sizedImage(300, 100)), settings({ max_edge: 150 }))).toMatchObject({ changed: true, sent: { dimensions: { width: 150, height: 50 } } });
  });

  test("a PNG kept in its format but too big at its size is tried as WebP at that same size first", async () => {
    const noisy = await noisePng(200, 200);
    const webp = await encoded(noisy, "webp", 85);
    const reduced = await reduceImage(source("image/png", noisy), settings({ max_bytes: base64Bytes(webp) + 100 }));
    expect(reduced).toMatchObject({ source: { media_type: "image/webp" }, sent: { dimensions: { width: 200, height: 200 } } });
  });

  test("a picture with transparency asked for as JPEG goes as WebP, keeping its see-through part", async () => {
    expect(await reduceImage(source("image/png", transparentPng(40, 30)), settings({ format: "jpeg" }))).toMatchObject({ source: { media_type: "image/webp" } });
  });

  test("lossy quality steps down by ten, down to the floor, before the size comes down at the last quality", async () => {
    const noisy = await noisePng(100, 100);
    const at60 = await encoded(noisy, "jpeg", 60);
    const at50 = await encoded(noisy, "jpeg", 50);
    const stepped = await reduceImage(source("image/png", noisy), settings({ format: "jpeg", quality: 60, max_bytes: Math.floor((base64Bytes(at60) + base64Bytes(at50)) / 2) }));
    expect(stepped).toMatchObject({ source: { media_type: "image/jpeg", data: at50 }, sent: { dimensions: { width: 100, height: 100 } } });
    const smaller = await encoded(noisy, "jpeg", 50, { width: 80, height: 80 });
    const shrunk = await reduceImage(source("image/png", noisy), settings({ format: "jpeg", quality: 60, max_bytes: base64Bytes(smaller) }));
    expect(shrunk).toMatchObject({ source: { media_type: "image/jpeg", data: smaller }, sent: { dimensions: { width: 80, height: 80 } } });
  });

  test("a see-through picture's WebP steps down in quality like any other before it shrinks", async () => {
    const noisy = noisyTransparentPng(100, 100);
    const at85 = await encoded(noisy, "webp", 85);
    const at75 = await encoded(noisy, "webp", 75);
    const stepped = await reduceImage(source("image/png", noisy), settings({ format: "jpeg", max_bytes: Math.floor((base64Bytes(at85) + base64Bytes(at75)) / 2) }));
    expect(stepped).toMatchObject({ source: { media_type: "image/webp", data: at75 }, sent: { dimensions: { width: 100, height: 100 } } });
  });

  test("a tool result's pictures are limited too", async () => {
    const block: ContentBlock = { type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: source("image/gif", ONE_PIXEL_GIF) }] };
    expect(await limitImageBlock(block)).toMatchObject({ type: "tool_result", content: [{ type: "image", source: { media_type: "image/png" } }] });
  });
});
