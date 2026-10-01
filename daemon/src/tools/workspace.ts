import { formatToolOutput } from "./output.ts";
import { required } from "../util/required.ts";

import { spawn } from "node:child_process";

import { lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Embedder } from "../llm/embed";
import { containsEveryTerm, distinctiveTerms, meetsSimilarity } from "../memory/closeness";
import { compareRustStrings, rustLines, rustTrim, rustTrimEnd, rustTrimStart, tokenizeQuery } from "../memory/lines";
import { truncateChars } from "../memory/markdown_query";
import {
  displayPathFor,
  hybridSearch,
  type HybridMode,
  type RetrievalConfig,
  type ScoredFile,
} from "../memory/workspace_index";
import { InvalidArgs } from "./errors";
import { PathError, resolvePath, resolveRoots } from "./workspace_path";

const SEARCH_DEFAULT_MAX_RESULTS = 20;
const SEARCH_MAX_RESULTS = 100;
export const SEARCH_EXCERPT_CHARS = 500;
export const SEARCH_RESPONSE_CHARS = 12_000;
export const GIT_HISTORY_HINT =
  "Search reads current files only. Earlier versions and deleted files are in the workspace's git history: " +
  "run `git log -p -S'<text>'` with bash to find commits that added or removed some text.";
const searchExcerptRenderers = new WeakMap<object, (context: number) => string>();

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

function resolveListPath(workspaceDir: string, relative: string | undefined): string {
  if (workspaceDir === "") throw new PathError("invalid args: workspace not configured");

  if (relative === undefined || relative === "" || relative === ".") return workspaceDir;

  const [base, stripped] = resolveRoots(workspaceDir, relative);
  if (stripped === "") return base;
  return resolvePath(workspaceDir, relative);
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

export function excerptLine(line: string, rawMatchStart: number, rawMatchEnd: number, context = SEARCH_EXCERPT_CHARS): string {
  const trimmedStart = rustTrimStart(line);
  const leadingTrimmed = Array.from(line).length - Array.from(trimmedStart).length;
  const trimmed = Array.from(rustTrimEnd(trimmedStart));
  const matchStart = Math.min(Math.max(rawMatchStart - leadingTrimmed, 0), trimmed.length);
  const matchEnd = Math.max(Math.min(rawMatchEnd - leadingTrimmed, trimmed.length), matchStart);
  const start = Math.max(0, matchStart - context);
  const end = Math.min(trimmed.length, matchEnd + context);
  return `${start > 0 ? "..." : ""}${trimmed.slice(start, end).join("")}${end < trimmed.length ? "..." : ""}`;
}

function truncateExcerptLine(line: string, context: number): string {
  const count = Array.from(line).length;
  if (count <= context * 2) return line;
  return `${truncateChars(line, context * 2)}...`;
}

function budgetSearchResponse(response: Record<string, unknown>, context: number): Record<string, unknown> {
  const results = response.results as { excerpt: string }[];
  const render = (width: number) => {
    for (const hit of results) {
      const renderer = searchExcerptRenderers.get(hit);
      if (renderer) hit.excerpt = renderer(width);
    }
  };
  render(context);
  if (Array.from(formatToolOutput("search", response)).length <= SEARCH_RESPONSE_CHARS) return response;
  let low = 0;
  let high = context;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    render(mid);
    if (Array.from(formatToolOutput("search", response)).length <= SEARCH_RESPONSE_CHARS) low = mid;
    else high = mid - 1;
  }
  render(low);
  return response;
}

type RequestedMode = "hybrid" | "lexical" | "vector";

type SearchMatch = "ranked" | "nearest";

function parseSearchMatch(raw: unknown): SearchMatch {
  if (raw === undefined || raw === "ranked") return "ranked";
  if (raw === "nearest") return "nearest";
  throw new InvalidArgs("search `match` must be ranked or nearest");
}

