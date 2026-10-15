import { describe, expect, test } from "bun:test";

import { capRequestImages, countImageBlocks, MAX_REQUEST_IMAGES, REQUEST_IMAGE_DROP_STEP } from "../src/llm/image_support";
import type { WireMessage } from "../src/llm/types";

function imageMessage(): WireMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this" },
    ],
  };
}

describe("capping images per request", () => {

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
