import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ContentBlock } from "../../src/engine/types.ts";

export async function oversizedImage(): Promise<Extract<ContentBlock, { type: "image" }>> {
  const width = 1220;
  const bmp = Buffer.alloc(54 + width * width * 3);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(width, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  randomBytes(bmp.length - 54).copy(bmp, 54);
  const data = await new Bun.Image(bmp).png().toBase64();
  expect(data.length).toBeGreaterThan(5 * 1024 * 1024);
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

