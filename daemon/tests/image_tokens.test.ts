import { describe, expect, test } from "bun:test";
import { HIGH_RESOLUTION_IMAGE_TIER, STANDARD_IMAGE_TIER, imageTokens, sizeForTier, visualTokens } from "../src/llm/image_tokens.ts";

const size = (width: number, height: number) => ({ width, height });

describe("Anthropic's resize rule, and the costs its vision guide lists", () => {
  test("one token per 28-pixel patch, rounding up", () => {
    expect(visualTokens(200, 200)).toBe(64);
    expect(visualTokens(1000, 1000)).toBe(1296);
    expect(visualTokens(1092, 1092)).toBe(1521);
  });

  test("a tall image is resized along its long edge", () => {
    expect(sizeForTier(size(1080, 1920), STANDARD_IMAGE_TIER)).toEqual(size(819, 1456));
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
