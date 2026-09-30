import fs from "node:fs";

export interface ImageDimensions {
  width: number;
  height: number;
}

type Reader = (offset: number, length: number) => Buffer | undefined;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const VP8_START_CODE = 0x9d012a;
const VP8L_SIGNATURE = 0x2f;
const MAX_JPEG_SEGMENTS = 512;

export function base64ImageDimensions(data: string): ImageDimensions | undefined {
  return dimensionsFrom((offset, length) => {
    const quantum = Math.floor(offset / 3);
    const chunk = Buffer.from(data.slice(quantum * 4, Math.ceil((offset + length) / 3) * 4), "base64");
    const skip = offset - quantum * 3;
    return chunk.length >= skip + length ? chunk.subarray(skip, skip + length) : undefined;
  });
}

export function fileImageDimensions(path: string): ImageDimensions | undefined {
  try {
    if (!fs.statSync(path).isFile()) return undefined;
    const fd = fs.openSync(path, "r");
    try {
      return dimensionsFrom((offset, length) => {
        const bytes = Buffer.alloc(length);
        return fs.readSync(fd, bytes, 0, length, offset) === length ? bytes : undefined;
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function dimensionsFrom(read: Reader): ImageDimensions | undefined {
  return png(read) ?? gif(read) ?? webp(read) ?? jpeg(read);
}

function png(read: Reader): ImageDimensions | undefined {
  const head = read(0, 24);
  if (head === undefined || !head.subarray(0, 8).equals(PNG_SIGNATURE) || ascii(head, 12, 4) !== "IHDR") {
    return undefined;
  }
  return sized(head.readUInt32BE(16), head.readUInt32BE(20));
}

function gif(read: Reader): ImageDimensions | undefined {
  const head = read(0, 10);
  if (head === undefined || !["GIF87a", "GIF89a"].includes(ascii(head, 0, 6))) return undefined;
  return sized(head.readUInt16LE(6), head.readUInt16LE(8));
}

function webp(read: Reader): ImageDimensions | undefined {
  const head = read(0, 16);
  if (head === undefined || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") return undefined;
  switch (ascii(head, 12, 4)) {
    case "VP8 ": {
      const frame = read(23, 7);
      if (frame === undefined || frame.readUIntBE(0, 3) !== VP8_START_CODE) return undefined;
      return sized(frame.readUInt16LE(3) & 0x3fff, frame.readUInt16LE(5) & 0x3fff);
    }
    case "VP8L": {
      const frame = read(20, 5);
      if (frame === undefined || frame[0] !== VP8L_SIGNATURE) return undefined;
      const bits = frame.readUInt32LE(1);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case "VP8X": {
      const canvas = read(24, 6);
      return canvas === undefined ? undefined : sized(canvas.readUIntLE(0, 3) + 1, canvas.readUIntLE(3, 3) + 1);
    }
    default:
      return undefined;
  }
}

function jpeg(read: Reader): ImageDimensions | undefined {
  const soi = read(0, 2);
  if (soi === undefined || soi[0] !== 0xff || soi[1] !== 0xd8) return undefined;
  let offset = 2;
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS; segments += 1) {
    const marker = read(offset, 2);
    if (marker === undefined || marker[0] !== 0xff) return undefined;
    const code = marker[1] as number;
    if (code === 0xff) {
      offset += 1;
      continue;
    }
    if (code === 0xd9 || code === 0xda) return undefined;
    const frame = isStartOfFrame(code);
    const segment = read(offset + 2, frame ? 7 : 2);
    if (segment === undefined) return undefined;
    if (frame) return sized(segment.readUInt16BE(5), segment.readUInt16BE(3));
    offset += 2 + segment.readUInt16BE(0);
  }
  return undefined;
}

function isStartOfFrame(code: number): boolean {
  return code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
}

function sized(width: number, height: number): ImageDimensions | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  return bytes.toString("ascii", offset, offset + length);
}
