/**
 * Workspace filesystem tools — read, edit, search, delete, git.
 *
 * Ported from `crates/daemon/src/tools/workspace.rs`, pinned by
 * `tests/tools_fixtures/workspace_parity.json`.
 *
 * These give the character access to a real filesystem workspace
 * (`{character}/workspace/`). `read` doubles as directory listing (a directory
 * path returns its entries), and `edit` doubles as file creation (`content`
 * writes a whole file, `edits` replaces text within one). `git` is the only
 * process-spawning tool: the workspace is a git repository and the memory
 * passes commit their own changes there.
 *
 * The confinement boundary itself is not here — `resolvePath` and its
 * component scan live in `workspace_path.ts`, which was ported ahead of this
 * module because `subagent.ts` needed it. Every handler below routes its
 * caller-supplied path through it before touching the filesystem.
 *
 * # Byte offsets became code-point offsets
 *
 * The Rust excerpt window is described in *characters* but computed in *bytes*:
 * `find_case_insensitive_match` returns byte offsets, `excerpt_line` subtracts
 * a byte-counted leading-whitespace length from them, and only then converts to
 * a `chars().count()`. Reproducing that in TypeScript would mean carrying a
 * third unit — UTF-16 code units — alongside the other two.
 *
 * Instead every offset in this module is a **code-point index**, uniformly.
 * That is not an approximation: the byte→code-point map is monotonic, and every
 * operation the Rust performs on these offsets (subtracting the leading-
 * whitespace length, clamping to the trimmed length, counting the characters
 * between two of them, stepping back N characters) is preserved by it. The one
 * thing that would break — comparing an offset in one unit against a length in
 * another — never happens, because there is only one unit left.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { Embedder } from "../llm/embed";
import { compareRustStrings, rustLines, rustTrim, rustTrimEnd, rustTrimStart } from "../memory/lines";
import { truncateChars } from "../memory/markdown_query";
import {
  displayPathFor,
  hybridSearch,
  type HybridMode,
  type RetrievalConfig,
} from "../memory/workspace_index";
import { InvalidArgs, ToolIoError } from "./errors";
import {
  isInside,
  normalizePromptVisiblePath,
  PathError,
  resolvePath,
  resolveRoots,
} from "./workspace_path";

// ── Constants ───────────────────────────────────────────────────────────

const SEARCH_DEFAULT_MAX_RESULTS = 20;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_EXCERPT_CHARS = 1_200;

/** Most of the file quoted back when an `edits` `old_string` fails to match. */
const EDIT_SNIPPET_CHARS = 800;

/**
 * `[retrieval]`'s defaults, for the callers that pass no config.
 *
 * The Rust reached these through `RetrievalConfig::default()`; the search path
 * clones the caller's config or falls back to this exact table, and
 * `max_file_bytes` is the only field the lexical scan reads.
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxFileBytes: 1_048_576,
  maxIndexedFiles: 5_000,
  maxTotalIndexedBytes: 268_435_456,
  maxEmbedCharsPerFile: 8_000,
  binary: "skip",
};

// ── JSON argument access ────────────────────────────────────────────────

/**
 * Tool input as the dispatch layer hands it over: whatever the model emitted,
 * already parsed but not yet trusted.
 */
export type ToolInput = Record<string, unknown>;

/**
 * `Value::as_str`: the string, or `undefined` for any other JSON type.
 *
 * A wrong-typed argument reads as *absent* rather than as an error throughout
 * these handlers, which is what makes `{"content": 5}` fall through to the
 * "pass content or edits" message instead of a type complaint. Faithful, and
 * the fixture pins it.
 */
