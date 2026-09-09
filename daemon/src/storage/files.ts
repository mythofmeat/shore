import { basename, dirname, relative, sep } from "node:path";
import { deleteState, readState, writeState, withStorage } from "./store.ts";

export function fileScope(path: string): { data: string; key: string; character: string } {
  const at = Math.max(...["threads", "active_prompt", "backups"].map((name) => path.lastIndexOf(`${sep}${name}${sep}`)));
  const threadsAt = path.lastIndexOf(`${sep}threads${sep}`);
  const rootAt = threadsAt === -1 ? at : threadsAt;
  const characterDir = rootAt === -1 ? dirname(path) : path.slice(0, rootAt);
  const data = dirname(characterDir);
  return { data, key: relative(data, path), character: basename(characterDir) };
}

export function readDurable(path: string): string {
  const scope = fileScope(path);
  const value = readState(scope.data, scope.key, scope.character);
  if (value === undefined) throw Object.assign(new Error(`No stored file: ${path}`), { code: "ENOENT" });
  return value;
}

export function writeDurable(path: string, content: string): void {
  const scope = fileScope(path);
  writeState(scope.data, scope.key, content, scope.character);
}

export function deleteDurable(path: string): void {
  const scope = fileScope(path);
  deleteState(scope.data, scope.key);
}

export function durableExists(path: string): boolean {
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

export function listDurableFiles(directory: string): string[] {
  const scope = fileScope(`${directory}/.listing`);
  const prefix = scope.key.slice(0, -".listing".length);
  return withStorage(scope.data, (db) => {
    const rows = db.query("SELECT path FROM state_files WHERE substr(path, 1, length(?1)) = ?1 ORDER BY path").all(prefix) as { path: string }[];
    return [...new Set(rows.map((row) => row.path.slice(prefix.length).split("/")[0] as string))];
  });
}