function parseSearchMode(raw: unknown): RequestedMode {
  if (raw === undefined) return "hybrid";
  if (typeof raw !== "string") throw new InvalidArgs("search `mode` must be a string");
  if (raw === "hybrid" || raw === "lexical" || raw === "vector") return raw;
  throw new InvalidArgs(`unknown search mode '${raw}'; expected hybrid, lexical, or vector`);
}

export interface SearchSemantics {
  embedder: Embedder;
  indexPath: string;
  minSimilarity?: number;
}

export async function handleSearch(
  input: ToolInput,
  workspaceDir: string,
  retrievalConfigOpt: RetrievalConfig | undefined,
  semantics: SearchSemantics | undefined,
): Promise<unknown> {
  const context = input.context ?? SEARCH_EXCERPT_CHARS;
  if (typeof context !== "number" || !Number.isSafeInteger(context) || context < 0 || context > 10_000) {
    throw new InvalidArgs("context must be an integer between 0 and 10000");
  }
  const retrievalConfig = retrievalConfigOpt ?? DEFAULT_RETRIEVAL_CONFIG;
  const requestedMode = parseSearchMode(input.mode);
  const match = parseSearchMatch(input.match);
  const requestedHybrid = requestedMode !== "lexical";
  const pathStr = asStr(input, "path");

  if (requestedHybrid && semantics !== undefined) {
    const mode: HybridMode = requestedMode === "vector" ? "vector" : "hybrid";
    const scope =
      pathStr !== undefined && pathStr !== "" && pathStr !== "."
        ? scopePrefixFor(workspaceDir, pathStr)
        : undefined;
    return budgetSearchResponse(await handleSearchHybrid(
      input,
      workspaceDir,
      retrievalConfig,
      mode,
      match,
      semantics,
      scope,
    ), context);
  }

  const response = await handleSearchLexical(input, workspaceDir, retrievalConfig);
  response.mode = "lexical";
  if (requestedHybrid) response.semantic_unavailable = "embedder not configured";
  return budgetSearchResponse(response, context);
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
    maxResults + 1,
    oversizeSkipped,
  );

  const hasMore = scan.results.length > maxResults;
  if (hasMore) {
    scan.results.pop();
    const last = scan.filesSummary.at(-1) as { hits: number } | undefined;
    if (last !== undefined) {
      last.hits -= 1;
      if (last.hits === 0) scan.filesSummary.pop();
    }
  }
  const count = scan.results.length;
  const response: Record<string, unknown> = {
    query,
    results: scan.results,
    ...(hasMore ? { has_more: true } : {}),
    count,
    searched_files: scan.searchedFiles,
    skipped_binary_or_large: scan.skippedBinaryOrLarge,
  };

  if (count === 0) response.note = GIT_HISTORY_HINT;
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
      const hit = { path: display, line: i + 1, excerpt: "" };
      searchExcerptRenderers.set(hit, (context) => excerptLine(line, match[0], match[1], context));
      results.push(hit);
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
  match: SearchMatch,
  semantics: SearchSemantics,
  pathFilter: string | undefined,
): Promise<Record<string, unknown>> {
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
  const words = distinctiveTerms(tokenizeQuery(qLower));
  const judged = result.files.map((file) => ({
    file,
    close: fileIsClose(file, qLower, words, semantics.minSimilarity),
  }));
  const eligible = match === "nearest" ? judged : judged.filter((entry) => entry.close);
  const results = eligible.slice(0, maxResults).map(({ file: f, close }) => {
    const [lineNo, excerpt] = bestLineExcerpt(f.content ?? "", qLower);
    const hit = {
      path: f.displayPath,
      line: lineNo,
      excerpt,
      lexical_score: f.lexicalScore,
      semantic_score: f.semanticScore ?? null,
      combined_score: f.combinedScore,
      ...(close ? {} : { weak: true }),
    };
    searchExcerptRenderers.set(hit, (context) => bestLineExcerpt(f.content ?? "", qLower, context)[1]);
    return hit;
  });
  const best = Math.max(...result.files.map((f) => f.semanticScore ?? Number.NEGATIVE_INFINITY));

  const response: Record<string, unknown> = {
    query,
    mode,
    ...(match === "nearest" ? { match } : {}),
    results,
    count: results.length,
    closeness: {
      min_similarity: semantics.minSimilarity ?? null,
      best_similarity: Number.isFinite(best) ? Math.round(best * 1000) / 1000 : null,
      words,
      weaker_left_out: match === "ranked" && judged.some((entry) => !entry.close),
    },
    ...(eligible.length > maxResults ? { has_more: true } : {}),
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
  } else {
    response.note = GIT_HISTORY_HINT;
  }

  return response;
}

