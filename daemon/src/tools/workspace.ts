import { required } from "../util/required.ts";

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

const SEARCH_DEFAULT_MAX_RESULTS = 20;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_EXCERPT_CHARS = 1_200;

const EDIT_SNIPPET_CHARS = 800;

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxFileBytes: 1_048_576,
  maxIndexedFiles: 5_000,
  maxTotalIndexedBytes: 268_435_456,
  maxEmbedCharsPerFile: 8_000,
  binary: "skip",
};

export type ToolInput = Record<string, unknown>;

function asStr(input: ToolInput, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function asU64(input: ToolInput, field: string): number | undefined {
  const value = input[field];
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(input: ToolInput, field: string): unknown[] | undefined {
  const value = input[field];
  return Array.isArray(value) ? value : undefined;
}

function resolveListPath(workspaceDir: string, relative: string | undefined): string {
  if (workspaceDir === "") throw new PathError("invalid args: workspace not configured");

  if (relative === undefined || relative === "" || relative === ".") return workspaceDir;

  const [base, stripped] = resolveRoots(workspaceDir, relative);
  if (stripped === "") return base;
  return resolvePath(workspaceDir, relative);
}

function rejectGitInternalPath(pathStr: string): void {
  const trimmed = pathStr.startsWith("workspace/")
    ? pathStr.slice("workspace/".length)
    : pathStr;

  if (trimmed.startsWith("/")) return;
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return;
    if (part === ".git") throw new InvalidArgs("writing to .git/ is not allowed");
    return;
  }
}

export function findCaseInsensitiveMatch(
  line: string,
  queryLower: string,
): [number, number] | undefined {
  const folded = Array.from(line.toLowerCase());
  const query = Array.from(queryLower);
  const foldedStart = indexOfCodePoints(folded, query);
  if (foldedStart === undefined) return undefined;
  const foldedEnd = foldedStart + query.length;

  let foldedPos = 0;
  let originalStart: number | undefined;
  let originalEnd: number | undefined;

  let originalIdx = 0;
  for (const ch of line) {
    const charFoldedStart = foldedPos;
    foldedPos += Array.from(ch.toLowerCase()).length;
    const charFoldedEnd = foldedPos;

    if (charFoldedEnd > foldedStart && charFoldedStart < foldedEnd) {
      originalStart ??= originalIdx;
      originalEnd = originalIdx + 1;
      if (charFoldedEnd >= foldedEnd) break;
    }
    originalIdx += 1;
  }

  return [originalStart ?? 0, originalEnd ?? Array.from(line).length];
}

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

export function excerptLine(line: string, rawMatchStart: number, rawMatchEnd: number): string {
  const trimmedStart = rustTrimStart(line);
  const leadingTrimmed = Array.from(line).length - Array.from(trimmedStart).length;
  const trimmed = Array.from(rustTrimEnd(trimmedStart));

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

  const unusedAfter = Math.max(contextChars - (beforeChars + afterChars), 0);
  if (unusedAfter > 0) {
    beforeChars += Math.min(Math.max(availableBefore - beforeChars, 0), unusedAfter);
  }

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

function truncateExcerptLine(line: string): string {
  const count = Array.from(line).length;
  if (count <= SEARCH_EXCERPT_CHARS) return line;
  return `${truncateChars(line, SEARCH_EXCERPT_CHARS)}...`;
}

export async function handleRead(input: ToolInput, workspaceDir: string): Promise<unknown> {
  const pathStr = asStr(input, "path");
  if (pathStr === undefined) return await listDirectory(workspaceDir, undefined);

  const [, stripped] = resolveRoots(workspaceDir, pathStr);
  if (stripped === "") return await listDirectory(workspaceDir, pathStr);

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

  const lines = content.split("\n");
  const totalLines = lines.length;

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
      result.note =
        `Showing lines ${offset + 1}–${end} of ${totalLines}. ` +
        `Use offset=${end + 1} to continue.`;
    }
  }

  return result;
}

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

  return { path: pathStr, bytes_written: Buffer.byteLength(content, "utf8") };
}

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

    const count = content.split(oldStr).length - 1;

    if (count === 0) {
      const snippet =
        Array.from(content).length <= EDIT_SNIPPET_CHARS
          ? content
          : `${truncateChars(content, EDIT_SNIPPET_CHARS)}\n... (truncated)`;
      throw new InvalidArgs(
        `Could not find the exact text in ${pathStr}.\nCurrent file contents:\n${snippet}`,
      );
    }

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

  const displayRoot = dirname(characterDataDir);
  const trashedDisplay = (stripPrefixComponents(trashTarget, displayRoot) ?? trashTarget)
    .replaceAll("\\", "/");

  return { path: pathStr, deleted: true, trashed_to: trashedDisplay };
}

