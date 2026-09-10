import { basename, dirname, relative, sep, join } from "node:path";
import { deleteState, readState, writeState, withStorage } from "./store.ts";

export interface StateFile { data: string; key: string; character: string }
export type DurableFile = string | StateFile;
export const threadFile = (data: string, character: string, thread: string, file: string): StateFile =>
  ({ data, character, key: `${character}/threads/${thread}/${file}` });
export function archiveFile(dbPath: string, archiveKey: string, file: string): StateFile {
  const [character = "", thread = "main"] = archiveKey.split("/");
  return threadFile(dirname(dbPath), character, thread, file);
}
export const durablePath = (file: DurableFile): string => typeof file === "string" ? file : join(file.data, file.key);
export const atPath = (file: DurableFile, path: string): StateFile => {
  const scope = fileScope(file);
  return { ...scope, key: relative(scope.data, path) };
};

export function fileScope(path: DurableFile): StateFile {
  if (typeof path !== "string") return path;
  const at = Math.max(...["threads", "active_prompt", "backups"].map((name) => path.lastIndexOf(`${sep}${name}${sep}`)));
  let threadsAt = path.lastIndexOf(`${sep}threads${sep}`);
  while (threadsAt !== -1) {
    const tail = path.slice(threadsAt + `${sep}threads${sep}`.length).split(sep);
    if (tail.length >= 2 && ["active.jsonl", "compaction-checkpoint.json", "backups", "active_prompt", "deferred_edits.jsonl", ".listing"].includes(tail[1] ?? "")) break;
    threadsAt = threadsAt === 0 ? -1 : path.lastIndexOf(`${sep}threads${sep}`, threadsAt - 1);
  }
  const rootAt = threadsAt === -1 ? at : threadsAt;
  const characterDir = rootAt === -1 ? dirname(path) : path.slice(0, rootAt);
  const data = dirname(characterDir);
  return { data, key: relative(data, path), character: basename(characterDir) };
}

export function readDurable(path: DurableFile): string {
  const scope = fileScope(path);
  const value = readState(scope.data, scope.key, scope.character);
  if (value === undefined) throw Object.assign(new Error(`No stored file: ${durablePath(path)}`), { code: "ENOENT" });
  return value;
}

export function writeDurable(path: DurableFile, content: string): void {
  const scope = fileScope(path);
  writeState(scope.data, scope.key, content, scope.character);
}

export function deleteDurable(path: DurableFile): void {
  const scope = fileScope(path);
  deleteState(scope.data, scope.key);
}

export function durableExists(path: DurableFile): boolean {
  try { readDurable(path); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export function deleteThreadState(data: string, character: string, thread: string): void {
  const prefix = `${character}/threads/${thread}/`;
  withStorage(data, (db) => db.query("DELETE FROM state_files WHERE character = ?1 AND substr(path, 1, length(?2)) = ?2").run(character, prefix));
}

export function listDurableFiles(directory: DurableFile): string[] {
  const scope = fileScope(typeof directory === "string" ? `${directory}/.listing` : { ...directory, key: `${directory.key}/.listing` });
  const prefix = scope.key.slice(0, -".listing".length);
  return withStorage(scope.data, (db) => {
    const rows = db.query("SELECT path FROM state_files WHERE substr(path, 1, length(?1)) = ?1 ORDER BY path").all(prefix) as { path: string }[];
    return [...new Set(rows.map((row) => row.path.slice(prefix.length).split("/")[0] as string))];
  });
}
