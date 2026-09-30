import { describe, expect, test } from "bun:test";
import { defaultImagesConfig, imageSettingsFor } from "../src/config/app.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
import { parseConfigTable } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import { renderStarterConfig } from "../src/config/starter.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { estimateMessageTokens } from "../src/engine/prompt.ts";
import { base64ImageDimensions } from "../src/llm/image_dimensions.ts";
import { DEFAULT_IMAGE_SETTINGS, MAX_SENT_IMAGE_BYTES, type ImageSettings } from "../src/llm/image_settings.ts";
import { HIGH_RESOLUTION_IMAGE_TIER, sentImageTokens, visualTokens } from "../src/llm/image_tokens.ts";
import { limitRequestImages, prepareImageBlock, reduceImage } from "../src/llm/prepare_images.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { base64Bytes } from "../src/util/base64.ts";
import { required } from "../src/util/required.ts";
import { oversizedImage, wideImage } from "./support/oversized_image.ts";
import { sizedImage } from "./support/sized_image.ts";
import { noisePng, ONE_PIXEL_GIF, rotatedJpeg, transparentPng } from "./support/test_images.ts";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

const png = (bytes: Buffer): ImageBlock["source"] => ({ type: "base64", media_type: "image/png", data: bytes.toString("base64") });
const settings = (overrides: Partial<ImageSettings>): ImageSettings => ({ ...DEFAULT_IMAGE_SETTINGS, ...overrides });
const load = (images: Record<string, unknown>) => parseConfigTable({ images }, resolveShoreDirs({}), () => {});

async function dimensionsOf(data: string): Promise<{ width: number; height: number }> {
  const { width, height } = await new Bun.Image(Buffer.from(data, "base64")).metadata();
  return { width, height };
}

