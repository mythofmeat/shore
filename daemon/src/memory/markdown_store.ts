import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { isInside, pathComponents } from "../tools/workspace_path";
import { compareRustStrings, rustLines, rustTrim, rustTrimStart, tokenizeQuery } from "./lines";

const INTERNAL_TOP_LEVEL = [".dreams", "dreaming", "dreams.md", "memory.md"];

export type MarkdownStoreErrorKind = "io" | "path-traversal" | "not-found";

const ERROR_PREFIX: Record<MarkdownStoreErrorKind, string> = {
  io: "io",
  "path-traversal": "path traversal",
  "not-found": "not found",
};

export class MarkdownStoreError extends Error {
  readonly kind: MarkdownStoreErrorKind;

  constructor(kind: MarkdownStoreErrorKind, detail: string) {
    super(`${ERROR_PREFIX[kind]}: ${detail}`);
    this.name = "MarkdownStoreError";
    this.kind = kind;
  }
}

const traversal = (detail: string) => new MarkdownStoreError("path-traversal", detail);
const io = (e: unknown) => new MarkdownStoreError("io", (e as Error).message);

export interface MarkdownEntry {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
}

export function formatModifiedAt(when: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -when.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const ms = when.getMilliseconds();
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}` +
    (ms === 0 ? "" : `.${pad(ms, 3)}`) +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function rustExtension(fileName: string): string | undefined {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return undefined;
  return fileName.slice(idx + 1);
}

async function tryRealpath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class MarkdownMemoryStore {
  readonly #baseDir: string;

  private constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  static async open(baseDir: string): Promise<MarkdownMemoryStore> {
    try {
      if (!(await exists(baseDir))) await mkdir(baseDir, { recursive: true });
      return new MarkdownMemoryStore(await realpath(baseDir));
    } catch (e) {
      throw io(e);
    }
  }

  get baseDir(): string {
    return this.#baseDir;
  }

  async listAll(): Promise<MarkdownEntry[]> {
    const entries: MarkdownEntry[] = [];
    await this.#collect(this.#baseDir, entries);
    entries.sort((a, b) => compareRustStrings(a.path, b.path));
    return entries;
  }

  async read(relPath: string): Promise<MarkdownEntry> {
    const path = await this.#resolve(relPath);
    if (!(await exists(path))) {
      throw new MarkdownStoreError("not-found", relPath);
    }
    try {
      const content = await readFile(path, "utf8");
      return {
        path: relPath,
        content,
        size: Buffer.byteLength(content, "utf8"),
        modifiedAt: formatModifiedAt((await stat(path)).mtime),
      };
    } catch (e) {
      throw io(e);
    }
  }

  async write(relPath: string, content: string): Promise<void> {
    const path = await this.#resolve(relPath);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    } catch (e) {
      throw io(e);
    }
  }

  async delete(relPath: string): Promise<void> {
    const path = await this.#resolve(relPath);
    if (!(await exists(path))) {
      throw new MarkdownStoreError("not-found", relPath);
    }
    try {
      await unlink(path);
    } catch (e) {
      throw io(e);
    }
    const parent = dirname(path);
    if (parent !== this.#baseDir) {
      await rmdir(parent).catch(() => {});
    }
  }

  async searchText(query: string): Promise<MarkdownEntry[]> {
    const q = query.toLowerCase();
    const terms = tokenizeQuery(q);
    const scored: Array<{ score: number; entry: MarkdownEntry }> = [];
    for (const entry of await this.listAll()) {
      const score = entrySearchScore(entry, q, terms);
      if (score > 0) scored.push({ score, entry });
    }
    scored.sort(
      (a, b) => b.score - a.score || compareRustStrings(a.entry.path, b.entry.path),
    );
    return scored.map((s) => s.entry);
  }

  async #collect(dir: string, entries: MarkdownEntry[]): Promise<void> {
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw io(e);
    }

    for (const child of children) {
      const path = join(dir, child.name);
      if (this.#isInternalTopLevel(path)) continue;

      if (child.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(path);
        } catch (e) {
          throw io(e);
        }
        if (!isInside(canonical, this.#baseDir)) {
          throw traversal(`symlink escapes memory directory: ${path}`);
        }
        if ((await stat(canonical)).isDirectory()) continue;
      }

      if (child.isDirectory()) {
        await this.#collect(path, entries);
        continue;
      }
      if (rustExtension(child.name) !== "md") continue;

      let content: string;
      let modified: Date;
      try {
        content = await readFile(path, "utf8");
        modified = (await stat(path)).mtime;
      } catch (e) {
        throw io(e);
      }
      entries.push({
        path: relative(this.#baseDir, path).split(sep).join("/"),
        content,
        size: Buffer.byteLength(content, "utf8"),
        modifiedAt: formatModifiedAt(modified),
      });
    }
  }

  #isInternalTopLevel(path: string): boolean {
    const rel = relative(this.#baseDir, path);
    const first = rel.split(sep)[0];
    if (first === undefined) return false;
    return INTERNAL_TOP_LEVEL.includes(first.toLowerCase());
  }

  async #resolve(relPath: string): Promise<string> {
    const rel = rustTrim(relPath);
    if (rel === "") throw traversal("empty path");

    for (const component of pathComponents(rel)) {
      if (component === "..") throw traversal("path traversal (..) not allowed");
      if (component === "/") throw traversal("absolute paths not allowed");
    }

    const resolved = join(this.#baseDir, rel);
    await this.#ensureInside(resolved);
    return resolved;
  }

  async #ensureInside(resolved: string): Promise<void> {
    const canonical = await tryRealpath(resolved);
    if (canonical !== undefined) {
      if (!isInside(canonical, this.#baseDir)) {
        throw traversal("resolved path escapes memory directory");
      }
      return;
    }

    let ancestor = resolved;
    for (;;) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return;
      const canonicalParent = await tryRealpath(parent);
      if (canonicalParent !== undefined) {
        if (!isInside(canonicalParent, this.#baseDir)) {
          throw traversal("resolved path escapes memory directory");
        }
        return;
      }
      ancestor = parent;
    }
  }
}

function entrySearchScore(entry: MarkdownEntry, query: string, terms: string[]): number {
  const path = entry.path.toLowerCase();
  const content = entry.content.toLowerCase();
  const title = (
    rustLines(entry.content).find((line) => rustTrimStart(line).startsWith("#")) ?? ""
  ).toLowerCase();

  let score = 0;
  if (path.includes(query)) score += 50;
  if (title.includes(query)) score += 40;
  if (content.includes(query)) score += 30;

  for (const term of terms) {
    if (path.includes(term)) score += 12;
    if (title.includes(term)) score += 10;
    if (content.includes(term)) score += 4;
  }

  return score;
}
