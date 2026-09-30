import { describe, expect, test } from "bun:test";

import { prepareImageBlock } from "../src/llm/prepare_images.ts";
import {
  HIGH_RESOLUTION_IMAGE_TIER,
  STANDARD_IMAGE_TIER,
  imageTierForModel,
  imageTokens,
  sizeForTier,
  visualTokens,
} from "../src/llm/image_tokens.ts";
import { sizedImage } from "./support/sized_image.ts";

const size = (width: number, height: number) => ({ width, height });

describe("Anthropic's resize rule, and the costs its vision guide lists", () => {
  test("one token per 28-pixel patch, rounding up", () => {
    expect(visualTokens(200, 200)).toBe(64);
    expect(visualTokens(1000, 1000)).toBe(1296);
    expect(visualTokens(1092, 1092)).toBe(1521);
  });

  const TABLE: [number, number, [number, number], number, [number, number], number][] = [
    [200, 200, [200, 200], 64, [200, 200], 64],
    [1920, 1080, [1456, 819], 1560, [1920, 1080], 2691],
    [2000, 1500, [1270, 952], 1564, [2000, 1500], 3888],
    [3840, 2160, [1456, 819], 1560, [2576, 1449], 4784],
  ];

  for (const [width, height, standard, standardTokens, high, highTokens] of TABLE) {
    test(`${String(width)}×${String(height)} on each tier`, () => {
      const onStandard = sizeForTier(size(width, height), STANDARD_IMAGE_TIER);
      expect(onStandard).toEqual(size(...standard));
      expect(visualTokens(onStandard.width, onStandard.height)).toBe(standardTokens);
      const onHigh = sizeForTier(size(width, height), HIGH_RESOLUTION_IMAGE_TIER);
      expect(onHigh).toEqual(size(...high));
      expect(visualTokens(onHigh.width, onHigh.height)).toBe(highTokens);
    });
  }

  test("a page inside both edge limits is still resized for its token count on the standard tier", () => {
    expect(sizeForTier(size(1075, 1520), STANDARD_IMAGE_TIER)).toEqual(size(924, 1307));
    expect(sizeForTier(size(1075, 1520), HIGH_RESOLUTION_IMAGE_TIER)).toEqual(size(1075, 1520));
    expect(visualTokens(1075, 1520)).toBe(2145);
  });

  test("a tall image is resized along its long edge", () => {
    expect(sizeForTier(size(1080, 1920), STANDARD_IMAGE_TIER)).toEqual(size(819, 1456));
  });

  test("a panorama is held by the edge limit, not the token limit", () => {
    const seen = sizeForTier(size(4000, 500), STANDARD_IMAGE_TIER);
    expect(seen).toEqual(size(1568, 196));
    expect(visualTokens(seen.width, seen.height)).toBeLessThan(STANDARD_IMAGE_TIER.maxTokens);
  });
});

describe("what an image costs once Shore has prepared it", () => {
  test("Shore's own 2000-pixel resize comes before the model's", () => {
    expect(imageTokens(size(3840, 2160), HIGH_RESOLUTION_IMAGE_TIER)).toBe(visualTokens(2000, 1125));
    expect(imageTokens(size(4000, 3000), HIGH_RESOLUTION_IMAGE_TIER)).toBe(3888);
    expect(imageTokens(size(4000, 3000), STANDARD_IMAGE_TIER)).toBe(1564);
  });

  test("Shore's resize rounds the short edge the way the resize it runs does", async () => {
    const data = (await sizedImage(4000, 57)).toString("base64");
    const prepared = await prepareImageBlock({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    if (prepared.type !== "image") throw new Error("missing image");
    expect(await new Bun.Image(Buffer.from(prepared.source.data, "base64")).metadata()).toMatchObject(size(2000, 29));
    expect(imageTokens(size(4000, 57), HIGH_RESOLUTION_IMAGE_TIER)).toBe(visualTokens(2000, 29));
  });

  test("a small image costs the same on either tier", () => {
    expect(imageTokens(size(400, 300), HIGH_RESOLUTION_IMAGE_TIER)).toBe(165);
    expect(imageTokens(size(400, 300), STANDARD_IMAGE_TIER)).toBe(165);
  });

  test("an image of unknown size is counted at the most its tier charges", () => {
    expect(imageTokens(undefined, HIGH_RESOLUTION_IMAGE_TIER)).toBe(4784);
    expect(imageTokens(undefined, STANDARD_IMAGE_TIER)).toBe(1568);
  });

  test("no image costs more than its tier's ceiling", () => {
    for (const [width, height] of [[8000, 8000], [8000, 1], [1, 8000], [2001, 1999], [2576, 1449]] as const) {
      expect(imageTokens(size(width, height), HIGH_RESOLUTION_IMAGE_TIER)).toBeLessThanOrEqual(4784);
      expect(imageTokens(size(width, height), STANDARD_IMAGE_TIER)).toBeLessThanOrEqual(1568);
    }
  });
});

describe("which resolution tier a model is on", () => {
  const HIGH = [
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "anthropic/claude-opus-4.7",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "CLAUDE-OPUS-5-5",
  ];
  const STANDARD = [
    "claude-opus-4-6",
    "claude-opus-4-1",
    "claude-opus-4-20250514",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "anthropic/claude-3.7-sonnet",
    "Claude-Sonnet-4-5",
  ];

  test("Claude 4.7 and later are high resolution", () => {
    for (const id of HIGH) expect([id, imageTierForModel(id)]).toEqual([id, HIGH_RESOLUTION_IMAGE_TIER]);
  });

  test("earlier Claude models are standard", () => {
    for (const id of STANDARD) expect([id, imageTierForModel(id)]).toEqual([id, STANDARD_IMAGE_TIER]);
  });

  test("a model with no Claude version is given the higher ceiling, so it is never undercounted", () => {
    for (const id of ["opus", "sonnet", "default", "gpt-5", "gemini-3-pro-preview", "glm-4.6"]) {
      expect([id, imageTierForModel(id)]).toEqual([id, HIGH_RESOLUTION_IMAGE_TIER]);
    }
  });
});