function asStr(input: ToolInput, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * `Value::as_u64`: a non-negative integer that fits in 64 bits.
 *
 * `serde_json` stores an unsuffixed `5` as an integer and `5.0` as a float, and
 * only the former answers `as_u64`. JavaScript has one number type, so the
 * integer test is explicit — otherwise `offset: 1.5` would round into a
 * silently different read window instead of falling back to the default.
 */
function asU64(input: ToolInput, field: string): number | undefined {
  const value = input[field];
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** `Value::as_bool`: the boolean, or `undefined` for any other JSON type. */
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** `Value::as_array`: the array, or `undefined` for any other JSON type. */
function asArray(input: ToolInput, field: string): unknown[] | undefined {
  const value = input[field];
  return Array.isArray(value) ? value : undefined;
}

// ── Path helpers ────────────────────────────────────────────────────────

/**
 * Resolve a path that is allowed to name a *directory*, including the
 * workspace root itself.
 *
 * {@link resolvePath} refuses a bare `workspace` or `memory` because a file
 * tool needs a file; a listing or a search scope does not, so this one accepts
 * them and hands back the root. An absent, empty or `"."` path is the workspace
 * root — the case that makes a bare `read` the root listing.
 *
 * The `"."` arm is a shortcut, not a rule: `resolvePath` would resolve `.` to
 * `<ws>/.`, which every consumer here treats identically (`readdir` opens the
 * same directory, and `displayPathFor` drops the `.` component before
 * comparing). Mutation testing accordingly cannot kill it. It stays because
 * naming the root is what the caller meant, and `<ws>/.` is a path that only
 * happens to work.
 */
function resolveListPath(workspaceDir: string, relative: string | undefined): string {
  if (workspaceDir === "") throw new PathError("invalid args: workspace not configured");

  if (relative === undefined || relative === "" || relative === ".") return workspaceDir;

  const [base, stripped] = resolveRoots(workspaceDir, relative);
  if (stripped === "") return base;
  return resolvePath(workspaceDir, relative);
}

/**
 * Refuse a path whose first component is `.git`.
 *
 * `.gitignore`, `.gitattributes` and anything in a subdirectory are unaffected
 * — only an exact leading `.git` component, after an optional `workspace/`
 * prefix, is blocked.
 *
 * The component split here is Unix-only, unlike `pathComponents` in
 * `workspace_path.ts`, which also treats `\` as a separator. That module widens
 * the rule deliberately, because there it can only refuse *more* paths at a
 * confinement boundary. Here it would refuse a file legitimately named
 * `.git\notes` — a perfectly ordinary filename on Linux, and not a git internal
 * — while preventing no escape whatsoever, since the `\` is a literal character
 * in the name either way. Widening a guard that is about one directory *name*
 * buys nothing and costs a real file.
 */
function rejectGitInternalPath(pathStr: string): void {
  const trimmed = pathStr.startsWith("workspace/")
    ? pathStr.slice("workspace/".length)
    : pathStr;

  // Rust walks `Path::components()` and stops at the first one that is not a
  // `CurDir`: a leading `/` (RootDir) or `..` (ParentDir) returns Ok, leaving
  // the escape for `resolvePath` to reject with its own message.
  if (trimmed.startsWith("/")) return;
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return;
    if (part === ".git") throw new InvalidArgs("writing to .git/ is not allowed");
    return;
  }
}

// ── Excerpts ────────────────────────────────────────────────────────────

/**
 * Locate `queryLower` in `line`, case-insensitively, and report where the match
 * sits in the *original* text.
 *
 * Folding can change a string's length, so the offset found in the folded text
 * does not address the original. The walk below re-derives the mapping by
 * folding one character at a time and tracking how far each one advances the
 * folded cursor — the same thing the Rust does, in code points rather than
 * bytes (see the module header).
 *
 * Returns `[start, end)` as code-point indices into `line`.
 */
export function findCaseInsensitiveMatch(
  line: string,
  queryLower: string,
): [number, number] | undefined {
  const folded = [...line.toLowerCase()];
  const query = [...queryLower];
  const foldedStart = indexOfCodePoints(folded, query);
  if (foldedStart === undefined) return undefined;
  const foldedEnd = foldedStart + query.length;

  let foldedPos = 0;
  let originalStart: number | undefined;
  let originalEnd: number | undefined;

  let originalIdx = 0;
  for (const ch of line) {
    const charFoldedStart = foldedPos;
    foldedPos += [...ch.toLowerCase()].length;
    const charFoldedEnd = foldedPos;

    // The upper bound and the break are redundant with each other, and mutation
    // testing kills neither on its own: the break fires on the last character
    // of the match, so the first character *past* it is never examined, and
    // relaxing `< foldedEnd` to `<= foldedEnd` therefore has nothing to admit.
    // Both are kept — together they say "this character overlaps the match, and
    // we are done once it ends", which is the invariant; either alone leans on
    // the other to be true.
    if (charFoldedEnd > foldedStart && charFoldedStart < foldedEnd) {
      originalStart ??= originalIdx;
      originalEnd = originalIdx + 1;
      if (charFoldedEnd >= foldedEnd) break;
    }
    originalIdx += 1;
  }

  return [originalStart ?? 0, originalEnd ?? [...line].length];
}

/** `str::find` over code-point arrays. Returns the index of the first match. */
function indexOfCodePoints(haystack: string[], needle: string[]): number | undefined {
  if (needle.length === 0) return 0;
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return undefined;
}

/**
 * A single line, trimmed, with up to {@link SEARCH_EXCERPT_CHARS} characters of
 * context centred on the match and `...` marking either cut.
 *
 * The context is split evenly, then each half donates whatever it could not use
 * to the other — a match near the start of a line still gets a full window, it
 * just all lands after the match.
 *
 * `rawMatchStart` / `rawMatchEnd` are code-point indices into the *untrimmed*
 * line, as {@link findCaseInsensitiveMatch} returns them.
 */
export function excerptLine(line: string, rawMatchStart: number, rawMatchEnd: number): string {
  const trimmedStart = rustTrimStart(line);
  const leadingTrimmed = [...line].length - [...trimmedStart].length;
  const trimmed = [...rustTrimEnd(trimmedStart)];

  const matchStart = Math.min(Math.max(rawMatchStart - leadingTrimmed, 0), trimmed.length);
  const matchEnd = Math.max(
    Math.min(Math.max(rawMatchEnd - leadingTrimmed, 0), trimmed.length),
    matchStart,
  );

  const matchChars = matchEnd - matchStart;
  const availableBefore = matchStart;
  const availableAfter = trimmed.length - matchEnd;
  const contextChars = Math.max(SEARCH_EXCERPT_CHARS - matchChars, 0);
  const halfContextChars = Math.floor(contextChars / 2);

  let beforeChars = Math.min(halfContextChars, availableBefore);
  let afterChars = Math.min(Math.max(contextChars - beforeChars, 0), availableAfter);

  // Whatever the "before" half could not spend, the "after" half takes.
  const unusedAfter = Math.max(contextChars - (beforeChars + afterChars), 0);
  if (unusedAfter > 0) {
    beforeChars += Math.min(Math.max(availableBefore - beforeChars, 0), unusedAfter);
  }

  // The reverse donation, which cannot change anything and is kept only because
  // the Rust has it. `unusedAfter > 0` above already implies `afterChars ===
  // availableAfter` — the surplus exists precisely because the text after the
  // match ran out — so `availableAfter - afterChars` is zero here whenever this
  // branch is entered at all. Mutation testing confirms it: deleting the block
  // changes no excerpt in the fixture, and no input can make it.
  const unusedBefore = Math.max(contextChars - (beforeChars + afterChars), 0);
  if (unusedBefore > 0) {
    afterChars += Math.min(Math.max(availableAfter - afterChars, 0), unusedBefore);
  }

  const excerptStart = Math.max(matchStart - beforeChars, 0);
  const excerptEnd = Math.min(matchEnd + afterChars, trimmed.length);

  let excerpt = "";
  if (excerptStart > 0) excerpt += "...";
  excerpt += trimmed.slice(excerptStart, excerptEnd).join("");
  if (excerptEnd < trimmed.length) excerpt += "...";
  return excerpt;
}

/** A line cut to the excerpt budget, marking the cut. */
function truncateExcerptLine(line: string): string {
  const count = [...line].length;
  if (count <= SEARCH_EXCERPT_CHARS) return line;
  return `${truncateChars(line, SEARCH_EXCERPT_CHARS)}...`;
}

// ── read ────────────────────────────────────────────────────────────────

/**
 * Read a file's contents, or list a directory's entries.
 *
 * The path decides which: a file is read, a directory is listed, and an omitted
 * path lists the workspace root. That is why `path` is optional and why a
 * missing path cannot be an error — a bare `read` is the root listing that
 * `list_files` used to serve.
 */
export async function handleRead(input: ToolInput, workspaceDir: string): Promise<unknown> {
  const pathStr = asStr(input, "path");
  if (pathStr === undefined) return await listDirectory(workspaceDir, undefined);

  const path = resolvePath(workspaceDir, pathStr);

  if (await isDir(path)) return await listDirectory(workspaceDir, pathStr);

  if (!(await exists(path))) throw new ToolIoError(`file not found: ${pathStr}`);
  if (!(await isFile(path))) {
    throw new InvalidArgs(`${pathStr} is neither a file nor a directory`);
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (e) {
    throw new ToolIoError(ioMessage(e));
  }

  // `split('\n')`, not `lines()`: a file ending in a newline has a final empty
  // line, and `total_lines` counts it. Switching to `lines()` here would change
  // every line count the model has been reading.
  const lines = content.split("\n");
  const totalLines = lines.length;

  // The `?? 1` is the documented default rather than a load-bearing one: a
  // default of 0 would subtract to -1 and be floored back to 0 by the same
  // clamp. Written as 1 because 1 is what the schema tells the model.
  const offset = Math.min(Math.max((asU64(input, "offset") ?? 1) - 1, 0), totalLines);
  const limit = asU64(input, "limit") ?? totalLines;
  const end = Math.min(offset + limit, totalLines);

  const result: Record<string, unknown> = {
    path: pathStr,
    content: lines.slice(offset, end).join("\n"),
    total_lines: totalLines,
  };

  if (offset > 0 || end < totalLines) {
    result.offset = offset + 1;
    result.returned_lines = end - offset;
    if (end < totalLines) {
      // An en dash, as the Rust wrote it.
      result.note =
        `Showing lines ${offset + 1}–${end} of ${totalLines}. ` +
        `Use offset=${end + 1} to continue.`;
    }
  }

  return result;
}

/**
 * Flat listing of a directory's entries, name-sorted.
 *
 * Reached through {@link handleRead} when the resolved path is a directory, or
 * when no path was given at all. A directory that does not exist is not an
 * error: the workspace is created lazily, and "empty" is the honest answer.
 */
async function listDirectory(
  workspaceDir: string,
  pathStr: string | undefined,
): Promise<unknown> {
  const dir = resolveListPath(workspaceDir, pathStr);

  if (!(await exists(dir))) {
    return { entries: [], note: "directory does not exist yet" };
  }
  if (!(await isDir(dir))) {
    throw new InvalidArgs(`${pathStr ?? "."} is not a directory`);
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    throw new ToolIoError(ioMessage(e));
  }

  const entries: { name: string; type: string; size: number }[] = [];
  for (const name of names) {
    // `DirEntry::metadata` does not traverse symlinks, so a link is reported by
    // its own type and its own length — never as the directory it points at,
    // which would invite a listing of somewhere outside the workspace.
    let meta;
    try {
      meta = await lstat(join(dir, name));
    } catch (e) {
      throw new ToolIoError(ioMessage(e));
    }
    entries.push({
      name,
      type: meta.isDirectory() ? "directory" : "file",
      size: meta.size,
    });
  }

  entries.sort((a, b) => compareRustStrings(a.name, b.name));
  return { entries };
}

// ── edit ────────────────────────────────────────────────────────────────

/**
 * Create or overwrite a file (`content`), or replace text within an existing
 * one (`edits`).
 *
 * The two modes are mutually exclusive. `edits` deliberately still fails on a
 * missing file rather than creating it: an unmatched path is far more often a
 * mistake than an intent to create, and `content` is the unambiguous way to say
 * "make this file".
 */
export async function handleEdit(input: ToolInput, workspaceDir: string): Promise<unknown> {
  const pathStr = asStr(input, "path");
  if (pathStr === undefined) throw new InvalidArgs("missing required field: path");
  rejectGitInternalPath(pathStr);

  const content = asStr(input, "content");
  const edits = asArray(input, "edits");

  if (content !== undefined && edits !== undefined) {
    throw new InvalidArgs(
      "pass either 'content' (whole file) or 'edits' (targeted replacements), not both",
    );
  }
  if (content !== undefined) return await writeWholeFile(pathStr, content, workspaceDir);
  if (edits !== undefined) return await applyEdits(pathStr, edits, workspaceDir);
  throw new InvalidArgs(
    "missing required field: pass 'content' to write a whole file, or 'edits' to replace text within one",
  );
}

/**
 * Write `content` to `path` wholesale, creating parent directories and the file
 * itself as needed. The `content` half of {@link handleEdit}.
 */
async function writeWholeFile(
  pathStr: string,
  content: string,
  workspaceDir: string,
): Promise<unknown> {
  const path = resolvePath(workspaceDir, pathStr);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  } catch (e) {
    throw new ToolIoError(ioMessage(e));
  }

  // Bytes, not characters: `String::len` is the UTF-8 length, and this number
  // is what the model is told it wrote.
  return { path: pathStr, bytes_written: Buffer.byteLength(content, "utf8") };
}

/**
 * Apply ordered text replacements to an existing file. The `edits` half of
 * {@link handleEdit}.
 *
 * Each edit sees the result of the ones before it — including the quoted file
 * contents in a no-match error, which is why that snippet can show text no edit
 * has written to disk yet. The write happens once, after every edit has
 * applied; a failure part-way through leaves the file untouched.
 */
async function applyEdits(
  pathStr: string,
  edits: unknown[],
  workspaceDir: string,
): Promise<unknown> {
  if (edits.length === 0) throw new InvalidArgs("'edits' array is empty");

  const path = resolvePath(workspaceDir, pathStr);
  if (!(await exists(path))) {
    throw new ToolIoError(
      `file not found: ${pathStr} (pass 'content' instead of 'edits' to create it)`,
    );
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (e) {
    throw new ToolIoError(ioMessage(e));
  }

  let replacementsMade = 0;

  for (const edit of edits) {
    const fields: ToolInput = isObject(edit) ? edit : {};
    const oldStr = asStr(fields, "old_string");
    if (oldStr === undefined) throw new InvalidArgs("each edit must have 'old_string'");
    const newStr = asStr(fields, "new_string");
    if (newStr === undefined) throw new InvalidArgs("each edit must have 'new_string'");
    const replaceAll = asBool(fields.replace_all) ?? false;

    if (oldStr === "") throw new InvalidArgs("old_string must not be empty");

    // `str::matches` counts non-overlapping matches left to right, which is
    // what `split(…).length - 1` counts too.
    const count = content.split(oldStr).length - 1;

    if (count === 0) {
      const snippet =
        [...content].length <= EDIT_SNIPPET_CHARS
          ? content
          : `${truncateChars(content, EDIT_SNIPPET_CHARS)}\n... (truncated)`;
      throw new InvalidArgs(
        `Could not find the exact text in ${pathStr}.\nCurrent file contents:\n${snippet}`,
      );
    }

    // Default to a unique match so an edit cannot silently clobber other
    // occurrences; `replace_all` opts into rewriting every one.
    if (count > 1 && !replaceAll) {
      throw new InvalidArgs(
        `Found ${count} occurrences of old_string in ${pathStr}; it must ` +
          "match exactly once. Add surrounding context to target a single " +
          'occurrence, or set "replace_all": true to replace every one.',
      );
    }

    content = content.split(oldStr).join(newStr);
    replacementsMade += count;
  }

  try {
    await writeFile(path, content);
  } catch (e) {
    throw new ToolIoError(ioMessage(e));
  }

  return { path: pathStr, replacements_made: replacementsMade };
}

// ── delete ──────────────────────────────────────────────────────────────

/**
 * Move a workspace file to the character's trash.
 *
 * Nothing is unlinked: the file is renamed under `{character_data}/trash/
 * {timestamp}/`, keeping its path below the workspace. A model that deletes the
 * wrong thing has made a recoverable mistake, and the timestamped root means a
 * second delete of the same path cannot overwrite the first one's copy.
 *
 * Prompt-visible files are refused outright — they are the character's own
 * definition, and losing one is not the kind of mistake a trash directory
 * makes better.
 */
export async function handleDelete(
  input: ToolInput,
  workspaceDir: string,
  characterDataDir: string,
): Promise<unknown> {
  const pathStr = asStr(input, "path");
  if (pathStr === undefined) throw new InvalidArgs("missing required field: path");
  rejectGitInternalPath(pathStr);

  if (normalizePromptVisiblePath(pathStr) !== undefined) {
    throw new InvalidArgs(`${pathStr} is a prompt-visible file and cannot be deleted`);
  }

  if (characterDataDir === "") {
    throw new InvalidArgs("character data directory not configured");
  }

  const path = resolvePath(workspaceDir, pathStr);

  if (!(await exists(path))) throw new ToolIoError(`file not found: ${pathStr}`);
  if (!(await isFile(path))) {
    throw new InvalidArgs(`${pathStr} is not a file (delete only operates on regular files)`);
  }

  const relativeUnderWorkspace = stripPrefixComponents(path, workspaceDir) ?? basename(path);

  const trashRoot = join(characterDataDir, "trash", trashStamp(new Date()));
  const trashTarget = join(trashRoot, relativeUnderWorkspace);

  try {
    await mkdir(dirname(trashTarget), { recursive: true });
  } catch (e) {
    throw new ToolIoError(`could not create trash directory: ${ioMessage(e)}`);
  }

  try {
    await rename(path, trashTarget);
  } catch (renameErr) {
    // A cross-device rename fails with EXDEV — the workspace and the character
    // data directory need not share a filesystem. Copy and unlink instead.
    try {
      await copyFile(path, trashTarget);
    } catch (copyErr) {
      throw new ToolIoError(
        `could not move file to trash (rename: ${ioMessage(renameErr)}, ` +
          `copy fallback: ${ioMessage(copyErr)})`,
      );
    }
    try {
      await rm(path);
    } catch (e) {
      throw new ToolIoError(`could not remove original after copy: ${ioMessage(e)}`);
    }
  }

  // Displayed relative to the character directory's *parent*, so the answer
  // reads `{character}/trash/…` rather than a bare `trash/…` that says nothing
  // about whose trash it is.
  const displayRoot = dirname(characterDataDir);
  const trashedDisplay = (stripPrefixComponents(trashTarget, displayRoot) ?? trashTarget)
    .replaceAll("\\", "/");

  return { path: pathStr, deleted: true, trashed_to: trashedDisplay };
}

/**
 * The trash subdirectory's name: `%Y%m%dT%H%M%S%3fZ` in UTC.
 *
 * Millisecond precision is the collision guard — two deletes of different files
 * in the same second must not land in one directory and race each other's
 * `mkdir`.
 */
export function trashStamp(now: Date): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}` +
    `${pad(now.getUTCMilliseconds(), 3)}Z`
  );
}

// ── search ──────────────────────────────────────────────────────────────

/** What the caller asked for, before the wiring gets a say. */
type RequestedMode = "hybrid" | "lexical" | "vector";

function parseSearchMode(raw: unknown): RequestedMode {
  if (raw === undefined) return "hybrid";
  if (typeof raw !== "string") throw new InvalidArgs("search `mode` must be a string");
  if (raw === "hybrid" || raw === "lexical" || raw === "vector") return raw;
  throw new InvalidArgs(`unknown search mode '${raw}'; expected hybrid, lexical, or vector`);
}

/** Everything the semantic half of the search needs, when it is available. */
export interface SearchSemantics {
  embedder: Embedder;
  indexPath: string;
}

/**
 * Search the workspace, semantically or lexically.
 *
 * Dispatches on the caller's `mode` *and* on whether an embedder is actually
 * wired: a `hybrid` request without one is answered lexically and told so
 * (`semantic_unavailable`) rather than refused. The same fallback catches a
 * semantic search that fails at runtime — a missing index is a degraded answer,
 * not an error, because the lexical answer was always available.
 */
export async function handleSearch(
  input: ToolInput,
  workspaceDir: string,
  retrievalConfigOpt: RetrievalConfig | undefined,
  semantics: SearchSemantics | undefined,
): Promise<unknown> {
  const retrievalConfig = retrievalConfigOpt ?? DEFAULT_RETRIEVAL_CONFIG;
  const requestedMode = parseSearchMode(input.mode);
  const requestedHybrid = requestedMode !== "lexical";
  const pathStr = asStr(input, "path");

  if (requestedHybrid && semantics !== undefined) {
    const mode: HybridMode = requestedMode === "vector" ? "vector" : "hybrid";
    const scope =
      pathStr !== undefined && pathStr !== "" && pathStr !== "."
        ? scopePrefixFor(workspaceDir, pathStr)
        : undefined;
    return await handleSearchHybrid(
      input,
      workspaceDir,
      retrievalConfig,
      mode,
      semantics,
      scope,
    );
  }

  const response = await handleSearchLexical(input, workspaceDir, retrievalConfig);
  response.mode = "lexical";
  if (requestedHybrid) response.semantic_unavailable = "embedder not configured";
  return response;
}

/**
 * The workspace-relative prefix a path-scoped hybrid search filters on
 * (`"workspace/notes"` → `"notes"`, `"memory/x"` → `"memory/x"`).
 *
 * The empty string means the workspace root, which `hybridSearch` treats as no
 * filter at all.
 */
function scopePrefixFor(workspaceDir: string, raw: string): string {
  return displayPathFor(workspaceDir, resolveListPath(workspaceDir, raw));
}

/**
 * Case-insensitive substring search over the workspace, newest file first.
 *
 * The ordering is deliberate and is why this is not simply the weaker half of
 * the hybrid path: "what did I write about X recently" is a different question
 * from "what is most similar to X", and recency answers it better than any
 * score does.
 */
async function handleSearchLexical(
  input: ToolInput,
  workspaceDir: string,
  retrievalConfig: RetrievalConfig,
): Promise<Record<string, unknown>> {
  if (workspaceDir === "") throw new InvalidArgs("workspace not configured");

  const query = normalizeSearchQuery(input);
  const queryLower = query.toLowerCase();
  const maxResults = searchResultLimit(input);
  const root = resolveListPath(workspaceDir, asStr(input, "path"));

  if (!(await exists(root))) {
    return { query, results: [], count: 0, note: "path does not exist" };
  }

  const [candidates, oversizeSkipped] = await enumerateSearchCandidates(root, retrievalConfig);
  const scan = await scanLexicalMatches(
    candidates,
    workspaceDir,
    queryLower,
    maxResults,
    oversizeSkipped,
  );

  const count = scan.results.length;
  const response: Record<string, unknown> = {
    query,
    results: scan.results,
    count,
    searched_files: scan.searchedFiles,
    skipped_binary_or_large: scan.skippedBinaryOrLarge,
  };

  if (count > 0) {
    response.files = scan.filesSummary;
    response.note =
      "These are line-level excerpts, ordered by file recency. " +
      "Call `read` on the top file paths to see surrounding context — " +
      "excerpts almost never contain the full answer, and one file " +
      "often references others worth reading too.";
  }

  return response;
}

function normalizeSearchQuery(input: ToolInput): string {
  const raw = asStr(input, "query");
  if (raw === undefined) throw new InvalidArgs("missing required field: query");
  const query = rustTrim(raw);
  if (query === "") throw new InvalidArgs("query must not be empty");
  return query;
}

function searchResultLimit(input: ToolInput): number {
  const requested = asU64(input, "max_results") ?? SEARCH_DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(requested, 1), SEARCH_MAX_RESULTS);
}

/**
 * Enumerate searchable files under `root`, newest first, with path order
 * breaking mtime ties so a workspace written in one burst still lists stably.
 *
 * Symlinks are skipped. Descendants found by walking are joined onto the root
 * without re-checking containment — the confinement check happened once, on the
 * caller's path — so a link pointing at `/etc/passwd` would otherwise be read
 * like any other file in the subtree.
 *
 * Unlike the embedding index's walk, there is no file-count or total-byte cap
 * here: only oversize *individual* files are skipped, and they are counted.
 */
async function enumerateSearchCandidates(
  root: string,
  retrievalConfig: RetrievalConfig,
): Promise<[{ path: string; mtimeMs: number }[], number]> {
  const pending = [root];
  const candidates: { path: string; mtimeMs: number }[] = [];
  let skippedBinaryOrLarge = 0;

  while (pending.length > 0) {
    const path = pending.pop()!;

    let meta;
    try {
      meta = await lstat(path);
    } catch {
      continue;
    }

    // Subsumed, strictly speaking — `lstat` reports a symlink as neither file
    // nor directory, so the `isFile` check below would drop it anyway, and
    // mutation testing finds this line unkillable. It stays for the same reason
    // its twin in `workspace_index.ts` does: the decision not to follow links
    // out of the workspace belongs where it is made, not as a side effect of
    // how `lstat` reports types.
    if (meta.isSymbolicLink()) continue;

    // The workspace carries a git history of memory changes; the git store is
    // machine state, not searchable memory. Skipped whether `.git` is a
    // directory or a *file* — a linked worktree spells it as a file whose
    // `gitdir:` line would otherwise be read out and handed to the model.
    if (basename(path) === ".git") continue;

    if (meta.isDirectory()) {
      try {
        for (const name of await readdir(path)) pending.push(join(path, name));
      } catch {
        continue;
      }
      continue;
    }

    if (!meta.isFile()) continue;

    if (meta.size > retrievalConfig.maxFileBytes) {
      skippedBinaryOrLarge += 1;
      continue;
    }

    candidates.push({ path, mtimeMs: meta.mtimeMs });
  }

  candidates.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return compareRustStrings(a.path, b.path);
  });

  return [candidates, skippedBinaryOrLarge];
}

interface LexicalScanOutput {
  results: unknown[];
  filesSummary: unknown[];
  searchedFiles: number;
  skippedBinaryOrLarge: number;
}

/**
 * Scan candidates for `queryLower`, collecting one excerpt per matching line up
 * to `maxResults` and a per-file hit count alongside.
 *
 * A file that is not valid UTF-8 is counted as skipped rather than read
 * lossily: a binary blob decoded with replacement characters produces matches
 * that mean nothing and excerpts that render as garbage.
 */
async function scanLexicalMatches(
  candidates: { path: string; mtimeMs: number }[],
  workspaceDir: string,
  queryLower: string,
  maxResults: number,
  skippedBinaryOrLarge: number,
): Promise<LexicalScanOutput> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const results: unknown[] = [];
  const filesSummary: unknown[] = [];
  let searchedFiles = 0;
  let skipped = skippedBinaryOrLarge;

  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(candidate.path);
    } catch {
      continue;
    }
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      skipped += 1;
      continue;
    }

    searchedFiles += 1;
    const display = displayPathFor(workspaceDir, candidate.path);
    let fileHits = 0;

    const lines = rustLines(content);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const match = findCaseInsensitiveMatch(line, queryLower);
      if (match === undefined) continue;
      results.push({
        path: display,
        line: i + 1,
        excerpt: excerptLine(line, match[0], match[1]),
      });
      fileHits += 1;
      if (results.length >= maxResults) break;
    }

    if (fileHits > 0) filesSummary.push({ path: display, hits: fileHits });
    if (results.length >= maxResults) break;
  }

  return { results, filesSummary, searchedFiles, skippedBinaryOrLarge: skipped };
}

/**
 * Rank whole files by combined semantic and lexical score, then quote the best
 * line from each.
 *
 * A failure anywhere in the semantic path — no index, an embedder that will not
 * answer, a count mismatch — falls back to the lexical scan and names the cause
 * in `semantic_unavailable`. The model gets an answer and an explanation for
 * why it is the shape it is, which is strictly better than an error it can only
 * retry.
 */
async function handleSearchHybrid(
  input: ToolInput,
  workspaceDir: string,
  retrievalConfig: RetrievalConfig,
  mode: HybridMode,
  semantics: SearchSemantics,
  pathFilter: string | undefined,
): Promise<unknown> {
  const query = normalizeSearchQuery(input);
  const maxResults = searchResultLimit(input);

  let result;
  try {
    result = await hybridSearch({
      workspaceDir,
      retrievalConfig,
      query,
      mode,
      embedder: semantics.embedder,
      indexPath: semantics.indexPath,
      ...(pathFilter === undefined ? {} : { pathFilter }),
    });
  } catch (e) {
    const lex = await handleSearchLexical(input, workspaceDir, retrievalConfig);
    lex.mode = "lexical";
    lex.semantic_unavailable = e instanceof Error ? e.message : String(e);
    return lex;
  }

  const qLower = query.toLowerCase();
  const results = result.files.slice(0, maxResults).map((f) => {
    const [lineNo, excerpt] = bestLineExcerpt(f.content ?? "", qLower);
    return {
      path: f.displayPath,
      line: lineNo,
      excerpt,
      lexical_score: f.lexicalScore,
      semantic_score: f.semanticScore ?? null,
      combined_score: f.combinedScore,
    };
  });

  const response: Record<string, unknown> = {
    query,
    mode,
    results,
    count: results.length,
    searched_files: result.searchedFiles,
    embedded_files: result.embeddedFiles,
    skipped_binary_or_large: result.skippedBinaryOrLarge,
  };

  if (results.length > 0) {
    response.note =
      "Files ranked by combined semantic + lexical score. Excerpts are " +
      "best-effort line-level snippets; call `read` on the top paths for " +
      "full context — one file often references others worth reading too.";
  }

  return response;
}

/**
 * The line of `content` worth quoting for `qLower`, and its 1-based number.
 *
 * Four attempts, in descending order of how much they prove: the whole query on
 * one line; the best single *term*, weighted so a rare term beats a common one;
 * the first non-heading line; the first line at all. A semantic hit need not
 * contain the query at all, so the last two are not fallbacks for broken input
 * — they are the normal outcome for a file that matched on meaning.
 */
export function bestLineExcerpt(content: string, qLower: string): [number, string] {
  const lines = rustLines(content);

  for (let i = 0; i < lines.length; i += 1) {
    const match = findCaseInsensitiveMatch(lines[i]!, qLower);
    if (match !== undefined) return [i + 1, excerptLine(lines[i]!, match[0], match[1])];
  }

  const terms = searchExcerptTerms(qLower);
  if (terms.length > 0) {
    const frequencies = termLineFrequencies(lines, terms);
    const best =
      bestTermMatchedLine(lines, terms, frequencies, false) ??
      bestTermMatchedLine(lines, terms, frequencies, true);
    if (best !== undefined) {
      const [lineNo, line, term] = best;
      const match = findCaseInsensitiveMatch(line, term);
      if (match !== undefined) return [lineNo, excerptLine(line, match[0], match[1])];
      return [lineNo, truncateExcerptLine(rustTrim(line))];
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = rustTrim(lines[i]!);
    if (trimmed !== "" && !trimmed.startsWith("#")) return [i + 1, truncateExcerptLine(trimmed)];
  }
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = rustTrim(lines[i]!);
    if (trimmed !== "") return [i + 1, truncateExcerptLine(trimmed)];
  }
  return [1, ""];
}

/**
 * The query's terms, for excerpt selection only.
 *
 * Split on anything that is not alphanumeric, `_` or `-`, and single characters
 * dropped. Deliberately not the tokenizer the index uses: this one only has to
 * pick a line to quote.
 */
function searchExcerptTerms(queryLower: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of queryLower) {
    if (isAlphanumeric(ch) || ch === "_" || ch === "-") {
      current += ch;
      continue;
    }
    if (current !== "") out.push(current);
    current = "";
  }
  if (current !== "") out.push(current);
  // Rust's `filter(|t| t.len() >= 2)` is a *byte* length, so a single non-ASCII
  // character survives it. Kept, because the alternative silently changes which
  // line gets quoted for a CJK query.
  return out.filter((t) => Buffer.byteLength(t, "utf8") >= 2);
}

/** `char::is_alphanumeric`: Unicode letters and numbers, not just ASCII. */
function isAlphanumeric(ch: string): boolean {
  return /\p{L}|\p{N}/u.test(ch);
}

/**
 * How many lines each term appears on, floored at 1.
 *
 * The floor is a division guard, not a fudge: the score below divides by this,
 * and a term that appears on no line at all still has to produce a number. It
 * is also unreachable — a term with a frequency of zero appears on no line and
 * so never scores one — which is why mutation testing cannot kill it. Kept
 * because the guard is at the division, where a reader checks for it.
 */
function termLineFrequencies(lines: string[], terms: string[]): number[] {
  return terms.map((term) =>
    Math.max(lines.filter((line) => line.toLowerCase().includes(term)).length, 1),
  );
}

/**
 * The highest-scoring line containing any term, with the term that scored best
 * on it.
 *
 * A term is worth `100 / (lines it appears on) + its length` — rarity first,
 * specificity as the tiebreak — and a line's score is the sum over its terms.
 * Ties go to the *earlier* line.
 *
 * `allowHeading` is the second pass. Headings are excluded first because a
 * markdown heading matching a term is usually the section title rather than the
 * answer; if nothing else matched, quoting the heading beats quoting nothing.
 */
function bestTermMatchedLine(
  lines: string[],
  terms: string[],
  frequencies: number[],
  allowHeading: boolean,
): [number, string, string] | undefined {
  let best: { lineNo: number; line: string; term: string; score: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = rustTrim(line);
    if (trimmed === "") continue;
    if (!allowHeading && trimmed.startsWith("#")) continue;

    const lower = trimmed.toLowerCase();
    let bestTerm: { term: string; score: number } | undefined;
    let lineScore = 0;

    for (let t = 0; t < terms.length; t += 1) {
      const term = terms[t]!;
      if (!lower.includes(term)) continue;
      const denom = Math.max(frequencies[t] ?? 1, 1);
      const termScore = Math.floor(100 / denom) + Buffer.byteLength(term, "utf8");
      lineScore += termScore;
      if (bestTerm === undefined || termScore > bestTerm.score) {
        bestTerm = { term, score: termScore };
      }
    }

    if (bestTerm === undefined) continue;
    // Strictly greater: an equal score leaves the earlier line in place.
    if (best === undefined || lineScore > best.score) {
      best = { lineNo: i + 1, line, term: bestTerm.term, score: lineScore };
    }
  }

  return best === undefined ? undefined : [best.lineNo, best.line, best.term];
}

// ── git ─────────────────────────────────────────────────────────────────

/**
 * Global `-c` flags that neutralize repo-controlled execution surfaces: a
 * pre-existing (e.g. imported) `.git/config` or `.gitattributes` must not run
 * hooks or filter drivers when git runs. Prepended before the subcommand so
 * they apply to all of them, and passed on the command line so they outrank the
 * repo's own config.
 *
 * The model cannot inject its own `-c` — the subcommand slot rejects option
 * tokens and `git config` is denied — so these are the daemon's to set and
 * nobody else's.
 */
export const GIT_SAFETY_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

/**
 * True when `arg` looks like it names a path, and so has to be confined.
 *
 * Deliberately generous: every shape that could reach the filesystem is
 * path-like, and a false positive costs only a confinement check on something
 * that was really a branch name. `-` and `--` are the two stdin/separator
 * spellings and name nothing — an early return that mutation testing cannot
 * kill, since neither carries a separator and both would fall out `false` at
 * the bottom anyway. It says what they are, which the fall-through does not.
 */
export function isPathLikeArg(arg: string): boolean {
  if (arg === "" || arg === "-" || arg === "--") return false;

  // The Rust also tested for a `Component::Prefix`, which is the Windows drive
  // letter. It cannot occur on the Unix build this replaces, and its absence
  // here changes nothing.
  return (
    arg.startsWith("/") ||
    arg.startsWith("\\") ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("~/") ||
    arg.startsWith("~\\") ||
    arg === "." ||
    arg === ".." ||
    arg.includes("/") ||
    arg.includes("\\") ||
    arg.startsWith("file:")
  );
}

/**
 * Confine one path-like git argument to the workspace.
 *
 * The component scan comes first so `..` and a leading `/` are named as such,
 * then the resolved path is compared against the canonical workspace root — or
 * against its nearest existing ancestor, for a path git is about to create.
 */
function validateGitPathArg(workspaceDir: string, arg: string): void {
  for (const part of arg.split("/")) {
    if (part === "..") throw new InvalidArgs(`git argument escapes workspace: ${arg}`);
  }
  if (arg.startsWith("/")) {
    throw new InvalidArgs(`git argument uses an absolute path: ${arg}`);
  }

  const resolved = resolvePath(workspaceDir, arg);

  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspaceDir);
  } catch (e) {
    throw new ToolIoError(`workspace unavailable: ${ioMessage(e)}`);
  }

  const canonical = tryRealpath(resolved);
  if (canonical !== undefined) {
    if (!isInside(canonical, workspaceRoot)) {
      throw new InvalidArgs(`git argument escapes workspace: ${arg}`);
    }
    return;
  }

  let ancestor = resolved;
  for (;;) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    const canonicalParent = tryRealpath(parent);
    if (canonicalParent !== undefined) {
      if (!isInside(canonicalParent, workspaceRoot)) {
        throw new InvalidArgs(`git argument escapes workspace: ${arg}`);
      }
      return;
    }
    ancestor = parent;
  }
}

/**
 * Confine every path-like argument to the workspace.
 *
 * Unlike the argv form this replaces, `args` never contains the program or the
 * subcommand — the caller passes only the subcommand's own arguments. The
 * `=`-split is what catches `--git-dir=/etc`: the flag itself is not path-like,
 * its value is.
 */
export function validateGitArgs(workspaceDir: string, args: string[]): void {
  if (workspaceDir === "") throw new InvalidArgs("workspace not configured");

  for (const arg of args) {
    if (arg.startsWith("file:")) {
      throw new InvalidArgs(`git argument uses a file URL: ${arg}`);
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      const value = arg.slice(eq + 1);
      if (isPathLikeArg(value)) validateGitPathArg(workspaceDir, value);
    }

    if (isPathLikeArg(arg)) validateGitPathArg(workspaceDir, arg);
  }
}

/**
 * Reject a subcommand that is really a git *global* flag in disguise.
 *
 * The structured `{subcommand, args}` shape is what makes this cheap: the
 * runtime always spawns `git <subcommand> <args…>`, so `-c core.pager=…`,
 * `--exec-path=…`, `--git-dir=…` and friends can never land in the global slot
 * ahead of the subcommand the way they could when the model handed over a whole
 * command line. Guarding argv[0] closes the only remaining door.
 */
export function validateGitSubcommandToken(subcommand: string): void {
  if (subcommand === "") throw new InvalidArgs("subcommand is empty");
  if (subcommand.startsWith("-")) {
    throw new InvalidArgs(
      `'${subcommand}' is a git option, not a subcommand; pass options in \`args\``,
    );
  }
  if (subcommand.includes("/") || subcommand.includes("\\")) {
    throw new InvalidArgs(`'${subcommand}' is not a valid git subcommand`);
  }
}

