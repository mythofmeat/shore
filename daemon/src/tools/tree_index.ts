import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

export type IndexedEntry =
  | { path: string; kind: "file"; mode: number; size: number; mtime: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; target: string };

export async function indexTree(root: string, skip: readonly string[] = []): Promise<IndexedEntry[] | null> {
  const skipped = new Set(skip);
  const entries: IndexedEntry[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const absolute = join(root, path);
      if (skipped.has(absolute)) continue;
      let info;
      try {
        info = await lstat(absolute, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const mode = Number(info.mode & 0o7777n);
      if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", target: await readlink(absolute) });
      else if (info.isFile()) entries.push({ path, kind: "file", mode, size: Number(info.size), mtime: info.mtimeNs.toString() });
      else if (info.isDirectory()) {
        entries.push({ path, kind: "directory", mode });
        await walk(path);
      }
    }
  };
  let top;
  try {
    top = await lstat(root);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  if (!top.isDirectory()) return null;
  entries.push({ path: "", kind: "directory", mode: top.mode & 0o7777 });
  await walk("");
  return entries;
}
