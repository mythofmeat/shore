export type Encode = (image: Bun.Image) => Bun.Image;

export async function sizedImage(
  width: number,
  height: number,
  encode: Encode = (image) => image.png(),
): Promise<Buffer> {
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
  bmp.fill(160, 54);
  return Buffer.from(await encode(new Bun.Image(bmp)).toBuffer());
}