export function trashStamp(now: Date): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}` +
    `${pad(now.getUTCMilliseconds(), 3)}Z`
  );
}

type RequestedMode = "hybrid" | "lexical" | "vector";

function parseSearchMode(raw: unknown): RequestedMode {
  if (raw === undefined) return "hybrid";
  if (typeof raw !== "string") throw new InvalidArgs("search `mode` must be a string");
  if (raw === "hybrid" || raw === "lexical" || raw === "vector") return raw;
  throw new InvalidArgs(`unknown search mode '${raw}'; expected hybrid, lexical, or vector`);
}

export interface SearchSemantics {
  embedder: Embedder;
  indexPath: string;
}

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

function scopePrefixFor(workspaceDir: string, raw: string): string {
  return displayPathFor(workspaceDir, resolveListPath(workspaceDir, raw));
}

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

async function enumerateSearchCandidates(
  root: string,
  retrievalConfig: RetrievalConfig,
): Promise<[{ path: string; mtimeMs: number }[], number]> {
  const pending = [root];
  const candidates: { path: string; mtimeMs: number }[] = [];
  let skippedBinaryOrLarge = 0;

  while (pending.length > 0) {
    const path = required(pending.pop());

    let meta;
    try {
      meta = await lstat(path);
    } catch {
      continue;
    }

    if (meta.isSymbolicLink()) continue;

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
      const line = required(lines[i]);
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
      embedPending: false,
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
    ...(result.pendingFiles === 0 ? {} : { pending_files: result.pendingFiles }),
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

export function bestLineExcerpt(content: string, qLower: string): [number, string] {
  const lines = rustLines(content);

  for (let i = 0; i < lines.length; i += 1) {
    const match = findCaseInsensitiveMatch(required(lines[i]), qLower);
    if (match !== undefined) return [i + 1, excerptLine(required(lines[i]), match[0], match[1])];
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
    const trimmed = rustTrim(required(lines[i]));
    if (trimmed !== "" && !trimmed.startsWith("#")) return [i + 1, truncateExcerptLine(trimmed)];
  }
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = rustTrim(required(lines[i]));
    if (trimmed !== "") return [i + 1, truncateExcerptLine(trimmed)];
  }
  return [1, ""];
}

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
  return out.filter((t) => Buffer.byteLength(t, "utf8") >= 2);
}

function isAlphanumeric(ch: string): boolean {
  return /\p{L}|\p{N}/u.test(ch);
}

function termLineFrequencies(lines: string[], terms: string[]): number[] {
  return terms.map((term) =>
    Math.max(lines.filter((line) => line.toLowerCase().includes(term)).length, 1),
  );
}

function bestTermMatchedLine(
  lines: string[],
  terms: string[],
  frequencies: number[],
  allowHeading: boolean,
): [number, string, string] | undefined {
  let best: { lineNo: number; line: string; term: string; score: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = required(lines[i]);
    const trimmed = rustTrim(line);
    if (trimmed === "") continue;
    if (!allowHeading && trimmed.startsWith("#")) continue;

    const lower = trimmed.toLowerCase();
    let bestTerm: { term: string; score: number } | undefined;
    let lineScore = 0;

    for (let t = 0; t < terms.length; t += 1) {
      const term = required(terms[t]);
      if (!lower.includes(term)) continue;
      const denom = Math.max(frequencies[t] ?? 1, 1);
      const termScore = Math.floor(100 / denom) + Buffer.byteLength(term, "utf8");
      lineScore += termScore;
      if (bestTerm === undefined || termScore > bestTerm.score) {
        bestTerm = { term, score: termScore };
      }
    }

    if (bestTerm === undefined) continue;
    if (best === undefined || lineScore > best.score) {
      best = { lineNo: i + 1, line, term: bestTerm.term, score: lineScore };
    }
  }

  return best === undefined ? undefined : [best.lineNo, best.line, best.term];
}

export const GIT_SAFETY_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

const INHERITED_GIT_LOCATION_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
];

export function envWithoutInheritedGitRepo(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_GIT_LOCATION_VARS) delete env[name];
  return env;
}

export function isPathLikeArg(arg: string): boolean {
  if (arg === "" || arg === "-" || arg === "--") return false;

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

export function checkoutTargetsAPathspec(rest: string[]): boolean {
  if (rest.includes("--")) return true;
  if (rest.some((a) => a === "-b" || a === "-B" || a === "--orphan")) return false;
  return rest.filter((a) => !a.startsWith("-")).length >= 2;
}

export function validateGitSubcommand(sub: string[]): void {
  const cmd = sub[0];
  if (cmd === undefined) return;
  const rest = sub.slice(1);
  const has = (flag: string) => rest.includes(flag);

  if (rest[0] === cmd) {
    throw new InvalidArgs(
      `\`args\` repeats the subcommand: this would run \`git ${cmd} ${cmd}${
        rest.length > 1 ? " ..." : ""
      }\`, and git reads the second '${cmd}' as a revision or path. ` +
        `Drop '${cmd}' from \`args\` and pass only the flags and paths after it.`,
    );
  }

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
  }
}

