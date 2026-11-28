import { expect, test } from "bun:test";

import { STANDARD_IMAGE_TIER } from "../src/llm/image_tokens.ts";
import type { ImageVersion, ReducedImage } from "../src/llm/prepare_images.ts";
import { Texts } from "../src/texts/texts.ts";
import { listSome, reductionNote, renderPayload, type ToolMediaItem } from "../src/tools/media.ts";

const texts = new Texts();

const version = (mediaType: string, width?: number, height?: number): ImageVersion => ({ mediaType, dimensions: width === undefined || height === undefined ? undefined : { width, height } });

const reduced = (original: ImageVersion, sent: ImageVersion): ReducedImage => ({ source: { type: "base64", media_type: sent.mediaType, data: "" }, original, sent, changed: true });

const item = (label: string, extra: Partial<ToolMediaItem> = {}): ToolMediaItem => ({ mime_type: "image/png", data: "", label, ...extra });

test("a picture made smaller says what it was and what was sent, with their cost in tokens, and how to read it whole when that is offered", () => {
  const big = reduced(version("image/png", 4000, 3000), version("image/png", 1568, 1176));
  const note = (over: Partial<Parameters<typeof reductionNote>[1]>) => reductionNote(texts, { item: item("big.png", { path: "photos/big.png" }), reduced: big, tier: STANDARD_IMAGE_TIER, fullSize: { width: 1568, height: 1176 }, offerOriginal: true, ...over });
  expect(note({})).toBe("[big.png: reduced from 4000×3000 PNG (1,564 tokens) to 1568×1176 PNG (1,564 tokens). Read photos/big.png with original: true for the full image.]");
  expect(note({ item: item("big.png") })).toBe("[big.png: reduced from 4000×3000 PNG (1,564 tokens) to 1568×1176 PNG (1,564 tokens). Read it with original: true for the full image.]");
  expect(note({ offerOriginal: false })).toBe("[big.png: reduced from 4000×3000 PNG (1,564 tokens) to 1568×1176 PNG (1,564 tokens).]");
  expect(note({ fullSize: undefined, offerOriginal: false })).toBe("[big.png: reduced from 4000×3000 PNG (1,568 tokens) to 1568×1176 PNG (1,564 tokens).]");
  expect(note({ item: item("big.png", { original: true }) })).toBe("[big.png: 4000×3000 PNG sent at 1568×1176 PNG (1,564 tokens), the full resolution this model accepts.]");
});

test("a moving picture says only its first frame was sent, and a picture of one patch costs one token", () => {
  const moving = reduced(version("image/gif", 56, 28), version("image/png", 28, 28));
  expect(reductionNote(texts, { item: item("loop.gif"), reduced: moving, tier: STANDARD_IMAGE_TIER, fullSize: { width: 56, height: 28 }, offerOriginal: false }))
    .toBe("[loop.gif: reduced from 56×28 GIF (2 tokens) to 28×28 PNG (1 token), first frame only.]");
  expect(reductionNote(texts, { item: item("loop.gif", { original: true }), reduced: moving, tier: STANDARD_IMAGE_TIER, fullSize: undefined, offerOriginal: false }))
    .toBe("[loop.gif: 56×28 GIF sent at 28×28 PNG (1 token), the full resolution this model accepts, first frame only.]");
  const odd = reduced(version("image/bmp"), version("image/webp", 28, 56));
  expect(reductionNote(texts, { item: item("odd.bmp"), reduced: odd, tier: STANDARD_IMAGE_TIER, fullSize: undefined, offerOriginal: false }))
    .toBe("[odd.bmp: reduced from image/bmp (1,568 tokens) to 28×56 WebP (2 tokens).]");
});

test("a result shown without its pictures names each one, after what the tool said", () => {
  expect(renderPayload(texts, { value: "looked", media: [item("one"), item("two")], extra: ["more"], notes: ["a note"] })).toBe("looked\nmore\na note\n[one returned, not included here]\n[two returned, not included here]");
  expect(renderPayload(texts, { value: "", media: [item("one")], extra: [] })).toBe("[one returned, not included here]");
  expect(renderPayload(Texts.from({ tool_media_left_out: null }), { value: "looked", media: [item("one")], extra: [] })).toBe("looked");
});

test("a list of pictures names the first three and counts the rest", () => {
  expect(listSome(texts, ["a", "b", "c"])).toBe("a, b, c");
  expect(listSome(texts, ["a", "b", "c", "d"])).toBe("a, b, c and 1 more");
  expect(listSome(texts, ["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  expect(listSome(Texts.from({ tool_list_and_more: null }), ["a", "b", "c", "d"])).toBe("a, b, c");
});