/**
 * True when a `checkout`'s arguments name a pathspec rather than just a branch
 * — the form that overwrites working-tree files from a tree-ish.
 *
 * Two shapes reach it: an explicit `--` separator, or a bare `<tree-ish> <path>`
 * pair. Branch creation legitimately takes two operands (`-b topic
 * origin/main`), so operand count alone does not make it a pathspec.
 */
export function checkoutTargetsAPathspec(rest: string[]): boolean {
  if (rest.includes("--")) return true;
  if (rest.some((a) => a === "-b" || a === "-B" || a === "--orphan")) return false;
  // `checkout main` is a branch switch; `checkout HEAD note.md` is a discard.
  return rest.filter((a) => !a.startsWith("-")).length >= 2;
}

/**
 * Validate a subcommand and its arguments against the destructive denylist.
 * `sub[0]` is the subcommand name.
 *
 * Blocks history rewriting, forced discards, remote mutation, `config`, and
 * `push`. The division of labour is that the model *commits* and the daemon
 * *pushes*: network egress is daemon policy, and a repo the operator imported
 * must not have its history rewritten by something the model was talked into.
 */
export function validateGitSubcommand(sub: string[]): void {
  const cmd = sub[0];
  if (cmd === undefined) return;
  const rest = sub.slice(1);
  const has = (flag: string) => rest.includes(flag);

  switch (cmd) {
    case "config":
      throw new InvalidArgs("git config is not allowed (use the daemon's identity setup)");
    case "reset":
      if (has("--hard") || has("--merge") || has("--keep")) {
        throw new InvalidArgs("git reset --hard/--merge/--keep is not allowed");
      }
      return;
    case "clean": {
      if (has("-f") || has("--force") || has("-d") || has("-x") || has("-X")) {
        throw new InvalidArgs("git clean (forced) is not allowed");
      }
      // Combined short flags — `-fd`, `-fdx`, `-xd` — carry the same meaning
      // and would otherwise walk straight past the exact-match tests above.
      for (const a of rest) {
        if (!a.startsWith("-") || a.startsWith("--")) continue;
        if (a.includes("f") || a.includes("d") || a.includes("x") || a.includes("X")) {
          throw new InvalidArgs("git clean (forced) is not allowed");
        }
      }
      return;
    }
    case "rebase":
    case "filter-branch":
    case "filter-repo":
      throw new InvalidArgs(`git ${cmd} is not allowed`);
    case "checkout": {
      if (has("-f") || has("--force")) {
        throw new InvalidArgs("git checkout --force is not allowed");
      }
      // `git checkout <tree-ish> -- <path>` overwrites the file from the tree,
      // discarding uncommitted work — precisely what `git restore` was split
      // out of, and `restore` is denied just below for exactly that. Denying
      // the modern spelling while waving through the old one would be a
      // denylist that only stops the polite caller.
      if (checkoutTargetsAPathspec(rest)) {
        throw new InvalidArgs(
          "git checkout of a path is not allowed (discards changes); commit first, or read the file and edit it",
        );
      }
      return;
    }
    case "switch":
      if (has("-f") || has("--force") || has("--discard-changes")) {
        throw new InvalidArgs("git switch --force is not allowed");
      }
      return;
    case "restore":
      throw new InvalidArgs("git restore is not allowed (discards changes)");
    case "branch":
      if (has("-D") || has("-d") || has("--delete")) {
        throw new InvalidArgs("git branch deletion is not allowed");
      }
      return;
    case "tag":
      if (has("-d") || has("--delete")) {
        throw new InvalidArgs("git tag deletion is not allowed");
      }
      return;
    case "stash":
      if (rest[0] === "drop" || rest[0] === "clear" || rest[0] === "pop") {
        throw new InvalidArgs("git stash drop/clear/pop is not allowed");
      }
      return;
    case "reflog":
      if (rest[0] === "expire" || rest[0] === "delete") {
        throw new InvalidArgs("git reflog expire/delete is not allowed");
      }
      return;
    case "gc":
      throw new InvalidArgs("git gc is not allowed");
    case "update-ref":
      if (has("-d") || has("--delete")) {
        throw new InvalidArgs("git update-ref -d is not allowed");
      }
      return;
    case "push":
      throw new InvalidArgs(
        "git push is not allowed (the daemon pushes after a pass when [memory] git_push is enabled)",
      );
    // Remote access is the daemon's job, the same way `push` is: the model
    // works in the local repo.
    case "fetch":
    case "pull":
    case "clone":
      throw new InvalidArgs(`git ${cmd} is not allowed (the daemon owns remote access)`);
    case "remote":
      if (
        rest[0] === "add" ||
        rest[0] === "set-url" ||
        rest[0] === "rename" ||
        rest[0] === "remove" ||
        rest[0] === "rm"
      ) {
        throw new InvalidArgs("modifying git remotes is not allowed");
      }
      return;
    default:
      return;
  }
}