export function characterGitIdentity(character: string): [string, string] {
  const local = Array.from(character.toLowerCase(), (c) => (/\s/u.test(c) ? "-" : c)).join("");
  return [character, `${local}@shore.local`];
}

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

  const subSlice = [subcommand, ...args];
  validateGitSubcommand(subSlice);
  validateGitArgs(workspaceDir, args);

  if (workspaceDir !== "") {
    await ensureWorkspaceGitRepoBestEffort(workspaceDir);
  }

  const workdirRel = asStr(input, "workdir");
  const workdir = workdirRel === undefined ? undefined : resolvePath(workspaceDir, workdirRel);

  if (workdirRel !== undefined && workdir !== undefined && !(await isDir(workdir))) {
    throw new InvalidArgs(
      `workdir is not an existing directory in your workspace: ${workdirRel}`,
    );
  }

  const spawnArgs = [...GIT_SAFETY_FLAGS, ...subSlice];

  const [name, email] = characterGitIdentity(character);

  const cwd = workdir ?? (workspaceDir !== "" ? workspaceDir : undefined);

  let output;
  try {
    output = await runProcess("git", spawnArgs, {
      cwd,
      env: {
        ...envWithoutInheritedGitRepo(),
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
  } catch (e) {
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

export async function ensureWorkspaceGitRepo(workspaceDir: string): Promise<boolean> {
  if (await exists(join(workspaceDir, ".git"))) return false;
  await mkdir(workspaceDir, { recursive: true });
  const init = await runGit(workspaceDir, ["init", "--quiet"]);
  if (init.code !== 0) throw gitOutputError("git init failed", init);
  return true;
}

export async function ensureWorkspaceGitRepoBestEffort(workspaceDir: string): Promise<void> {
  try {
    await ensureWorkspaceGitRepo(workspaceDir);
  } catch {
  }
}

export async function gitCommitAll(
  workspaceDir: string,
  character: string,
  message: string,
): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const add = await runGit(workspaceDir, ["add", "--all"]);
  if (add.code !== 0) throw gitOutputError("git add failed", add);

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

export async function gitHead(workspaceDir: string): Promise<string | undefined> {
  if (!(await exists(join(workspaceDir, ".git")))) return undefined;
  const head = await runGit(workspaceDir, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return undefined;
  const sha = rustTrim(head.stdout);
  return sha === "" ? undefined : sha;
}

export async function gitPushWorkspace(workspaceDir: string): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const remotes = await runGit(workspaceDir, ["remote"]);
  if (remotes.code !== 0 || rustTrim(remotes.stdout) === "") return false;

  const push = await runGit(workspaceDir, ["push"]);
  if (push.code !== 0) throw gitOutputError("git push failed", push);
  return true;
}

export async function gitPushWorkspaceBestEffort(workspaceDir: string): Promise<void> {
  try {
    await gitPushWorkspace(workspaceDir);
  } catch {
  }
}

async function runGit(workspaceDir: string, args: string[]): Promise<ProcessOutput> {
  return await runProcess("git", [...GIT_SAFETY_FLAGS, ...args], {
    cwd: workspaceDir,
    env: envWithoutInheritedGitRepo(),
  });
}

function gitOutputError(context: string, output: ProcessOutput): Error {
  return new Error(`${context}: ${rustTrim(output.stderr)}`);
}

interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  program: string,
  args: string[],
  options: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined },
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

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

function ioMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(value: unknown): value is ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
