import { deflateSync } from "node:zlib";

export function noiseBitmap(width: number, height: number, seed = 1): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  let state = seed;
  for (let i = 54; i < bmp.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bmp[i] = state >>> 24;
  }
  return bmp;
}

export async function noisePng(width: number, height: number, seed = 1): Promise<Buffer> {
  return Buffer.from(await new Bun.Image(noiseBitmap(width, height, seed)).png().bytes());
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function transparentPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows.set(x < width / 2 ? [0, 0, 0, 0] : [30, 60, 200, 255], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function withTextChunk(png: Buffer, bytes: number): Buffer {
  const text = chunk("tEXt", Buffer.concat([Buffer.from("chara\0", "latin1"), Buffer.alloc(bytes, "A")]));
  return Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
}

export function rotatedJpeg(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

export const ONE_PIXEL_GIF = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