/**
 * The git author/committer identity the daemon attributes its own and the
 * model's memory commits to.
 *
 * Deliberately *not* written to the repo's local config: the identity is
 * injected per-process onto the commands the daemon spawns, so an operator's
 * own `git commit` in the same workspace keeps their global identity and stays
 * distinguishable in the log.
 */
export function characterGitIdentity(character: string): [string, string] {
  const local = [...character.toLowerCase()]
    .map((c) => (/\s/u.test(c) ? "-" : c))
    .join("");
  return [character, `${local}@shore.local`];
}

/**
 * Run a git subcommand in the character's workspace repository.
 *
 * The only tool that spawns a process, and it is spawned directly. Everything
 * it can do is bounded by three checks: the subcommand must not be a global
 * flag, it must not be destructive or history-rewriting, and every path-like
 * argument must stay inside the workspace.
 *
 * Initializes the workspace repository when it is missing. The memory passes do
 * the same before they run, but they used to be the only ones: on the chat path
 * a character offered this tool would otherwise meet `fatal: not a git
 * repository` until the first compaction happened to create one.
 */
export async function handleGit(
  input: ToolInput,
  workspaceDir: string,
  character: string,
): Promise<unknown> {
  const rawSubcommand = asStr(input, "subcommand");
  if (rawSubcommand === undefined) {
    throw new InvalidArgs("missing required field: subcommand");
  }
  const subcommand = rustTrim(rawSubcommand);
  validateGitSubcommandToken(subcommand);

  const args: string[] = [];
  const rawArgs = input.args;
  if (Array.isArray(rawArgs)) {
    for (const item of rawArgs) {
      if (typeof item !== "string") {
        throw new InvalidArgs("every element of `args` must be a string");
      }
      args.push(item);
    }
  } else if (rawArgs !== undefined && rawArgs !== null) {
    throw new InvalidArgs("`args` must be an array of strings");
  }

  // The denylist expects the subcommand at index 0 followed by its arguments —
  // the same slice layout the exec argv walk used to hand it.
  const subSlice = [subcommand, ...args];
  validateGitSubcommand(subSlice);
  validateGitArgs(workspaceDir, args);

  if (workspaceDir !== "") {
    await ensureWorkspaceGitRepoBestEffort(workspaceDir);
  }

  const workdirRel = asStr(input, "workdir");
  const workdir = workdirRel === undefined ? undefined : resolvePath(workspaceDir, workdirRel);

  // A `workdir` that is not there makes the *spawn* fail: the child's `chdir`
  // returns the same ENOENT a missing git binary does, and the spawn-failure
  // message below blames the host. That message is true for every other cause
  // and wrong for this one, so catch the one case that is the model's to fix
  // while it can still be named as such.
  if (workdirRel !== undefined && workdir !== undefined && !(await isDir(workdir))) {
    throw new InvalidArgs(
      `workdir is not an existing directory in your workspace: ${workdirRel}`,
    );
  }

  const spawnArgs = [...GIT_SAFETY_FLAGS, ...subSlice];

  // git runs as the character: attribute commits to it, keeping them distinct
  // from operator commits in the same repo.
  const [name, email] = characterGitIdentity(character);

  const cwd = workdir ?? (workspaceDir !== "" ? workspaceDir : undefined);

  let output;
  try {
    output = await runProcess("git", spawnArgs, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
  } catch (e) {
    // A bare io error here is about the program we tried to spawn, never about
    // what the model passed — but it reads exactly like a bad-argument error,
    // so the model retries variations and then gives up on the tool. Say whose
    // problem it is.
    throw new ToolIoError(
      `could not start git: ${ioMessage(e)}. This is a problem with the host, not with your ` +
        "arguments — git may not be installed, or the daemon may need a restart. " +
        "Other subcommands will fail the same way; tell whoever you are talking to " +
        "rather than retrying.",
    );
  }

  return {
    subcommand,
    args,
    exit_code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

// ── Workspace git history ───────────────────────────────────────────────

/**
 * Ensure the character workspace is a git repository so the memory passes can
 * commit their changes.
 *
 * Deliberately sets **no** local identity: the daemon injects the character's
 * per-commit (see {@link characterGitIdentity}), leaving an operator's own
 * commits attributed to their global git identity. A pre-existing repository is
 * left untouched. Returns `true` when a repository was created.
 */
export async function ensureWorkspaceGitRepo(workspaceDir: string): Promise<boolean> {
  if (await exists(join(workspaceDir, ".git"))) return false;
  await mkdir(workspaceDir, { recursive: true });
  const init = await runGit(workspaceDir, ["init", "--quiet"]);
  if (init.code !== 0) throw gitOutputError("git init failed", init);
  return true;
}

/**
 * Best-effort {@link ensureWorkspaceGitRepo}. A host without git still gets a
 * full pass, just without history, so a failure here is never fatal.
 */
export async function ensureWorkspaceGitRepoBestEffort(workspaceDir: string): Promise<void> {
  try {
    await ensureWorkspaceGitRepo(workspaceDir);
  } catch {
    // Logged by the caller that cares; the pass continues either way.
  }
}

/**
 * Stage and commit everything in the workspace repository, attributed to the
 * character.
 *
 * Used by the daemon for bookkeeping commits (recording a compaction rollback,
 * say) — model-authored commits go through the `git` tool instead. A clean tree
 * is not an error; returns `true` only when a commit was created.
 */
export async function gitCommitAll(
  workspaceDir: string,
  character: string,
  message: string,
): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const add = await runGit(workspaceDir, ["add", "--all"]);
  if (add.code !== 0) throw gitOutputError("git add failed", add);

  // `diff --cached --quiet` exits 0 when nothing is staged.
  const staged = await runGit(workspaceDir, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return false;

  const [name, email] = characterGitIdentity(character);
  const commit = await runGit(workspaceDir, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
  ]);
  if (commit.code !== 0) throw gitOutputError("git commit failed", commit);
  return true;
}

/**
 * Push the workspace repository to its configured remote, honoring the repo's
 * own push config.
 *
 * Skips silently when the workspace is not a repo or has no remote: the daemon
 * never invents one. Pushing is opt-in (`[memory] git_push`) to a remote the
 * operator set up.
 */
export async function gitPushWorkspace(workspaceDir: string): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const remotes = await runGit(workspaceDir, ["remote"]);
  if (remotes.code !== 0 || rustTrim(remotes.stdout) === "") return false;

  const push = await runGit(workspaceDir, ["push"]);
  if (push.code !== 0) throw gitOutputError("git push failed", push);
  return true;
}

/** Best-effort {@link gitPushWorkspace}: the pass already committed, and a
 * failed push must not undo it. */
export async function gitPushWorkspaceBestEffort(workspaceDir: string): Promise<void> {
  try {
    await gitPushWorkspace(workspaceDir);
  } catch {
    // No upstream, network down, remote rejects — all logged, none fatal.
  }
}

/** The daemon's own git calls. Always carries {@link GIT_SAFETY_FLAGS}. */
async function runGit(workspaceDir: string, args: string[]): Promise<ProcessOutput> {
  return await runProcess("git", [...GIT_SAFETY_FLAGS, ...args], { cwd: workspaceDir });
}

function gitOutputError(context: string, output: ProcessOutput): Error {
  return new Error(`${context}: ${rustTrim(output.stderr)}`);
}

// ── Process and filesystem plumbing ─────────────────────────────────────

interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `Command::output`: run to completion, collecting both streams.
 *
 * `code` is null when the child was killed by a signal, matching
 * `ExitStatus::code`, which the response reports verbatim.
 */
function runProcess(
  program: string,
  args: string[],
  options: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined },
): Promise<ProcessOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code,
        // `String::from_utf8_lossy`, which is what Node's default decode is.
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/** `Path::exists`: follows symlinks, and false for anything unreadable. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `Path::is_dir`: follows symlinks, and false for anything unreadable. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `Path::is_file`: follows symlinks, and false for anything unreadable. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * `Path::strip_prefix`, component-wise, so `/wsx` is not inside `/ws`.
 *
 * Returns the remainder joined with the platform separator, or `undefined` when
 * `path` is not under `base`.
 */
function stripPrefixComponents(path: string, base: string): string | undefined {
  const split = (p: string) => p.split(sep).filter((part) => part !== "" && part !== ".");
  const p = split(path);
  const b = split(base);
  if (b.length > p.length) return undefined;
  for (let i = 0; i < b.length; i += 1) if (p[i] !== b[i]) return undefined;
  return p.slice(b.length).join(sep);
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The message half of an `io::Error`, however the runtime spelled it. */
function ioMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(value: unknown): value is ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
