import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ImageRef, Message } from "../engine/types.ts";
import { modelCopies } from "../llm/images.ts";
import { shoreLog } from "../log.ts";
import { imageBlobDir } from "./image_blobs.ts";
import { attachmentCacheDir } from "./image_cache.ts";
import { characterMediaDir } from "./media.ts";
import { pack, unpack, withStorage } from "./store.ts";

const ATTACHMENTS_DIR = "attachments";
const TOOLS_DIR = "tools";
const BLOBS_DIR = "blobs";
const MODEL_COPIES_DIR = "model";

export interface ImageMove {
  moved: number;
  removed: number;
}

export const legacyAttachmentsDir = (data: string, character: string): string =>
  join(characterMediaDir(data, character), ATTACHMENTS_DIR);

export function moveImagesToCache(data: string, cache: string): ImageMove {
  const total: ImageMove = { moved: 0, removed: 0 };
  for (const character of entriesOf(join(data, "media"))) {
    const result = moveCharacterImagesToCache(data, cache, character);
    total.moved += result.moved;
    total.removed += result.removed;
  }
  if (total.moved + total.removed > 0) {
    shoreLog.info(
      `shore: moved ${String(total.moved)} images that active conversations show into the image cache ` +
        `and deleted ${String(total.removed)} image files that nothing reads again`,
    );
  }
  return total;
}

export function moveCharacterImagesToCache(data: string, cache: string, character: string): ImageMove {
  const media = characterMediaDir(data, character);
  const tools = join(media, TOOLS_DIR);
  const legacy = join(media, ATTACHMENTS_DIR);
  const result: ImageMove = { moved: moveBlobs(join(media, BLOBS_DIR), imageBlobDir(cache, character)), removed: countFiles(tools) };
  rmSync(tools, { recursive: true, force: true });
  if (!existsSync(legacy)) return result;

  const target = attachmentCacheDir(cache, character);
  const moves = new Map<string, string>();
  withStorage(data, (db) => {
    for (const path of activeImagePaths(db, character)) {
      const name = insideDir(legacy, path);
      if (name === undefined) continue;
      const destination = join(target, name);
      if (copyAttachment(path, destination)) moves.set(path, destination);
    }
    db.transaction(() => repointActiveImages(db, character, moves))();
  });
  result.moved += moves.size;
  result.removed += countFiles(legacy) - [...moves.keys()].reduce((files, path) => files + 1 + modelCopies(path).length, 0);
  rmSync(legacy, { recursive: true, force: true });
  return result;
}

export function activeWindowPaths(db: Database, character: string): string[] {
  const prefix = `${character}/threads/`;
  const rows = db.query("SELECT path FROM state_files WHERE character = ?1 AND substr(path, 1, length(?2)) = ?2")
    .all(character, prefix) as { path: string }[];
  return rows
    .map((row) => row.path)
    .filter((path) => {
      const rest = path.slice(prefix.length).split("/");
      return rest.length === 2 && rest[0] !== "" && rest[1] === "active.jsonl";
    })
    .sort();
}

export function activeImagePaths(db: Database, character: string): string[] {
  const paths = new Set<string>();
  for (const window of activeWindowPaths(db, character)) {
    for (const line of windowLines(db, window)) {
      for (const image of imagesOf(line.text)) paths.add(image.path);
    }
  }
  return [...paths].sort();
}

export function repointActiveImages(db: Database, character: string, moves: ReadonlyMap<string, string>): number {
  if (moves.size === 0) return 0;
  let changed = 0;
  for (const window of activeWindowPaths(db, character)) {
    for (const line of windowLines(db, window)) {
      let text = line.text;
      for (const image of new Set(imagesOf(line.text).map((ref) => ref.path))) {
        const to = moves.get(image);
        if (to !== undefined) text = text.replaceAll(JSON.stringify(image), JSON.stringify(to));
      }
      if (text === line.text) continue;
      line.write(text);
      changed += 1;
    }
  }
  return changed;
}

export function copyAttachment(from: string, to: string): boolean {
  if (statSync(from, { throwIfNoEntry: false })?.isFile() !== true) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  for (const copy of modelCopies(from)) {
    const destination = join(dirname(to), MODEL_COPIES_DIR, `${basename(to)}${copy.slice(copy.lastIndexOf("."))}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(copy, destination);
  }
  return true;
}

function moveBlobs(from: string, to: string): number {
  const names = entriesOf(from).filter((name) => statSync(join(from, name), { throwIfNoEntry: false })?.isFile() === true);
  if (names.length > 0) mkdirSync(to, { recursive: true });
  for (const name of names) copyFileSync(join(from, name), join(to, name));
  rmSync(from, { recursive: true, force: true });
  return names.length;
}

export function insideDir(parent: string, path: string): string | undefined {
  return path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : undefined;
}

interface WindowLine {
  text: string;
  write(text: string): void;
}

function windowLines(db: Database, path: string): WindowLine[] {
  const collection = db.query("SELECT 1 FROM state_collections WHERE path = ?1").get(path);
  if (collection !== null) {
    const rows = db.query("SELECT seq, content FROM state_lines WHERE path = ?1 ORDER BY seq").all(path) as { seq: number; content: Uint8Array }[];
    return rows.map((row) => ({
      text: unpack(row.content),
      write: (text) => db.query("UPDATE state_lines SET content = ?1 WHERE path = ?2 AND seq = ?3").run(pack(text), path, row.seq),
    }));
  }
  const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(path) as { content: Uint8Array } | null;
  if (row === null) return [];
  const lines = unpack(row.content).split("\n");
  return lines.map((text, index) => ({
    text,
    write: (replacement) => {
      lines[index] = replacement;
      db.query("UPDATE state_files SET content = ?1 WHERE path = ?2").run(pack(lines.join("\n")), path);
    },
  }));
}

function imagesOf(line: string): ImageRef[] {
  if (line.trim() === "") return [];
  let message: Partial<Message>;
  try {
    message = JSON.parse(line) as Partial<Message>;
  } catch {
    return [];
  }
  return Array.isArray(message.images) ? message.images.filter((image) => typeof image?.path === "string") : [];
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function countFiles(dir: string): number {
  let files = 0;
  for (const name of entriesOf(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true) files += countFiles(path);
    else if (stat?.isFile() === true) files += 1;
  }
  return files;
}
