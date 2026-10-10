import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../engine/atomic.ts";
import { fitLongEdge } from "../llm/image_tokens.ts";
import { characterMediaDir } from "./media.ts";

export const DISPLAY_EDGE = 1600;
const DISPLAY_QUALITY = 85;
const SHOWN_AS_IS_BYTES = 1024 * 1024;
const GIF_SHOWN_AS_IS_BYTES = 8 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const SENT_PICTURE_FILE = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

export const sentPicturesDir = (data: string, character: string): string => join(characterMediaDir(data, character), "sent");

export function displayCopyPath(path: string): string {
  return join(dirname(path), "display", basename(path).replace(/\.[a-z]+$/, ".webp"));
}

export function isSentPicture(path: string): boolean {
  return SENT_PICTURE_FILE.test(basename(path)) && basename(dirname(path)) === "sent";
}

async function keepDisplayCopy(path: string, bytes: Buffer, mime: string): Promise<void> {
  const target = displayCopyPath(path);
  if (existsSync(target)) return;
  const { width, height } = await new Bun.Image(bytes).metadata();
  const fits = Math.max(width, height) <= DISPLAY_EDGE;
  if (mime === "image/gif" ? bytes.length <= GIF_SHOWN_AS_IS_BYTES : fits && bytes.length <= SHOWN_AS_IS_BYTES) return;
  const size = fitLongEdge({ width, height }, DISPLAY_EDGE);
  const image = fits ? new Bun.Image(bytes) : new Bun.Image(bytes).resize(size.width, size.height, { fit: "fill" });
  await atomicWrite(target, Buffer.from(await image.webp({ quality: DISPLAY_QUALITY }).bytes()));
}

export async function keepSentPicture(dir: string, bytes: Buffer, mime: string): Promise<string> {
  const extension = EXTENSIONS[mime];
  if (extension === undefined) throw new Error(`${mime} pictures cannot be sent`);
  const path = join(dir, `${createHash("sha256").update(bytes).digest("hex")}.${extension}`);
  if (!existsSync(path)) await atomicWrite(path, bytes);
  await keepDisplayCopy(path, bytes, mime);
  return path;
}

export function shownPicturePath(path: string): string {
  const copy = displayCopyPath(path);
  return existsSync(copy) ? copy : path;
}

export function findSentPicture(data: string, file: string): string | undefined {
  if (!SENT_PICTURE_FILE.test(file)) return undefined;
  let characters: string[];
  try {
    characters = readdirSync(join(data, "media"));
  } catch {
    return undefined;
  }
  for (const character of characters.sort()) {
    const path = join(sentPicturesDir(data, character), file);
    if (existsSync(path)) return path;
  }
  return undefined;
}
