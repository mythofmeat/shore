import { describe, expect, test } from "bun:test";
import { type ContentBlock } from "../src/engine/types.ts";
import { DEFAULT_IMAGE_SETTINGS, MAX_SENT_IMAGE_BYTES, type ImageSettings } from "../src/llm/image_settings.ts";
import { limitRequestImages, reduceImage } from "../src/llm/prepare_images.ts";
import { type SidecarRequest } from "../src/llm/types.ts";
import { base64Bytes } from "../src/util/base64.ts";
import { required } from "../src/util/required.ts";
import { noisePng } from "./support/test_images.ts";
import { capRequestImages, countImageBlocks, MAX_REQUEST_IMAGES, REQUEST_IMAGE_DROP_STEP } from "../src/llm/image_support";
import { type WireMessage } from "../src/llm/types";
import { HIGH_RESOLUTION_IMAGE_TIER, STANDARD_IMAGE_TIER, fitLongEdge, imageTokens, sizeForTier, visualTokens } from "../src/llm/image_tokens.ts";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

const png = (bytes: Buffer): ImageBlock["source"] => ({ type: "base64", media_type: "image/png", data: bytes.toString("base64") });
const settings = (overrides: Partial<ImageSettings>): ImageSettings => ({ ...DEFAULT_IMAGE_SETTINGS, ...overrides });

describe("reducing one image", () => {

  test("an image that cannot be made small enough says so", async () => {
    const photo = await noisePng(64, 64);
    expect(await reduceImage(png(photo), settings({ max_bytes: 1 })).then(() => undefined, (e: unknown) => String(e)))
      .toContain("Image could not be reduced below 1 bytes");
  });
});

describe("what a request may carry", () => {
  const request = (sdk: SidecarRequest["sdk"], images: ImageBlock[]): SidecarRequest => ({
    sdk, model: "claude-opus-5-5", api_key: "test", max_tokens: 64, replay_prior_thinking: "all",
    messages: [{ role: "user", content: [...images, { type: "text", text: "look" }] }],
  });
  const sentImages = (sent: SidecarRequest): ImageBlock[] =>
    sent.messages.flatMap((message) => message.content).filter((block): block is ImageBlock => block.type === "image");

  test("an image over the per-image size ceiling is brought under it", async () => {
    const huge: ImageBlock = { type: "image", source: png(await noisePng(1800, 1200, 3)) };
    expect(base64Bytes(huge.source.data)).toBeGreaterThan(MAX_SENT_IMAGE_BYTES);
    const [sent] = sentImages(await limitRequestImages(request("anthropic", [huge])));
    expect(base64Bytes(required(sent).source.data)).toBeLessThanOrEqual(MAX_SENT_IMAGE_BYTES);
  });
});

function imageMessage(data = "AAAA"): WireMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
      { type: "text", text: "what is this" },
    ],
  };
}

describe("capping images per request", () => {
  test("images up to the character limit all go, the same messages as before", () => {
    const history = [imageMessage("A".repeat(12_000_000)), imageMessage("A".repeat(8_000_000))];
    const capped = capRequestImages(history);
    expect(capped.stripped).toBe(0);
    expect(capped.messages).toHaveLength(2);
    capped.messages.forEach((message, i) => { expect(message).toBe(history[i] as WireMessage); });
  });

  test("past the character limit the oldest images go until ten million characters have gone", () => {
    const history = [imageMessage("A".repeat(9_999_999)), imageMessage("A"), imageMessage("A".repeat(10_000_001))];
    const capped = capRequestImages(history);
    expect(capped.stripped).toBe(2);
    expect(countImageBlocks(capped.messages)).toBe(1);
    expect(capped.messages[2]).toBe(history[2] as WireMessage);
  });

  test("the dropped prefix stays identical as history grows within a step, keeping the prompt cache valid", () => {
    const base = Array.from({ length: MAX_REQUEST_IMAGES + 1 }, () => imageMessage());
    const first = capRequestImages(base);
    const grown = capRequestImages([...base, ...Array.from({ length: REQUEST_IMAGE_DROP_STEP - 1 }, () => imageMessage())]);

    expect(grown.stripped).toBe(first.stripped);
    expect(grown.messages.slice(0, base.length)).toEqual(first.messages);
    const next = capRequestImages([...base, ...Array.from({ length: REQUEST_IMAGE_DROP_STEP }, () => imageMessage())]);
    expect(next.stripped).toBe(2 * REQUEST_IMAGE_DROP_STEP);
    expect(countImageBlocks(next.messages)).toBeLessThanOrEqual(MAX_REQUEST_IMAGES);
  });
});

const size = (width: number, height: number) => ({ width, height });

describe("Anthropic's resize rule, and the costs its vision guide lists", () => {
  test("one token per 28-pixel patch, rounding up", () => {
    expect(visualTokens(200, 200)).toBe(64);
    expect(visualTokens(1000, 1000)).toBe(1296);
    expect(visualTokens(1092, 1092)).toBe(1521);
  });

  test("a tall image is resized along its long edge", () => {
    expect(sizeForTier(size(1080, 1920), STANDARD_IMAGE_TIER)).toEqual(size(819, 1456));
    expect(sizeForTier(size(1000, 3000), STANDARD_IMAGE_TIER)).toEqual(size(523, 1568));
  });

  test("an image that fits is kept as it is, a large one becomes the largest that fits, and one that can't fit at all becomes one pixel", () => {
    expect(sizeForTier(size(200, 200), STANDARD_IMAGE_TIER)).toEqual(size(200, 200));
    expect(sizeForTier(size(4000, 3000), STANDARD_IMAGE_TIER)).toEqual(size(1270, 952));
    expect(sizeForTier(size(100, 50), { maxEdge: 27, maxTokens: 10 })).toEqual(size(1, 1));
  });

  test("the long edge is brought down to the limit, never up, and no side goes below a pixel", () => {
    expect(fitLongEdge(size(4000, 3000), 2000)).toEqual(size(2000, 1500));
    expect(fitLongEdge(size(3000, 4000), 2000)).toEqual(size(1500, 2000));
    expect(fitLongEdge(size(800, 600), 2000)).toEqual(size(800, 600));
    expect(fitLongEdge(size(4000, 1), 1000)).toEqual(size(1000, 1));
  });
});

describe("what an image costs once Shore has prepared it", () => {

  test("no image costs more than its tier's ceiling", () => {
    for (const [width, height] of [[8000, 8000], [8000, 1], [1, 8000], [2001, 1999], [2576, 1449]] as const) {
      expect(imageTokens(size(width, height), HIGH_RESOLUTION_IMAGE_TIER)).toBeLessThanOrEqual(4784);
      expect(imageTokens(size(width, height), STANDARD_IMAGE_TIER)).toBeLessThanOrEqual(1568);
    }
  });
});

describe("fitting a long edge", () => {
  test("a side the scale would round away keeps one pixel", () => {
    expect(fitLongEdge({ width: 1, height: 10_000 }, 1000)).toEqual({ width: 1, height: 1000 });
    expect(fitLongEdge({ width: 30_000, height: 2 }, 1000)).toEqual({ width: 1000, height: 1 });
    expect(fitLongEdge({ width: 400, height: 300 }, 1000)).toEqual({ width: 400, height: 300 });
  });
});
