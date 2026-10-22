import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { MAIN_THREAD } from "../config/dirs.ts";
import { HistoryStore } from "../engine/history_store.ts";
import { pictureId, pictureSha256, sha256Hex } from "../engine/picture_ids.ts";
import type { ImageRef, Message } from "../engine/types.ts";
import { extensionForMediaType, mediaTypeForPath, sniffMediaType } from "../handler/images.ts";
import { readDurable, threadFile } from "../storage/files.ts";
import type { CharacterWorkspace } from "./character_workspace.ts";
import type { ToolContext } from "./dispatch.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { ToolInput } from "./workspace.ts";
import { resolvePath } from "./workspace_path.ts";

const MIN_ID_LENGTH = 6;

interface Sighting {
  sha256: string;
  path: string;
  shown?: string;
}

function idPrefix(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]+$/.test(id) || id.length < MIN_ID_LENGTH || id.length > 64) {
    throw new InvalidArgs(`picture must be a picture's id as shown in [picture …], at least its first ${String(MIN_ID_LENGTH)} characters`);
  }
  return id;
}

function activeMessages(ctx: ToolContext): Message[] {
  let raw: string;
  try {
    raw = readDurable(threadFile(dirname(ctx.historyDbPath), ctx.characterName, ctx.thread ?? MAIN_THREAD, "active.jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as Message];
    } catch {
      return [];
    }
  });
}

function archivedPictures(ctx: ToolContext, prefix: string): { images: ImageRef[]; timestamp: string }[] {
  if (!existsSync(ctx.historyDbPath)) return [];
  const store = HistoryStore.open(ctx.historyDbPath);
  try {
    return store.shownPictures(ctx.characterName, prefix);
  } finally {
    store.close();
  }
}

function sightings(ctx: ToolContext, prefix: string): Sighting[] {
  const found: Sighting[] = [];
  const see = (images: readonly ImageRef[], shown?: string) => {
    for (const image of images) {
      if (image.embed !== undefined) continue;
      const sha256 = pictureSha256(image);
      if (sha256?.startsWith(prefix) === true) found.push({ sha256, path: image.path, ...(shown === undefined ? {} : { shown }) });
    }
  };
  see((ctx.shownPictures ?? []).toReversed());
  for (const message of activeMessages(ctx).toReversed()) {
    if (message.role === "user") see(message.images ?? [], message.timestamp);
  }
  for (const row of archivedPictures(ctx, prefix)) see(row.images, row.timestamp);
  return found;
}

function distinctLength(hashes: readonly string[]): number {
  let length = 8;
  while (length < 64 && new Set(hashes.map((hash) => hash.slice(0, length))).size < hashes.length) length += 1;
  return length;
}

function onePicture(found: readonly Sighting[], prefix: string): string {
  const hashes = [...new Set(found.map((sighting) => sighting.sha256))];
  const [only] = hashes;
  if (only === undefined) throw new ToolIoError(`no picture with the id ${prefix} was shown in this conversation or its chat logs`);
  if (hashes.length === 1) return only;
  const length = distinctLength(hashes);
  const listed = hashes.map((hash) => {
    const shown = found.find((sighting) => sighting.sha256 === hash)?.shown;
    return `${hash.slice(0, length)}${shown === undefined ? "" : ` (shown ${shown})`}`;
  });
  throw new InvalidArgs(`${prefix} matches ${String(hashes.length)} pictures: ${listed.join(", ")}; give more of the id`);
}

async function cachedCopy(found: readonly Sighting[], sha256: string): Promise<Buffer | undefined> {
  const paths = new Set(found.filter((sighting) => sighting.sha256 === sha256).map((sighting) => sighting.path));
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      continue;
    }
    if (sha256Hex(bytes) === sha256) return bytes;
  }
  return undefined;
}

function targetPath(workspaceDir: string, requested: unknown, bytes: Uint8Array, id: string): string {
  if (typeof requested !== "string" || requested.trim() === "" || requested.includes("\0")) {
    throw new InvalidArgs("path must be a non-empty string without NUL bytes");
  }
  if (/[/\\]$/.test(requested)) throw new InvalidArgs("path must name a file, not a folder");
  const mediaType = sniffMediaType(bytes);
  const extension = mediaType === undefined ? undefined : extensionForMediaType(mediaType);
  let path = requested;
  if (extension !== undefined && extname(path) === "") path = `${path}.${extension}`;
  else if (extension !== undefined && mediaTypeForPath(path) !== mediaType) {
    throw new InvalidArgs(`picture ${id} is ${String(mediaType)}, so path must end in .${extension}`);
  }
  return resolvePath(workspaceDir, path);
}

export async function handleSavePicture(args: ToolInput, ctx: ToolContext, workspace: CharacterWorkspace): Promise<string> {
  const prefix = idPrefix(args["picture"]);
  const found = sightings(ctx, prefix);
  const sha256 = onePicture(found, prefix);
  const id = pictureId(sha256);
  const bytes = await cachedCopy(found, sha256);
  if (bytes === undefined) throw new ToolIoError(`picture ${id} is no longer available: it was evicted from the image cache or its file has changed, so it can't be saved`);
  const target = targetPath(ctx.workspaceDir, args["path"], bytes, id);
  await workspace.call("mkdir", { path: dirname(target) }, ctx.signal);
  if (!await workspace.call("createFile", { path: target, data: bytes.toString("base64") }, ctx.signal)) {
    throw new ToolIoError(`${target} already exists; save the picture under another name`);
  }
  return `Saved picture ${id} to ${target}`;
}
