/**
 * The markdown memory store — a character's memory as inspectable files.
 *
 * Ported from `crates/daemon/src/memory/markdown_store.rs`, pinned by
 * `tests/memory_fixtures/markdown_parity.json`.
 *
 * There is no database. Memory is `characters/{name}/workspace/memory/` and
 * every entry is a plain markdown file — no frontmatter, no index, no schema.
 * The model chooses the filenames and the folder structure; this module only
 * confines them to the directory and reads them back.
 *
 * # What is deliberately invisible
 *
 * `listAll` and therefore `searchText` skip four names at the *top level*:
 * `.dreams/`, `dreaming/`, `dreams.md` and `memory.md`. Those are the dreaming
 * subsystem's own scratch space and the curated index, and surfacing them in
 * retrieval would feed the model its own notes about its notes. The check
 * looks at the first path component only, so `topics/dreams.md` is an ordinary
 * memory file — the fixture pins both halves of that.
 *
 * `read`, `write` and `delete` do *not* apply the filter. `MEMORY.md` has to
 * be writable by name; it is only retrieval that hides it.
 *
 * # Confinement
 *
 * Every entry point routes its caller-supplied path through {@link resolve},
 * which refuses `..`, absolute paths, and anything whose resolved location
 * leaves the store — including via a symlink, checked against the nearest
 * existing ancestor so a file that does not exist yet cannot skip the check.
 * `listAll` re-checks on the way out, since a symlink planted inside the store
 * is reached by walking rather than by naming.
 */

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
import { compareRustStrings, rustLines } from "./lines";

/**
 * Top-level names retrieval never returns.
 *
 * The Rust compared with `to_ascii_lowercase`. Plain `toLowerCase` is used
 * here because the two cannot disagree while every name in this list is ASCII:
 * a lowercase form only reaches one of them if the input was ASCII already.
 * Adding a non-ASCII name would break that, and would need the narrower fold.
 */
const INTERNAL_TOP_LEVEL = [".dreams", "dreaming", "dreams.md", "memory.md"];

/** Which failure this is. The Rust had one enum variant per case. */
export type MarkdownStoreErrorKind = "io" | "path-traversal" | "not-found";

const ERROR_PREFIX: Record<MarkdownStoreErrorKind, string> = {
  io: "io",
  "path-traversal": "path traversal",
  "not-found": "not found",
};

/**
 * A markdown store failure, carrying the Rust's `Display` text.
 *
 * `kind` is what callers should branch on. The rendered message is what a
 * client sees, and the traversal messages in particular are pinned by the
 * fixture — they are the only signal that a refusal was a refusal rather than
 * a missing file.
 */
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

/** One memory file. */
export interface MarkdownEntry {
  /** Path relative to the store root, e.g. `topics/gaming/doom.md`. */
  path: string;
  /** The whole file. */
  content: string;
  /** Size in *bytes*, which for non-ASCII content is not the string length. */
  size: number;
  /** Last modified, RFC 3339 with the local offset. */
  modifiedAt: string;
}

/**
 * `chrono`'s `DateTime::to_rfc3339` on a local timestamp.
 *
 * The fractional second follows chrono's `AutoSi`: omitted entirely when the
 * time lands on a whole second, otherwise three digits. Coarse filesystems do
 * produce whole-second mtimes, so the zero case is reachable and worth
 * matching rather than always printing `.000`.
 *
 * Deliberate divergence: chrono prints six or nine digits when the timestamp
 * has sub-millisecond precision, and JavaScript's `Date` has none to print.
 * Nothing parses this field — it is displayed — so the shape is what matters.
 */
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

/**
 * Rust's `Path::extension`, which is not "the text after the last dot".
 *
 * A name whose only dot is the first character has no extension — `.md` is a
 * dotfile, not a markdown file — and the extension is taken from the *last*
 * dot, so `notes.md.txt` is a `txt`. The comparison is case-sensitive, so
 * `README.MD` is not listed. All three are pinned by the fixture.
 */
function rustExtension(fileName: string): string | undefined {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return undefined;
  return fileName.slice(idx + 1);
}

/** `realpath`, or `undefined` when the path does not resolve. */
async function tryRealpath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

/** Whether a path exists, following symlinks — Rust's `Path::exists`. */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Filesystem-backed markdown memory for one character. */
export class MarkdownMemoryStore {
  /** Always canonical: confinement compares resolved paths on both sides. */
  readonly #baseDir: string;

  private constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  /**
   * Open the store, creating the directory if it is missing.
   *
   * The Rust also carried an `open_sync` for callers that had no runtime to
   * block on. Dropped: everything here is already async, so the split bought
   * nothing but a second copy of the same four lines.
   */
  static async open(baseDir: string): Promise<MarkdownMemoryStore> {
    try {
      if (!(await exists(baseDir))) await mkdir(baseDir, { recursive: true });
      return new MarkdownMemoryStore(await realpath(baseDir));
    } catch (e) {
      throw io(e);
    }
  }

  /** The canonical store root. */
  get baseDir(): string {
    return this.#baseDir;
  }

  /** Every `.md` file in the store, recursively, sorted by path. */
  async listAll(): Promise<MarkdownEntry[]> {
    const entries: MarkdownEntry[] = [];
    await this.#collect(this.#baseDir, entries);
    entries.sort((a, b) => compareRustStrings(a.path, b.path));
    return entries;
  }

  /**
   * Read one entry.
   *
   * `path` on the result is the caller's spelling, not the resolved one — a
   * leading `./` or surrounding whitespace comes back as it went in. That is
   * what the Rust returned and the fixture pins it; callers use the value they
   * passed, not this field, to address the file again.
   */
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

