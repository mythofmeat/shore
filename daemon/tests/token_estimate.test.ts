import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BYTES_PER_TOKEN,
  CONTEXT_SAFETY_FRACTION,
  estimateTokens,
  withSafetyMargin,
} from "../src/engine/tokens.ts";
import { estimateHistoryTokens } from "../src/engine/prompt.ts";
import type { ContentBlock, ImageRef, Message } from "../src/engine/types.ts";
import { HIGH_RESOLUTION_IMAGE_TIER, STANDARD_IMAGE_TIER } from "../src/llm/image_tokens.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

interface Corpus {
  host: string;
  samples: number;
  minRatio: number;
  medianRatio: number;
  maxRatio: number;
}

const MEASURED: Corpus[] = [
  { host: "api.anthropic.com", samples: 80, minRatio: 0.806, medianRatio: 0.837, maxRatio: 0.895 },
  { host: "opencode.ai", samples: 78, minRatio: 0.5, medianRatio: 0.88, maxRatio: 1.075 },
  { host: "openrouter.ai", samples: 8, minRatio: 0.808, medianRatio: 0.956, maxRatio: 1.0 },
];

const anthropic = required(MEASURED[0]);

describe("the estimator's scale constant", () => {
  test("four bytes per token under-counted, which is what made it worth changing", () => {
    expect(anthropic.medianRatio).toBeLessThan(1);
    expect(4 * anthropic.medianRatio).toBeGreaterThan(BYTES_PER_TOKEN);
  });

  test("it never under-counts on the worst Anthropic sample measured", () => {
    expect(BYTES_PER_TOKEN).toBeLessThanOrEqual(4 * anthropic.minRatio);
  });

  test("nor on the worst OpenRouter one", () => {
    const openrouter = required(MEASURED[2]);
    expect(BYTES_PER_TOKEN).toBeLessThanOrEqual(4 * openrouter.minRatio);
  });

  test("at the Anthropic median it lands within a few percent of what was billed", () => {
    const billed = 60_000;
    const bytes = billed * anthropic.medianRatio * 4;
    const estimated = Math.ceil(bytes / BYTES_PER_TOKEN);
    expect(Math.abs(estimated - billed) / billed).toBeLessThan(0.05);
  });

  test("counting is in UTF-8 bytes, so multibyte text is not undercounted", () => {
    expect(estimateTokens("日本語")).toBe(Math.ceil(9 / BYTES_PER_TOKEN));
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("withSafetyMargin", () => {
  test("holds back a slice of the budget so an estimator miss trims rather than overshoots", () => {
    expect(withSafetyMargin(1000)).toBe(1000 * (1 - CONTEXT_SAFETY_FRACTION));
    expect(withSafetyMargin(0)).toBe(0);
    expect(withSafetyMargin(-5)).toBe(0);
  });

  test("the margin covers the spread the fit does not", () => {
    const worstOvershoot = 4 * anthropic.minRatio - BYTES_PER_TOKEN;
    expect(worstOvershoot).toBeGreaterThanOrEqual(0);
    expect(CONTEXT_SAFETY_FRACTION).toBeGreaterThan(0);
  });
});

test("history tokens count the active messages once", () => {
  const messages = [
    {
      msg_id: "u1",
      role: "user" as const,
      content: "hello",
      images: [],
      content_blocks: [{ type: "text" as const, text: "hello" }],
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      msg_id: "a1",
      role: "assistant" as const,
      content: "",
      images: [],
      content_blocks: [{ type: "tool_use" as const, id: "t1", name: "read", input: { path: "a" } }],
      timestamp: "2026-01-01T00:00:01Z",
    },
  ];
  expect(estimateHistoryTokens(messages)).toBe(
    estimateTokens("hello") + estimateTokens("read") + estimateTokens(JSON.stringify({ path: "a" })),
  );
});

describe("images in the history", () => {
  const picture = (bytes: Buffer, media_type = "image/png"): ContentBlock => ({
    type: "image",
    source: { type: "base64", media_type, data: bytes.toString("base64") },
  });

  const unreadable = (kib: number): ContentBlock => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(kib * 1024) },
  });

  const holding = (content_blocks: ContentBlock[], images: ImageRef[] = []): Message[] => [{
    msg_id: "u1",
    role: "user",
    content: "",
    images,
    content_blocks,
    timestamp: "2026-01-01T00:00:00Z",
  }];

  test("a picture costs its pixels, whatever encoding carries them", async () => {
    const png = await sizedImage(1920, 1080);
    const jpeg = await sizedImage(1920, 1080, (image) => image.jpeg({ quality: 30 }));
    expect(png.length).not.toBe(jpeg.length);
    expect(estimateHistoryTokens(holding([picture(png)]))).toBe(2691);
    expect(estimateHistoryTokens(holding([picture(jpeg, "image/jpeg")]))).toBe(2691);
  });

  test("a small picture costs its few patches, not the most a picture can", async () => {
    expect(estimateHistoryTokens(holding([picture(await sizedImage(400, 300))]))).toBe(165);
  });

  test("a standard-tier model is charged less for a large picture", async () => {
    const screenshot = holding([picture(await sizedImage(1920, 1080))]);
    expect(estimateHistoryTokens(screenshot, STANDARD_IMAGE_TIER)).toBe(1560);
  });

  test("seven photos read in one tool call come to what the model is sent, not hundreds of thousands", async () => {
    const photo = picture(await sizedImage(2000, 1500, (image) => image.jpeg()), "image/jpeg");
    const seven = holding([{
      type: "tool_result",
      tool_use_id: "t1",
      content: Array.from({ length: 7 }, () => photo),
    }]);
    expect(estimateHistoryTokens(seven)).toBe(7 * 3888);
    expect(estimateHistoryTokens(seven, STANDARD_IMAGE_TIER)).toBe(7 * 1564);
  });

  test("a picture whose size cannot be read is counted at the most the model charges", () => {
    expect(estimateHistoryTokens(holding([unreadable(10)]))).toBe(HIGH_RESOLUTION_IMAGE_TIER.maxTokens);
    expect(estimateHistoryTokens(holding([unreadable(400)]), STANDARD_IMAGE_TIER)).toBe(
      STANDARD_IMAGE_TIER.maxTokens,
    );
  });

  test("text beside a picture in a tool result is counted as its text alone", () => {
    const bare = holding([{ type: "tool_result", tool_use_id: "t1", content: [unreadable(10)] }]);
    const captioned = holding([{
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "photos/1.jpg" }, unreadable(10)],
    }]);
    expect(estimateHistoryTokens(captioned) - estimateHistoryTokens(bare)).toBe(
      estimateTokens("photos/1.jpg"),
    );
  });

  test("an attached picture is measured from its file, or from its data while it still has some", async () => {
    const bytes = await sizedImage(400, 300);
    const dir = testTmp("token-estimate");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "attached.png");
    writeFileSync(path, bytes);
    expect(estimateHistoryTokens(holding([], [{ path }]))).toBe(165);
    expect(estimateHistoryTokens(holding([], [{ path, data: "" }]))).toBe(165);
    expect(estimateHistoryTokens(holding([], [{ path: join(dir, "gone.png"), data: bytes.toString("base64") }]))).toBe(165);
    expect(estimateHistoryTokens(holding([], [{ path: join(dir, "gone.png") }]))).toBe(
      HIGH_RESOLUTION_IMAGE_TIER.maxTokens,
    );
  });

  test("a picture a message embedded costs nothing, since the model is never sent it", async () => {
    const dir = testTmp("token-estimate");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sent.png");
    writeFileSync(path, await sizedImage(400, 300));
    expect(estimateHistoryTokens(holding([], [{ path, embed: "![[sent]]", name: "sent.png" }]))).toBe(0);
  });
});
