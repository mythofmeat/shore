import { expect, test } from "bun:test";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { OpenAIProvider } from "../src/llm/providers/openai.ts";
import { GeminiProvider } from "../src/llm/providers/gemini.ts";
import { VercelProvider } from "../src/llm/providers/vercel.ts";
import { prepareImageBlock, prepareImageBlocks } from "../src/llm/prepare_images.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { oversizedImage, wideImage } from "./support/oversized_image.ts";
import { MAX_SENT_IMAGE_BYTES } from "../src/llm/image_settings.ts";
import { base64Bytes } from "../src/util/base64.ts";

test("small image blocks are preserved byte for byte", async () => {
  const block = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "unchanged" } };
  expect((await prepareImageBlocks([block]))[0]).toBe(block);
});

test("compact images at the dimension limit remain unchanged", async () => {
  const wide = await wideImage();
  const data = await new Bun.Image(Buffer.from(wide.source.data, "base64")).resize(2000, 500).png().toBase64();
  const image = { ...wide, source: { ...wide.source, data } };
  expect(await prepareImageBlock(image)).toBe(image);
});

test("a multi-megabyte image below the old limit is still compressed", async () => {
  const large = await oversizedImage();
  const data = await new Bun.Image(Buffer.from(large.source.data, "base64")).resize(1000, 800).png().toBase64();
  expect(data.length).toBeGreaterThan(1_000_000);
  expect(data.length).toBeLessThan(5_000_000);
  const image = { ...large, source: { ...large.source, data } };
  const prepared = await prepareImageBlock(image);
  if (prepared.type !== "image") throw new Error("missing image");
  expect(prepared.source.data.length).toBeLessThanOrEqual(1_000_000);
  expect(image.source.data).toBe(data);
  const metadata = await new Bun.Image(Buffer.from(prepared.source.data, "base64")).metadata();
  expect(metadata.width).toBeLessThanOrEqual(1000);
  expect(metadata.height).toBeLessThanOrEqual(800);
  expect(metadata.width / metadata.height).toBeCloseTo(1.25, 2);
  expect(await prepareImageBlock(prepared)).toBe(prepared);
});

test("preparing the same image again gives the same result as its own block", async () => {
  const image = await oversizedImage();
  const first = await prepareImageBlock(image);
  const second = await prepareImageBlock({ ...image, source: { ...image.source } });
  if (first.type !== "image" || second.type !== "image") throw new Error("missing image");
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.source).not.toBe(first.source);
  expect(first.source.data.length).toBeLessThanOrEqual(1_000_000);
});

function imageData(value: unknown): string[] {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return [value.slice(value.indexOf(",") + 1)];
    return value.length > 1000 ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(imageData);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(imageData);
  return [];
}

const adapters: { sdk: SidecarRequest["sdk"]; provider: SidecarProvider }[] = [
  { sdk: "anthropic", provider: new AnthropicProvider() },
  { sdk: "openai", provider: new OpenAIProvider() },
  { sdk: "gemini", provider: new GeminiProvider() },
  { sdk: "moonshot", provider: new VercelProvider() },
];

async function sentBody(provider: SidecarProvider, request: Omit<SidecarRequest, "base_url">, stream: boolean): Promise<unknown> {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(incoming) {
      bodies.push(await incoming.json());
      return Response.json({ error: { type: "invalid_request_error", message: "test stops after receiving the payload" } }, { status: 400 });
    },
  });
  try {
    try {
      const call = { ...request, base_url: server.url.toString() };
      if (stream) for await (const _event of provider.stream(call, AbortSignal.timeout(10_000))) { void _event; }
      else await provider.generate(call, AbortSignal.timeout(10_000));
    } catch {}
    expect(bodies.length).toBeGreaterThan(0);
    return bodies[0];
  } finally {
    await server.stop(true);
  }
}

for (const { sdk, provider } of adapters) {
  test.each([false, true])(`${sdk} sends images inside the API's limits as they are, and brings the rest inside (stream: %s)`, async (stream) => {
    const image = await oversizedImage();
    const wide = await wideImage();
    const body = await sentBody(provider, {
      sdk, api_key: "test", model: "test", max_tokens: 64, replay_prior_thinking: "all",
      tools: [{ name: "inspect", description: "inspect", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [image, wide] },
        { role: "assistant", content: [{ type: "text", text: "seen" }, { type: "tool_use", id: "toolu_inspect", name: "inspect", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_inspect", content: [image, wide] }, image, wide, { type: "text", text: "compare" }] },
      ],
    }, stream);
    const images = imageData(body);
    expect(images).toHaveLength(6);
    for (const [index, data] of images.entries()) {
      expect(base64Bytes(data)).toBeLessThanOrEqual(MAX_SENT_IMAGE_BYTES);
      if (index % 2 === 1) expect(data).toBe(wide.source.data);
      else {
        const metadata = await new Bun.Image(Buffer.from(data, "base64")).metadata();
        expect(metadata.width).toBeLessThanOrEqual(1220);
        expect(metadata.height).toBe(metadata.width);
      }
    }
    expect(image.source.data.length).toBeGreaterThan(5 * 1024 * 1024);
  }, 30_000);

  test(`${sdk} keeps every image within 2000 pixels once a request carries more than 20`, async () => {
    const wide = await wideImage();
    const body = await sentBody(provider, {
      sdk, api_key: "test", model: "test", max_tokens: 64, replay_prior_thinking: "all",
      messages: [{ role: "user", content: [...Array.from({ length: 21 }, () => wide), { type: "text", text: "compare" }] }],
    }, false);
    const images = imageData(body);
    expect(images).toHaveLength(21);
    for (const data of images) {
      expect(await new Bun.Image(Buffer.from(data, "base64")).metadata()).toMatchObject({ width: 2000, height: 500 });
    }
  }, 30_000);
}
