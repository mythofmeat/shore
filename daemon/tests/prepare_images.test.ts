import { expect, test } from "bun:test";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { OpenAIProvider } from "../src/llm/providers/openai.ts";
import { GeminiProvider } from "../src/llm/providers/gemini.ts";
import { VercelProvider } from "../src/llm/providers/vercel.ts";
import { prepareImageBlock, prepareImageBlocks } from "../src/llm/prepare_images.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { oversizedImage, wideImage } from "./support/oversized_image.ts";

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

for (const { sdk, provider } of adapters) {
  test.each([false, true])(`${sdk} sends prepared images in history and new turns (stream: %s)`, async (stream) => {
    const image = await oversizedImage();
    const wide = await wideImage();
    const bodies: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        bodies.push(await request.json());
        return Response.json({ error: { type: "invalid_request_error", message: "test stops after receiving the payload" } }, { status: 400 });
      },
    });
    const request: SidecarRequest = {
      sdk, api_key: "test", model: "test", base_url: server.url.toString(), max_tokens: 64, replay_prior_thinking: "all",
      tools: [{ name: "inspect", description: "inspect", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [image, wide] },
        { role: "assistant", content: [{ type: "text", text: "seen" }, { type: "tool_use", id: "toolu_inspect", name: "inspect", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_inspect", content: [image, wide] }, image, wide, { type: "text", text: "compare" }] },
      ],
    };
    try {
      try {
        if (stream) for await (const _event of provider.stream(request, AbortSignal.timeout(10_000))) { void _event; }
        else await provider.generate(request, AbortSignal.timeout(10_000));
      } catch {}
      expect(bodies.length).toBeGreaterThan(0);
      const images = imageData(bodies[0]);
      expect(images).toHaveLength(6);
      for (const [index, data] of images.entries()) {
        expect(data.length).toBeLessThanOrEqual(1_000_000);
        const metadata = await new Bun.Image(Buffer.from(data, "base64")).metadata();
        if (index % 2 === 1) expect(metadata).toMatchObject({ width: 2000, height: 500 });
        else {
          expect(metadata.width).toBeLessThanOrEqual(1220);
          expect(metadata.height).toBe(metadata.width);
        }
      }
      expect(image.source.data.length).toBeGreaterThan(5 * 1024 * 1024);
    } finally {
      await server.stop(true);
    }
  }, 30_000);
}
