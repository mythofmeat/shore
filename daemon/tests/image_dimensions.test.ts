import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { base64ImageDimensions, fileImageDimensions } from "../src/llm/image_dimensions.ts";
import { sizedImage, type Encode } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const SIZE = { width: 333, height: 211 };
const MODULE = new URL("../src/llm/image_dimensions.ts", import.meta.url).pathname;
const PROBE_MS = 10_000;

function scratch(): string {
  const dir = testTmp("image-dimensions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function saved(name: string, bytes: Buffer): string {
  const path = join(scratch(), name);
  writeFileSync(path, bytes);
  return path;
}

function segment(code: number, payload: number): Buffer {
  const bytes = Buffer.alloc(4 + payload, 0x20);
  bytes.writeUInt16BE(0xff00 | code, 0);
  bytes.writeUInt16BE(payload + 2, 2);
  return bytes;
}

const ENCODINGS: [string, Encode][] = [
  ["a PNG", (image) => image.png()],
  ["a baseline JPEG", (image) => image.jpeg()],
  ["a progressive JPEG", (image) => image.jpeg({ progressive: true })],
  ["a lossy WebP", (image) => image.webp()],
  ["a lossless WebP", (image) => image.webp({ lossless: true })],
];

describe("an image's size comes from its header", () => {
  for (const [name, encode] of ENCODINGS) {
    test(`${name}, as base64 or as a file`, async () => {
      const bytes = await sizedImage(SIZE.width, SIZE.height, encode);
      expect(base64ImageDimensions(bytes.toString("base64"))).toEqual(SIZE);
      expect(fileImageDimensions(saved(`${name.replaceAll(" ", "-")}.img`, bytes))).toEqual(SIZE);
    });
  }

  test("a GIF, by its logical screen", () => {
    const gif = Buffer.alloc(13);
    gif.write("GIF89a");
    gif.writeUInt16LE(SIZE.width, 6);
    gif.writeUInt16LE(SIZE.height, 8);
    expect(base64ImageDimensions(gif.toString("base64"))).toEqual(SIZE);
    gif.write("GIF87a");
    expect(fileImageDimensions(saved("old.gif", gif))).toEqual(SIZE);
  });

  test("an extended WebP, by its canvas", () => {
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.writeUInt32LE(22, 4);
    webp.write("WEBPVP8X", 8);
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(SIZE.width - 1, 24, 3);
    webp.writeUIntLE(SIZE.height - 1, 27, 3);
    expect(base64ImageDimensions(webp.toString("base64"))).toEqual(SIZE);
  });

  test("a lossy WebP, without the scaling bits packed beside its size", () => {
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.writeUInt32LE(22, 4);
    webp.write("WEBPVP8 ", 8);
    webp.writeUInt32LE(10, 16);
    webp.writeUIntBE(0x9d012a, 23, 3);
    webp.writeUInt16LE(0x4000 | SIZE.width, 26);
    webp.writeUInt16LE(0x8000 | SIZE.height, 28);
    expect(base64ImageDimensions(webp.toString("base64"))).toEqual(SIZE);
  });

  test("a JPEG with tables and other segments before its frame header", async () => {
    const plain = await sizedImage(SIZE.width, SIZE.height, (image) => image.jpeg());
    const tablesFirst = Buffer.concat([
      plain.subarray(0, 2),
      segment(0xc4, 20),
      segment(0xc8, 20),
      segment(0xcc, 20),
      plain.subarray(2),
    ]);
    expect(base64ImageDimensions(tablesFirst.toString("base64"))).toEqual(SIZE);
  });

  test("a JPEG whose metadata pushes its frame header far past the start", async () => {
    const plain = await sizedImage(SIZE.width, SIZE.height, (image) => image.jpeg());
    const padded = Buffer.concat([
      plain.subarray(0, 2),
      segment(0xe1, 60_000),
      Buffer.from([0xff]),
      segment(0xe2, 60_000),
      plain.subarray(2),
    ]);
    expect((await new Bun.Image(padded).metadata()).width).toBe(SIZE.width);
    expect(base64ImageDimensions(padded.toString("base64"))).toEqual(SIZE);
    expect(fileImageDimensions(saved("padded.jpg", padded))).toEqual(SIZE);
  });
});

describe("anything else has no size", () => {
  test("data that is not an image, or is cut off before its size", async () => {
    const png = await sizedImage(SIZE.width, SIZE.height);
    expect(base64ImageDimensions("A".repeat(4096))).toBeUndefined();
    expect(base64ImageDimensions("")).toBeUndefined();
    expect(base64ImageDimensions(png.subarray(0, 20).toString("base64"))).toBeUndefined();
  });

  test("a PNG whose first chunk is not its header", () => {
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(4, 8);
    png.write("CgBI", 12);
    png.writeUInt32BE(SIZE.width, 16);
    png.writeUInt32BE(SIZE.height, 20);
    expect(base64ImageDimensions(png.toString("base64"))).toBeUndefined();
  });

  test("a WebP frame without its start code or signature", () => {
    const lossy = Buffer.alloc(30);
    lossy.write("RIFF");
    lossy.write("WEBPVP8 ", 8);
    lossy.writeUInt16LE(SIZE.width, 26);
    lossy.writeUInt16LE(SIZE.height, 28);
    expect(base64ImageDimensions(lossy.toString("base64"))).toBeUndefined();
    const lossless = Buffer.alloc(30);
    lossless.write("RIFF");
    lossless.write("WEBPVP8L", 8);
    lossless.writeUInt32LE((SIZE.width - 1) | ((SIZE.height - 1) << 14), 21);
    expect(base64ImageDimensions(lossless.toString("base64"))).toBeUndefined();
  });

  test("a JPEG whose scan starts before any frame header, whatever the scan data holds", () => {
    const frame = segment(0xc0, 15);
    frame.writeUInt16BE(SIZE.height, 5);
    frame.writeUInt16BE(SIZE.width, 7);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, 12), frame]);
    expect(base64ImageDimensions(jpeg.toString("base64"))).toBeUndefined();
    expect(base64ImageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8]), frame]).toString("base64"))).toEqual(SIZE);
  });

  test("a file cut off partway through its frame header", async () => {
    const jpeg = await sizedImage(SIZE.width, SIZE.height, (image) => image.jpeg());
    const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(frame).toBeGreaterThan(0);
    expect(fileImageDimensions(saved("cut.jpg", jpeg.subarray(0, frame + 8)))).toBeUndefined();
  });

  test("a missing file, or a directory", () => {
    expect(fileImageDimensions(join(scratch(), "missing.png"))).toBeUndefined();
    expect(fileImageDimensions(scratch())).toBeUndefined();
  });

  test("a named pipe, which is never opened because opening it would wait for a writer", async () => {
    const fifo = join(scratch(), "pipe.png");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const probe = Bun.spawn(
      ["bun", "-e", `const { fileImageDimensions } = await import(${JSON.stringify(MODULE)}); console.log(String(fileImageDimensions(${JSON.stringify(fifo)})));`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const finished = await Promise.race([probe.exited.then(() => true), Bun.sleep(PROBE_MS).then(() => false)]);
    probe.kill();
    expect(finished).toBe(true);
    expect((await new Response(probe.stdout).text()).trim()).toBe("undefined");
  }, PROBE_MS + 5_000);
});
