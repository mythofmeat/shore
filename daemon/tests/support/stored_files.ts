import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fileScope } from "../../src/storage/files.ts";
import { collectionText, characterScope, databasePath, readEvents, unpack } from "../../src/storage/store.ts";

function stored(path: fs.PathLike): Buffer | undefined {
  const name = path instanceof URL ? fileURLToPath(path) : path.toString();
  let scope = fileScope(name);
  if (basename(dirname(name)) === "active_prompt") {
    const owner = fileScope(dirname(name));
    scope = { ...owner, key: `${owner.key}/${basename(name)}` };
  }
  if (basename(name) === "heartbeat.jsonl") {
    const { data, character } = characterScope(dirname(name));
    return Buffer.from(readEvents(data, character, "heartbeat").join("\n") + "\n");
  }
  const candidates = [scope, { data: dirname(name), key: basename(name), character: "" }];
  for (const candidate of candidates) {
    const dbPath = databasePath(candidate.data);
    if (!fs.existsSync(dbPath)) continue;
    const db = new Database(dbPath, { readonly: true });
    try {
      if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'state_files'").get() === null) continue;
      const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(candidate.key) as { content: Uint8Array } | null;
      if (row !== null) return Buffer.from(collectionText(db, candidate.key) ?? unpack(row.content));
      const prefix = `sdk_sessions/${basename(name)}/`;
      const sessions = db.query("SELECT path, content FROM state_files WHERE substr(path, 1, length(?1)) = ?1").all(prefix) as { path: string; content: Uint8Array }[];
      if (sessions.length > 0) return Buffer.from(JSON.stringify(Object.fromEntries(sessions.map((entry) => [Buffer.from(entry.path.slice(prefix.length), "base64url").toString(), JSON.parse(unpack(entry.content)) as unknown]))));
    } finally { db.close(); }
  }
  return undefined;
}

function encoded(bytes: Buffer, options?: unknown): Buffer | string {
  const encoding = typeof options === "string" ? options : (options as { encoding?: string } | null)?.encoding;
  return encoding === undefined || encoding === null ? bytes : bytes.toString(encoding as BufferEncoding);
}

export const readFile = (async (path: fs.PathLike, options?: unknown) => {
  try { return await promises.readFile(path, options as BufferEncoding); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const bytes = stored(path);
    if (bytes === undefined) throw e;
    return encoded(bytes, options);
  }
}) as typeof promises.readFile;

export const readFileSync = ((path: fs.PathLike, options?: unknown) => {
  try { return fs.readFileSync(path, options as BufferEncoding); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const bytes = stored(path);
    if (bytes === undefined) throw e;
    return encoded(bytes, options);
  }
}) as typeof fs.readFileSync;

function storedEntries(path: fs.PathLike): string[] {
  const name = path instanceof URL ? fileURLToPath(path) : path.toString();
  const scope = fileScope(`${name}/.listing`);
  const prefix = scope.key.slice(0, -".listing".length);
  if (!fs.existsSync(databasePath(scope.data))) return [];
  const db = new Database(databasePath(scope.data), { readonly: true });
  try {
    if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'state_files'").get() === null) return [];
    const rows = db.query("SELECT path FROM state_files WHERE substr(path, 1, length(?1)) = ?1").all(prefix) as { path: string }[];
    return [...new Set(rows.map((row) => row.path.slice(prefix.length).split("/")[0] as string))].filter((entry) => entry !== ".snapshot");
  } finally { db.close(); }
}

export const readdir = async (path: fs.PathLike): Promise<string[]> => {
  const saved = storedEntries(path);
  try {
    const entries = await promises.readdir(path);
    return saved.length === 0 ? entries : [...new Set([...entries, ...saved])];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || saved.length === 0) throw e;
    return saved;
  }
};

export const access = async (path: fs.PathLike, mode?: number): Promise<void> => {
  try { await promises.access(path, mode); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || (stored(path) === undefined && storedEntries(path).length === 0)) throw e;
  }
};
