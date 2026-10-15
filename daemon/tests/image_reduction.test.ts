import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "../src/engine/types.ts";
import { DEFAULT_IMAGE_SETTINGS, MAX_SENT_IMAGE_BYTES, type ImageSettings } from "../src/llm/image_settings.ts";
import { limitRequestImages, reduceImage } from "../src/llm/prepare_images.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { base64Bytes } from "../src/util/base64.ts";
import { required } from "../src/util/required.ts";
import { noisePng } from "./support/test_images.ts";

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
