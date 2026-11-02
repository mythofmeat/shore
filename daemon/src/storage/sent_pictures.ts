import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../engine/atomic.ts";
import { isVideoFile } from "../engine/embeds.ts";
import { fitLongEdge } from "../llm/image_tokens.ts";
import { shoreLog } from "../log.ts";
import { characterMediaDir } from "./media.ts";

export const DISPLAY_EDGE = 1600;
const DISPLAY_QUALITY = 85;
const WEBP_ANIMATION_FLAG = 0x02;
const SHOWN_AS_IS_BYTES = 1024 * 1024;
const MOVING_SHOWN_AS_IS_BYTES = 8 * 1024 * 1024;
export const MAX_SENT_VIDEO_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };

export const SENT_PICTURE_FILE = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp|mp4|webm)$/;

export const sentPicturesDir = (data: string, character: string): string => join(characterMediaDir(data, character), "sent");

export function displayCopyPath(path: string): string {
  return join(dirname(path), "display", basename(path).replace(/\.[a-z0-9]+$/, ".webp"));
}

export function isSentPicture(path: string): boolean {
  return SENT_PICTURE_FILE.test(basename(path)) && basename(dirname(path)) === "sent";
}

export function isSentVideo(path: string): boolean {
  return isSentPicture(path) && isVideoFile(path);
}

function isAnimatedPng(bytes: Buffer): boolean {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const chunk = bytes.toString("latin1", at + 4, at + 8);
    if (chunk === "acTL") return true;
    if (chunk === "IDAT") return false;
    at += 12 + bytes.readUInt32BE(at);
  }
  return false;
}

function isAnimatedWebp(bytes: Buffer): boolean {
  return bytes.toString("latin1", 12, 16) === "VP8X" && ((bytes[20] ?? 0) & WEBP_ANIMATION_FLAG) !== 0;
}

function isMoving(bytes: Buffer, mime: string): boolean {
  return mime === "image/gif" || (mime === "image/png" && isAnimatedPng(bytes)) || (mime === "image/webp" && isAnimatedWebp(bytes));
}

async function writeDisplayCopy(target: string, bytes: Buffer): Promise<void> {
  const { width, height } = await new Bun.Image(bytes).metadata();
  const size = fitLongEdge({ width, height }, DISPLAY_EDGE);
  const image = size.width === width && size.height === height ? new Bun.Image(bytes) : new Bun.Image(bytes).resize(size.width, size.height, { fit: "fill" });
  await atomicWrite(target, Buffer.from(await image.webp({ quality: DISPLAY_QUALITY }).bytes()));
}

async function keepDisplayCopy(path: string, bytes: Buffer, mime: string): Promise<void> {
  const target = displayCopyPath(path);
  if (isMoving(bytes, mime) && bytes.length <= MOVING_SHOWN_AS_IS_BYTES) {
    await rm(target, { force: true });
    return;
  }
  if (existsSync(target)) return;
  const { width, height } = await new Bun.Image(bytes).metadata();
  if (!isMoving(bytes, mime) && Math.max(width, height) <= DISPLAY_EDGE && bytes.length <= SHOWN_AS_IS_BYTES) return;
  await writeDisplayCopy(target, bytes);
}

async function keepFile(dir: string, bytes: Buffer, mime: string): Promise<string> {
  const extension = EXTENSIONS[mime];
  if (extension === undefined) throw new Error(`${mime} files cannot be sent`);
  const path = join(dir, `${createHash("sha256").update(bytes).digest("hex")}.${extension}`);
  if (!existsSync(path)) await atomicWrite(path, bytes);
  return path;
}

export async function keepSentPicture(dir: string, bytes: Buffer, mime: string): Promise<string> {
  if (mime === "image/webp" && isAnimatedWebp(bytes) && bytes.length > MOVING_SHOWN_AS_IS_BYTES) {
    throw new Error(`it is ${String(bytes.length)} bytes, over the ${String(MOVING_SHOWN_AS_IS_BYTES)}-byte limit for an animated WebP`);
  }
  const path = await keepFile(dir, bytes, mime);
  await keepDisplayCopy(path, bytes, mime);
  return path;
}

export async function keepSentVideo(dir: string, bytes: Buffer, mime: string, firstFrame: () => Promise<Buffer | undefined>): Promise<string> {
  if (bytes.length > MAX_SENT_VIDEO_BYTES) throw new Error(`it is ${String(bytes.length)} bytes, over the ${String(MAX_SENT_VIDEO_BYTES)}-byte limit for videos`);
  const path = await keepFile(dir, bytes, mime);
  const poster = displayCopyPath(path);
  if (existsSync(poster)) return path;
  const frame = await firstFrame();
  if (frame !== undefined) await writeDisplayCopy(poster, frame).catch((error: unknown) => { shoreLog.warn(`shore: no poster for ${basename(path)}: ${String(error)}`); });
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