describe("the [images] settings", () => {
  test("each source's section overrides [images] one field at a time", () => {
    const loaded = load({
      max_edge: 1500,
      format: "webp",
      read: { format: "jpeg", quality: 70, png_compression: 9, tell_model: false },
      upload: { max_edge: 1024, max_bytes: 500_000 },
      mcp: { png_palette: true, max_tokens: 800 },
    });
    expect(imageSettingsFor(loaded.app.images, "read")).toEqual(settings({ max_edge: 1500, format: "jpeg", quality: 70, png_compression: 9 }));
    expect(imageSettingsFor(loaded.app.images, "upload")).toEqual(settings({ max_edge: 1024, format: "webp", max_bytes: 500_000 }));
    expect(imageSettingsFor(loaded.app.images, "mcp")).toEqual(settings({ max_edge: 1500, format: "webp", png_palette: true, max_tokens: 800 }));
    expect(loaded.app.images.read).toMatchObject({ tell_model: false, allow_original: true });
  });

  test("the defaults reduce every source the way Shore always has", () => {
    expect(DEFAULT_IMAGE_SETTINGS).toEqual({
      max_tokens: 0, max_edge: 2000, format: "keep", quality: 85, png_compression: 6, png_palette: false, max_bytes: 750_000,
    });
    for (const origin of ["read", "upload", "mcp"] as const) {
      expect(imageSettingsFor(defaultImagesConfig(), origin)).toEqual(DEFAULT_IMAGE_SETTINGS);
    }
    expect(defaultImagesConfig().read).toMatchObject({ tell_model: true, allow_original: true });
  });

  test.each([
    [{ quality: 0 }, "images.quality is 0; it must be from 1 to 100"],
    [{ read: { max_edge: 9000 } }, "images.read.max_edge is 9000; it must be from 1 to 8000 pixels"],
    [{ upload: { png_compression: 10 } }, "images.upload.png_compression is 10; it must be a zlib level from 0 to 9"],
    [{ mcp: { max_bytes: 4_000_000 } }, "images.mcp.max_bytes is 4000000; it must be from 1 to 3750000"],
    [{ max_edge: 0 }, "images.max_edge is 0"],
    [{ format: "gif" }, "format must be keep, jpeg, webp, png"],
    [{ upload: { tell_model: false } }, "unknown field `images.upload.tell_model`"],
  ])("%j is refused: %s", (images, message) => {
    expect(() => load(images)).toThrow(message);
  });

  test("the ends of each range are accepted", () => {
    const loaded = load({
      quality: 1, max_edge: 8000, png_compression: 0, max_bytes: 3_750_000,
      read: { quality: 100, max_edge: 1, png_compression: 9, max_bytes: 1 },
    });
    expect(imageSettingsFor(loaded.app.images, "read")).toMatchObject({ quality: 100, max_edge: 1, png_compression: 9, max_bytes: 1 });
    expect(imageSettingsFor(loaded.app.images, "upload")).toMatchObject({ quality: 1, max_edge: 8000, png_compression: 0, max_bytes: 3_750_000 });
  });

  test("the schema says what each size setting costs in tokens", () => {
    const entries = new Map(configSchema({ instancesAt: () => [] }).map((entry) => [entry.key, entry]));
    expect(entries.get("images.max_edge")).toMatchObject({ units: "pixels", settable: true });
    expect(entries.get("images.max_edge")?.description).toContain("1,036 tokens at 1024, 1,610 at 1280, 2,352 at 1568 and 3,888 at 2000");
    expect(entries.get("images.max_tokens")).toMatchObject({ units: "tokens" });
    expect(entries.get("images.max_tokens")?.description).toContain("1,600 fits a 4:3 photo at about 1270×952 (1,564 tokens)");
    expect(entries.get("images.format")?.values).toEqual(["keep", "jpeg", "webp", "png"]);
    expect(entries.get("images.read.max_edge")?.description).toEndWith("Overrides images.max_edge for workspace images the model reads, including images in Markdown.");
    expect(entries.get("images.upload.max_bytes")?.description).toEndWith("Overrides images.max_bytes for images a user sends.");
    expect(entries.get("images.read.allow_original")?.description).toContain("original: true");
    expect(entries.has("images.upload.allow_original")).toBe(false);
  });

  test("the starter config gives the token cost of each size", () => {
    const starter = renderStarterConfig();
    expect(starter).toContain("1,036 tokens\n# at 1024×768, 2,352 at 1568×1176 and 3,888 at 2000×1500 (the default size)");
    expect(starter).toContain("# [images]\n# max_tokens = 1600  # a 4:3 photo arrives at about 1270×952 (1,564 tokens)");
    expect(visualTokens(1024, 768)).toBe(1036);
    expect(visualTokens(1568, 1176)).toBe(2352);
    expect(visualTokens(2000, 1500)).toBe(3888);
    expect(visualTokens(1270, 952)).toBe(1564);
  });
});

