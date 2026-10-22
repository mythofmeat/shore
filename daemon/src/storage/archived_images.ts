import type { Database } from "bun:sqlite";

import { CHARACTER_ARCHIVES_SQL } from "../engine/history_store.ts";
import { shoreLog } from "../log.ts";
import { imageCacheFor } from "./image_blobs.ts";
import { ImageLocator, imageDirsFor, loadedImage, storedImage, type Location, type StoredImageRef } from "./image_locations.ts";
import { pack, withStorage } from "./store.ts";

const DONE = "shore/archived-pictures-by-root-with-workspace";

export type ArchivedImageCounts = Record<Location, number>;

const IMAGE_ROWS = [
  ["history_messages", "SELECT m.rowid AS id, m.character, m.images FROM history_messages m WHERE m.images IS NOT NULL"],
  ["history_alternatives", "SELECT a.rowid AS id, m.character, a.images FROM history_alternatives a JOIN history_messages m ON m.id = a.message_id WHERE a.images IS NOT NULL"],
] as const;

function parsed(images: string): StoredImageRef[] | undefined {
  try {
    const value: unknown = JSON.parse(images);
    return Array.isArray(value) ? value as StoredImageRef[] : undefined;
  } catch {
    return undefined;
  }
}

interface ImageRow {
  table: (typeof IMAGE_ROWS)[number][0];
  id: number;
  character: string;
  images: StoredImageRef[];
}

function archivedImageRows(db: Database, character?: string): ImageRow[] {
  return IMAGE_ROWS.flatMap(([table, select]) => {
    const rows = character === undefined
      ? db.query(select).all()
      : db.query(`${select} AND ${CHARACTER_ARCHIVES_SQL.replaceAll("character", "m.character")}`).all(character);
    return (rows as { id: number; character: string; images: string }[]).flatMap((row) => {
      const images = parsed(row.images);
      return images === undefined ? [] : [{ table, id: row.id, character: row.character, images }];
    });
  });
}

function isPathRef(image: StoredImageRef): boolean {
  return image.root === undefined && typeof image.path === "string" && image.path !== "";
}

export function archivedImagePaths(db: Database, data: string, character: string): string[] {
  const paths = archivedImageRows(db, character).flatMap((row) => row.images.map((image) => loadedImage(image, imageDirsFor(data, row.character)).path));
  return [...new Set(paths.filter((path) => path !== ""))].sort();
}

export function rewriteArchivedImages(db: Database, rewrite: (image: StoredImageRef, archive: string) => StoredImageRef, character?: string): void {
  const changed = new Set<string>();
  for (const row of archivedImageRows(db, character)) {
    const next = row.images.map((image) => rewrite(image, row.character));
    if (next.every((image, index) => image === row.images[index])) continue;
    db.query(`UPDATE ${row.table} SET images = ?1 WHERE rowid = ?2`).run(JSON.stringify(next), row.id);
    changed.add(row.character);
  }
  const bump = db.query(`INSERT INTO history_archive_revision(character, revision) VALUES (?1, 1)
    ON CONFLICT(character) DO UPDATE SET revision = revision + 1`);
  for (const key of changed) bump.run(key);
}

export function repointArchivedImageRows(db: Database, data: string, character?: string): ArchivedImageCounts {
  const locator = new ImageLocator(imageDirsFor(data, ""));
  const counts: ArchivedImageCounts = { kept: 0, repointed: 0, missing: 0 };
  rewriteArchivedImages(db, (image, archive) => {
    if (!isPathRef(image)) return image;
    const located = locator.locate(image);
    counts[located.location] += 1;
    return storedImage(located.image, imageDirsFor(data, archive));
  }, character);
  return counts;
}

export function repointArchivedImages(data: string): ArchivedImageCounts | undefined {
  if (withStorage(data, (db) => db.query("SELECT 1 FROM state_files WHERE path = ?1").get(DONE)) !== null) return undefined;
  const counts = withStorage(data, (db) => db.transaction(() => {
    const repointed = repointArchivedImageRows(db, data);
    db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(DONE, pack("done"));
    return repointed;
  })());
  if (counts.kept + counts.repointed + counts.missing > 0) {
    shoreLog.info(
      `shore: archived pictures now point into the data, cache and workspace dirs relative to them, so moving those dirs keeps them working: ` +
        `${String(counts.kept)} were where the archive said, ${String(counts.repointed)} were found under ${data} or ${imageCacheFor(data) ?? "the image cache"} and repointed, ` +
        `${String(counts.missing)} can't be found there and keep their old path`,
    );
  }
  return counts;
}
