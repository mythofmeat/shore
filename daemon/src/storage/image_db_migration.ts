import type { Database } from "bun:sqlite";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";

import { CallStore } from "../call_store.ts";
import { HistoryStore } from "../engine/history_store.ts";
import { shoreLog } from "../log.ts";
import { imageBlobs, withImageReferences, type ImageBlobs } from "./image_blobs.ts";
import { databasePath, pack, unpack, withStorage } from "./store.ts";

const DONE = "shore/images-out-of-database";

export interface DatabaseImageMove {
  transcripts: number;
  captures: number;
  history: number;
}

export function moveImagesOutOfDatabase(data: string, cache: string): DatabaseImageMove | undefined {
  const path = databasePath(data);
  if (withStorage(data, (db) => db.query("SELECT 1 FROM state_files WHERE path = ?1").get(DONE)) !== null) return undefined;
  try {
    mkdirSync(cache, { recursive: true });
    accessSync(cache, constants.W_OK);
  } catch (error) {
    shoreLog.warn(`shore: the image cache at ${cache} cannot be written, so image data stays in ${path} until a later start: ${String(error)}`);
    return undefined;
  }
  const before = statSync(path).size;
  shoreLog.info(`shore: moving image data out of ${path} into the image cache; this happens once`);
  const started = performance.now();
  let moved: DatabaseImageMove;
  try {
    moved = {
      transcripts: referenceTranscriptImages(data, cache),
      captures: referenceCaptureImages(path),
      history: referenceHistoryImages(path, cache),
    };
  } catch (error) {
    shoreLog.warn(`shore: could not finish moving image data out of ${path}; what was moved stays moved and a later start does the rest: ${String(error)}`);
    return undefined;
  }
  withStorage(data, (db) => {
    db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(DONE, pack("done"));
    db.run("PRAGMA incremental_vacuum;");
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  shoreLog.info(
    `shore: moved image data out of ${String(moved.transcripts)} SDK transcript entries, ${String(moved.captures)} captures ` +
      `and ${String(moved.history)} archived message bodies in ${seconds} s: ${megabytes(before)} MB -> ${megabytes(statSync(path).size)} MB`,
  );
  return moved;
}

function referenceTranscriptImages(data: string, cache: string): number {
  return withStorage(data, (db) => {
    const transcripts = db.query("SELECT path, character FROM state_files WHERE path GLOB 'sdk_transcripts/*' ORDER BY path").all() as { path: string; character: string }[];
    const reference = db.transaction((path: string, blobs: ImageBlobs) => referenceTranscript(db, path, blobs));
    return transcripts.reduce((changed, transcript) => changed + reference(transcript.path, imageBlobs(cache, transcript.character, false)), 0);
  });
}

function referenceTranscript(db: Database, path: string, blobs: ImageBlobs): number {
  const update = db.query("UPDATE state_lines SET content = ?1 WHERE path = ?2 AND seq = ?3");
  const lines = db.query("SELECT seq, content FROM state_lines WHERE path = ?1 ORDER BY seq").all(path) as { seq: number; content: Uint8Array }[];
  let changed = 0;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(unpack(line.content));
    } catch {
      continue;
    }
    const referenced = withImageReferences(entry, blobs);
    if (referenced === entry) continue;
    update.run(pack(JSON.stringify(referenced)), path, line.seq);
    changed += 1;
  }
  return changed;
}

function referenceCaptureImages(path: string): number {
  const store = CallStore.open(path);
  try {
    return store.referenceInlineImages();
  } finally {
    store.close();
  }
}

function referenceHistoryImages(path: string, cache: string): number {
  const store = HistoryStore.open(path);
  try {
    return store.referenceInlineImages(cache);
  } finally {
    store.close();
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}