describe("reducing one image", () => {
  test("an image inside every limit is sent as it is", async () => {
    const source = png(await sizedImage(800, 600));
    const reduced = await reduceImage(source, DEFAULT_IMAGE_SETTINGS);
    expect(reduced.changed).toBe(false);
    expect(reduced.source).toEqual(source);
    expect(reduced.sent).toEqual({ mediaType: "image/png", dimensions: { width: 800, height: 600 } });
  });

  test("max_edge and max_tokens both apply, and the stricter wins", async () => {
    const source = png(await sizedImage(4000, 3000));
    const byBudget = await reduceImage(source, settings({ max_edge: 2000, max_tokens: 1600 }));
    expect(byBudget.sent.dimensions).toEqual({ width: 1270, height: 952 });
    expect(await dimensionsOf(byBudget.source.data)).toEqual({ width: 1270, height: 952 });
    expect(sentImageTokens(byBudget.sent.dimensions, HIGH_RESOLUTION_IMAGE_TIER)).toBe(1564);
    const byEdge = await reduceImage(source, settings({ max_edge: 1024, max_tokens: 1600 }));
    expect(byEdge.sent.dimensions).toEqual({ width: 1024, height: 768 });
    expect(byEdge.original).toEqual({ mediaType: "image/png", dimensions: { width: 4000, height: 3000 } });
  });

  test("a format converts every image, and leaves one already in it alone", async () => {
    const pngSource = png(await sizedImage(800, 600));
    const jpeg = await reduceImage(pngSource, settings({ format: "jpeg" }));
    expect(jpeg.source.media_type).toBe("image/jpeg");
    expect(Buffer.from(jpeg.source.data, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg.sent.dimensions).toEqual({ width: 800, height: 600 });
    const again = await reduceImage(jpeg.source, settings({ format: "jpeg" }));
    expect(again.changed).toBe(false);
    expect(again.source.data).toBe(jpeg.source.data);
    const webp = await reduceImage(jpeg.source, settings({ format: "webp" }));
    expect(webp.source.media_type).toBe("image/webp");
    const back = await reduceImage(webp.source, settings({ format: "png" }));
    expect(back.source.media_type).toBe("image/png");
  });

  test("jpeg keeps transparency by sending WebP", async () => {
    const reduced = await reduceImage(png(transparentPng(64, 32)), settings({ format: "jpeg" }));
    expect(reduced.source.media_type).toBe("image/webp");
    const opaque = await reduceImage(png(await sizedImage(64, 32)), settings({ format: "jpeg" }));
    expect(opaque.source.media_type).toBe("image/jpeg");
  });

  test("a transparent WebP stays WebP under jpeg, and an opaque one becomes JPEG", async () => {
    const transparent = transparentPng(64, 32);
    for (const encoded of [{ lossless: true }, { quality: 80 }]) {
      const webp = (await new Bun.Image(transparent).webp(encoded).toBase64());
      const reduced = await reduceImage({ type: "base64", media_type: "image/webp", data: webp }, settings({ format: "jpeg" }));
      expect(reduced.changed).toBe(false);
      expect(reduced.source.media_type).toBe("image/webp");
    }
    const opaque = await new Bun.Image(await sizedImage(64, 32)).webp({ quality: 80 }).toBase64();
    const converted = await reduceImage({ type: "base64", media_type: "image/webp", data: opaque }, settings({ format: "jpeg" }));
    expect(converted.source.media_type).toBe("image/jpeg");
  });

  test("transparency marked by a PNG's tRNS chunk is kept", async () => {
    const indexed = Buffer.from(await new Bun.Image(transparentPng(64, 32)).png({ palette: true }).bytes());
    expect(indexed[25]).toBe(3);
    expect(indexed.includes(Buffer.from("tRNS"))).toBe(true);
    const reduced = await reduceImage(png(indexed), settings({ format: "jpeg" }));
    expect(reduced.source.media_type).toBe("image/webp");
  });

  test("png_compression and png_palette change the bytes sent, not the size", async () => {
    const source = png(await noisePng(400, 300));
    const stored = await reduceImage(source, settings({ format: "png", max_edge: 200, png_compression: 0, max_bytes: MAX_SENT_IMAGE_BYTES }));
    const packed = await reduceImage(source, settings({ format: "png", max_edge: 200, png_compression: 9, max_bytes: MAX_SENT_IMAGE_BYTES }));
    expect(stored.sent.dimensions).toEqual({ width: 200, height: 150 });
    expect(packed.sent.dimensions).toEqual({ width: 200, height: 150 });
    expect(base64Bytes(stored.source.data)).toBeGreaterThan(base64Bytes(packed.source.data));
    const indexed = await reduceImage(source, settings({ format: "png", max_edge: 200, png_palette: true }));
    expect(Buffer.from(indexed.source.data, "base64")[25]).toBe(3);
    expect(Buffer.from(packed.source.data, "base64")[25]).not.toBe(3);
  });

  test("a PNG too large for max_bytes is made smaller", async () => {
    const source = png(await noisePng(400, 300));
    const reduced = await reduceImage(source, settings({ format: "png", max_bytes: 150_000 }));
    expect(reduced.source.media_type).toBe("image/png");
    expect(base64Bytes(reduced.source.data)).toBeLessThanOrEqual(150_000);
    expect(reduced.sent.dimensions?.width).toBeLessThanOrEqual(320);
    expect(await dimensionsOf(reduced.source.data)).toEqual(required(reduced.sent.dimensions));
  });

  test("an image prepared under two settings gets each one's result", async () => {
    const block: ImageBlock = { type: "image", source: png(await sizedImage(800, 600)) };
    const half = await prepareImageBlock(block, settings({ max_edge: 400 }));
    const quarter = await prepareImageBlock(block, settings({ max_edge: 200 }));
    if (half.type !== "image" || quarter.type !== "image") throw new Error("missing image");
    expect(await dimensionsOf(half.source.data)).toEqual({ width: 400, height: 300 });
    expect(await dimensionsOf(quarter.source.data)).toEqual({ width: 200, height: 150 });
  });

  test("max_bytes lowers quality before it lowers size", async () => {
    const photo = await noisePng(600, 450);
    const atQuality = async (quality: number) => base64Bytes(await new Bun.Image(photo).jpeg({ quality }).toBase64());
    const lowest = await atQuality(55);
    expect(await atQuality(85)).toBeGreaterThan(lowest);
    const byQuality = await reduceImage(png(photo), settings({ format: "jpeg", max_bytes: lowest }));
    expect(byQuality.sent.dimensions).toEqual({ width: 600, height: 450 });
    expect(base64Bytes(byQuality.source.data)).toBe(lowest);
    const bySize = await reduceImage(png(photo), settings({ format: "jpeg", max_bytes: lowest - 1 }));
    expect(bySize.sent.dimensions).toEqual({ width: 480, height: 360 });
    expect(base64Bytes(bySize.source.data)).toBeLessThan(lowest);
  });

  test("an image that cannot be made small enough says so", async () => {
    const photo = await noisePng(64, 64);
    expect(await reduceImage(png(photo), settings({ max_bytes: 1 })).then(() => undefined, (e: unknown) => String(e)))
      .toContain("Image could not be reduced below 1 bytes");
  });

  test("a GIF is sent as its first frame in PNG", async () => {
    const reduced = await reduceImage({ type: "base64", media_type: "image/gif", data: ONE_PIXEL_GIF }, DEFAULT_IMAGE_SETTINGS);
    expect(reduced.changed).toBe(true);
    expect(reduced.source.media_type).toBe("image/png");
    expect(reduced.original.mediaType).toBe("image/gif");
  });

  test("a photo turned by its EXIF orientation keeps its shape", async () => {
    const photo = rotatedJpeg(await sizedImage(400, 300, (image) => image.jpeg({ quality: 90 })));
    expect(base64ImageDimensions(photo.toString("base64"))).toEqual({ width: 400, height: 300 });
    const reduced = await reduceImage({ type: "base64", media_type: "image/jpeg", data: photo.toString("base64") }, settings({ max_edge: 200 }));
    expect(reduced.original.dimensions).toEqual({ width: 300, height: 400 });
    expect(reduced.sent.dimensions).toEqual({ width: 150, height: 200 });
    expect(await dimensionsOf(reduced.source.data)).toEqual({ width: 150, height: 200 });
  });

  test("the defaults give the same bytes Shore sent before reduction was configurable", async () => {
    const previous = async (data: string): Promise<ImageBlock["source"]> => {
      const bytes = Buffer.from(data, "base64");
      const { width, height } = await new Bun.Image(bytes).metadata();
      const pipeline = (edge: number) => new Bun.Image(bytes).resize(edge, edge, { fit: "inside", withoutEnlargement: true });
      const size = Math.min(2000, Math.max(width, height));
      const lossless = await pipeline(size).png().toBase64();
      if (lossless.length <= 1_000_000) return { type: "base64", media_type: "image/png", data: lossless };
      for (let edge = size; edge >= 1; edge = Math.floor(edge * 0.8)) {
        const lossy = await pipeline(edge).webp({ quality: 85 }).toBase64();
        if (lossy.length <= 1_000_000) return { type: "base64", media_type: "image/webp", data: lossy };
      }
      throw new Error("unreachable");
    };
    const images = [(await oversizedImage()).source, (await wideImage()).source, png(await noisePng(1000, 800)), png(await noisePng(3001, 1999, 7))];
    for (const source of images) {
      const prepared = await prepareImageBlock({ type: "image", source });
      if (prepared.type !== "image") throw new Error("missing image");
      expect(prepared.source).toEqual(await previous(source.data));
    }
  }, 60_000);
});

describe("what a request may carry", () => {
  const request = (sdk: SidecarRequest["sdk"], images: ImageBlock[]): SidecarRequest => ({
    sdk, model: "claude-opus-5-5", api_key: "test", max_tokens: 64, replay_prior_thinking: "all",
    messages: [{ role: "user", content: [...images, { type: "text", text: "look" }] }],
  });
  const sentImages = (sent: SidecarRequest): ImageBlock[] =>
    sent.messages.flatMap((message) => message.content).filter((block): block is ImageBlock => block.type === "image");

  test("an image above 2000 pixels goes as it is until a request carries more than 20 images", async () => {
    const large: ImageBlock = { type: "image", source: png(await sizedImage(2576, 1449)) };
    const small: ImageBlock = { type: "image", source: png(await sizedImage(40, 30)) };
    const twenty = sentImages(await limitRequestImages(request("anthropic", [large, ...Array.from({ length: 19 }, () => small)])));
    expect(twenty[0]).toBe(large);
    const many = sentImages(await limitRequestImages(request("anthropic", [large, ...Array.from({ length: 20 }, () => small)])));
    expect(await dimensionsOf(required(many[0]).source.data)).toEqual({ width: 2000, height: 1125 });
    expect(many[1]).toBe(small);
  });

  test("the Claude Agent SDK gets every image within 2000 pixels, however many there are", async () => {
    const large: ImageBlock = { type: "image", source: png(await sizedImage(2576, 1449)) };
    const [sent] = sentImages(await limitRequestImages(request("claude_agent", [large])));
    expect(await dimensionsOf(required(sent).source.data)).toEqual({ width: 2000, height: 1125 });
  });

  test("a GIF is sent as a PNG", async () => {
    const gif: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/gif", data: ONE_PIXEL_GIF } };
    const [sent] = sentImages(await limitRequestImages(request("anthropic", [gif])));
    expect(required(sent).source.media_type).toBe("image/png");
  });

  test("an image over the per-image size ceiling is brought under it", async () => {
    const huge: ImageBlock = { type: "image", source: png(await noisePng(1800, 1200, 3)) };
    expect(base64Bytes(huge.source.data)).toBeGreaterThan(MAX_SENT_IMAGE_BYTES);
    const [sent] = sentImages(await limitRequestImages(request("anthropic", [huge])));
    expect(base64Bytes(required(sent).source.data)).toBeLessThanOrEqual(MAX_SENT_IMAGE_BYTES);
  });
});

describe("what an image costs the context", () => {
  test("an image in a tool result counts at the size it was sent, above 2000 pixels too", async () => {
    const image: ImageBlock = { type: "image", source: png(await sizedImage(2212, 1659)) };
    const message: Message = {
      msg_id: "m", role: "user", content: "", images: [], timestamp: "2026-09-30T00:00:00Z",
      content_blocks: [{ type: "tool_result", tool_use_id: "t", content: [image] }],
    };
    expect(estimateMessageTokens(message, HIGH_RESOLUTION_IMAGE_TIER)).toBe(4740);
  });
});
