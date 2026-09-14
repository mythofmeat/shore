import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type WorkspaceEntry =
  | { kind: "file"; content: string; mode: number }
  | { kind: "symlink"; target: string }
  | { kind: "directory"; mode: number };

export async function workspaceEntry(path: string): Promise<WorkspaceEntry | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
    const mode = info.mode & 0o777;
    if (info.isDirectory()) return { kind: "directory", mode };
    if (info.isFile()) return { kind: "file", content: (await readFile(path)).toString("base64"), mode };
    return null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

export async function snapshotWorkspace(root: string): Promise<Map<string, WorkspaceEntry>> {
  const entries = new Map<string, WorkspaceEntry>();
  const walk = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      if (name === ".git") continue;
      const path = join(relative, name);
      const entry = await workspaceEntry(join(root, path));
      if (entry === null) continue;
      entries.set(path, entry);
      if (entry.kind === "directory") await walk(path);
    }
  };
  await walk("");
  return entries;
}

export function sameWorkspaceEntry(a: WorkspaceEntry | null, b: WorkspaceEntry | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function restoreParent(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === path) return;
  await restoreParent(parent);
  try {
    const info = await lstat(parent);
    if (info.isDirectory()) return;
    await rm(parent, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(parent);
}

export async function restoreWorkspaceEntry(path: string, entry: WorkspaceEntry | null): Promise<void> {
  if (entry !== null) await restoreParent(path);
  const current = await workspaceEntry(path);
  if (sameWorkspaceEntry(current, entry)) return;
  if (current !== null && !(current.kind === "directory" && entry?.kind === "directory")) {
    await rm(path, { recursive: current.kind === "directory", force: true });
  }
  if (entry === null) return;
  await mkdir(dirname(path), { recursive: true });
  switch (entry.kind) {
    case "directory":
      await mkdir(path, { recursive: true });
      await chmod(path, entry.mode);
      return;
    case "symlink":
      await symlink(entry.target, path);
      return;
    case "file":
      await writeFile(path, Buffer.from(entry.content, "base64"));
      await chmod(path, entry.mode);
  }
}
