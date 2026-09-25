import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ContentBlock } from "../../src/engine/types.ts";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

let oversized: Promise<ImageBlock> | undefined;
let wide: Promise<ImageBlock> | undefined;

export async function oversizedImage(): Promise<ImageBlock> {
  const width = 1220;
  const image = await (oversized ??= pngImage(width, width, randomBytes(width * width * 3)));
  expect(image.source.data.length).toBeGreaterThan(5 * 1024 * 1024);
  return { ...image, source: { ...image.source } };
}

export async function wideImage(): Promise<ImageBlock> {
  const image = await (wide ??= pngImage(4000, 1000, Buffer.alloc(4000 * 1000 * 3, 255)));
  expect(image.source.data.length).toBeLessThan(1_000_000);
  return { ...image, source: { ...image.source } };
}

async function pngImage(width: number, height: number, pixels: Buffer): Promise<ImageBlock> {
  const bmp = Buffer.alloc(54 + pixels.length);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  pixels.copy(bmp, 54);
  const data = await new Bun.Image(bmp).png().toBase64();
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}