  /** Create or overwrite an entry, making parent directories as needed. */
  async write(relPath: string, content: string): Promise<void> {
    const path = await this.#resolve(relPath);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    } catch (e) {
      throw io(e);
    }
    // The Rust logged an info-level line here. The sidecar has no logger and
    // reserves `console` for failures, so a successful write stays quiet.
  }

  /**
   * Delete an entry, and its parent directory if that leaves it empty.
   *
   * The prune goes exactly one level and never touches the store root. An
   * emptied grandparent is left behind — reproduced rather than deepened,
   * because a recursive prune racing a concurrent `write` into a sibling
   * directory is a worse failure than a stray empty folder.
   */
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
      // Fails, and is ignored, whenever the directory still has anything in it.
      await rmdir(parent).catch(() => {});
    }
  }

  /**
   * Ranked text search across every entry.
   *
   * Deliberately crude — substring counting, no index, no embeddings — so that
   * markdown-only retrieval works without a shadow database to keep in sync.
   * The score itself is never returned; only the resulting order is
   * observable, which is why the fixture leans on a case where two entries tie
   * and break on path.
   */
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

  // ── internal ──────────────────────────────────────────────────────────

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

      // `readdir` reports the link itself, like Rust's `symlink_metadata`.
      if (child.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(path);
        } catch (e) {
          // A dangling link is an io failure, not a silent skip: something
          // inside the memory directory points at nothing, and quietly
          // continuing would hide it forever.
          throw io(e);
        }
        if (!isInside(canonical, this.#baseDir)) {
          throw traversal(`symlink escapes memory directory: ${path}`);
        }
        // A link to a directory inside the store is skipped rather than
        // followed — following it would walk the same files twice, or forever.
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
        // Separators normalized so the `daily/` and `images/` prefix checks in
        // `markdown_query` hold on any platform. On Linux this is a no-op.
        path: relative(this.#baseDir, path).split(sep).join("/"),
        content,
        // The Rust took size and mtime from the directory entry's own
        // metadata, which does not follow symlinks — so a linked entry
        // reported the byte length of the link *target's path*, and the link's
        // own mtime, while carrying the target's content. That is incoherent,
        // and `read` did not do it: it stats through the link and agrees with
        // the content. Both fields are taken through the link here. The only
        // case where this differs from the Rust is a symlinked entry, which
        // the fixture records and the replay checks explicitly.
        size: Buffer.byteLength(content, "utf8"),
        modifiedAt: formatModifiedAt(modified),
      });
    }
  }

  /** Whether the *first* path component is one of the hidden names. */
  #isInternalTopLevel(path: string): boolean {
    const rel = relative(this.#baseDir, path);
    const first = rel.split(sep)[0];
    if (first === undefined) return false;
    return INTERNAL_TOP_LEVEL.includes(first.toLowerCase());
  }

  /** Reject the path, or return where it lands. */
  async #resolve(relPath: string): Promise<string> {
    const rel = relPath.trim();
    if (rel === "") throw traversal("empty path");

    for (const component of pathComponents(rel)) {
      if (component === "..") throw traversal("path traversal (..) not allowed");
      if (component === "/") throw traversal("absolute paths not allowed");
    }

    // `join` normalizes, unlike Rust's `Path::join`. Safe only because the
    // scan above has already rejected every component whose normalization
    // could change where the path lands.
    const resolved = join(this.#baseDir, rel);
    await this.#ensureInside(resolved);
    return resolved;
  }

  /**
   * Refuse a resolved path that leaves the store.
   *
   * When the target does not exist — which `write` relies on — the check moves
   * up to the nearest ancestor that does. A symlinked parent directory escapes
   * exactly as well as a symlinked file, and checking only the leaf would miss
   * it. Walking off the top of the filesystem without finding anything
   * resolvable is not an error; it means the store root itself is gone, and
   * the subsequent operation reports that better than this would.
   */
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

/**
 * Split a lowercased query into scoring terms.
 *
 * Separators are everything that is neither alphanumeric nor `_`/`-`, so
 * `snake_case` and `kebab-case` survive as single terms.
 *
 * The length floor is two *bytes*, not two characters — Rust's `str::len()`.
 * That is not a typo carried across: it means a one-character multibyte term
 * like `é` passes the filter while a one-character ASCII term like `x` does
 * not, and the fixture pins a search on each.
 *
 * Exported because `markdown_query`'s excerpt picker tokenizes identically.
 * The Rust wrote the split out twice, in both files, and the two copies had to
 * agree for a hit's excerpt to contain the term it was ranked for.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .split(/[^\p{Alphabetic}\p{Nd}\p{Nl}\p{No}_-]/u)
    .filter((term) => Buffer.byteLength(term, "utf8") >= 2);
}

/**
 * Score one entry against a lowercased query and its terms.
 *
 * Path beats heading beats body, and the whole query counts for far more than
 * any single term. A heading match implies a body match — the heading is a
 * line of the body — so the reachable totals are sparser than the six weights
 * suggest, and swapping the heading and body weights is invisible on any
 * entry that matched in the heading. The fixture's eleven-entry case is built
 * around the few arrangements where it is not.
 *
 * The score itself never leaves this function, so a small numeric change to
 * any one weight cannot be observed at all. What the fixture does pin is that
 * none of the six is dropped and no pair of them is transposed.
 */
function entrySearchScore(entry: MarkdownEntry, query: string, terms: string[]): number {
  const path = entry.path.toLowerCase();
  const content = entry.content.toLowerCase();
  const title = (
    rustLines(entry.content).find((line) => line.trimStart().startsWith("#")) ?? ""
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