function fileIsClose(
  file: ScoredFile,
  qLower: string,
  words: readonly string[],
  minSimilarity: number | undefined,
): boolean {
  const text = `${file.displayPath}\n${file.content ?? ""}`.toLowerCase();
  if (text.includes(qLower) || containsEveryTerm(text, words)) return true;
  return minSimilarity === undefined
    ? file.semanticScore !== undefined
    : meetsSimilarity(file.semanticScore, minSimilarity);
}

export function bestLineExcerpt(content: string, qLower: string, context = SEARCH_EXCERPT_CHARS): [number, string] {
  const lines = rustLines(content);

  for (let i = 0; i < lines.length; i += 1) {
    const match = findCaseInsensitiveMatch(required(lines[i]), qLower);
    if (match !== undefined) return [i + 1, excerptLine(required(lines[i]), match[0], match[1], context)];
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
      if (match !== undefined) return [lineNo, excerptLine(line, match[0], match[1], context)];
      return [lineNo, truncateExcerptLine(rustTrim(line), context)];
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = rustTrim(required(lines[i]));
    if (trimmed !== "" && !trimmed.startsWith("#")) return [i + 1, truncateExcerptLine(trimmed, context)];
  }
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = rustTrim(required(lines[i]));
    if (trimmed !== "") return [i + 1, truncateExcerptLine(trimmed, context)];
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

export function characterGitIdentity(character: string): [string, string] {
  const local = Array.from(character.toLowerCase(), (c) => (/\s/u.test(c) ? "-" : c)).join("");
  return [character, `${local}@shore.local`];
}

export async function ensureWorkspaceGitRepo(workspaceDir: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (await exists(join(workspaceDir, ".git"))) return false;
  await mkdir(workspaceDir, { recursive: true });
  const init = await runGit(workspaceDir, ["init", "--quiet"], signal);
  if (init.code !== 0) throw gitOutputError("git init failed", init);
  return true;
}

export async function ensureWorkspaceGitRepoBestEffort(workspaceDir: string, signal?: AbortSignal): Promise<void> {
  try {
    await ensureWorkspaceGitRepo(workspaceDir, signal);
  } catch {
    signal?.throwIfAborted();
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

async function runGit(workspaceDir: string, args: string[], signal?: AbortSignal): Promise<ProcessOutput> {
  return await runProcess("git", [...GIT_SAFETY_FLAGS, ...args], {
    cwd: workspaceDir,
    env: envWithoutInheritedGitRepo(),
    signal,
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

export function runProcess(
  program: string,
  args: string[],
  options: { stdin?: string; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; signal?: AbortSignal | undefined },
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: grouped,
    });
    const stdout = boundedProcessOutput();
    const stderr = boundedProcessOutput();
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
      }
    };
    const cancel = (): void => {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted === true) cancel();
    child.stdin?.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    child.stdout?.on("data", stdout.accept);
    child.stderr?.on("data", stderr.accept);
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", cancel);
      clearTimeout(escalation);
      if (options.signal?.aborted === true) {
        kill("SIGKILL");
        const reason: unknown = options.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
        return;
      }
      if (failure !== undefined) { reject(failure); return; }
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}

function boundedProcessOutput() {
  const chunks: Buffer[] = [];
  const limit = 1024 * 1024;
  let bytes = 0;
  let truncated = false;
  return {
    accept: (chunk: Buffer): void => {
      const remaining = limit - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(kept);
        bytes += kept.length;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[process output truncated]" : ""),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
