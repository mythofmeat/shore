import { readFile, readdir, lstat, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { atomicWrite } from "../engine/atomic";
import { toF32, type Embedder } from "../llm/embed";
import { describeLlmError, type LlmError } from "../llm/errors";
import { compareRustStrings, rustLines, rustTrimStart, tokenizeQuery } from "./lines";

const EMBED_BATCH_MAX_ITEMS = 32;

const EMBED_BATCH_MAX_CHARS = 96_000;

const INDEX_FILE = "workspace_index.json";

export function indexPath(cacheDir: string, character: string): string {
  return join(cacheDir, "characters", character, INDEX_FILE);
}

export type WorkspaceIndexErrorKind = "not_configured" | "embedder" | "embedding_count_mismatch";

export class WorkspaceIndexError extends Error {
  readonly kind: WorkspaceIndexErrorKind;

  constructor(kind: WorkspaceIndexErrorKind, message: string) {
    super(message);
    this.name = "WorkspaceIndexError";
    this.kind = kind;
  }

  static notConfigured(): WorkspaceIndexError {
    return new WorkspaceIndexError("not_configured", "workspace not configured");
  }

  static embedder(detail: string): WorkspaceIndexError {
    return new WorkspaceIndexError("embedder", `embedder failed: ${detail}`);
  }

  static countMismatch(got: number, expected: number): WorkspaceIndexError {
    return new WorkspaceIndexError(
      "embedding_count_mismatch",
      `embedding count mismatch: got ${got}, expected ${expected}`,
    );
  }
}

export interface RetrievalConfig {
  maxFileBytes: number;
  maxIndexedFiles: number;
  maxTotalIndexedBytes: number;
  maxEmbedCharsPerFile: number;
  binary: "skip" | "metadata" | "try_embed";
}

export interface IndexedEntry {
  hash: string;
  size: number;
  modified_at_secs: number;
  model_id: string;
  max_embed_chars_per_file?: number;
  embedded: boolean;
  reason?: string;
  embedding: number[];
}

export interface WorkspaceIndex {
  entries: Map<string, IndexedEntry>;
}

export interface ScoredFile {
  displayPath: string;
  fsPath: string;
  content: string | undefined;
  semanticScore: number | undefined;
  lexicalScore: number;
  combinedScore: number;
  embedded: boolean;
  skipReason: string | undefined;
}

export interface HybridSearchResult {
  files: ScoredFile[];
  searchedFiles: number;
  embeddedFiles: number;
  skippedBinaryOrLarge: number;
}

export type HybridMode = "hybrid" | "vector";

const MODE_WEIGHTS: Record<HybridMode, { lexical: number; semantic: number }> = {
  hybrid: { lexical: toF32(0.45), semantic: toF32(0.55) },
  vector: { lexical: 0, semantic: 1 },
};

export interface FileCandidate {
  displayPath: string;
  fsPath: string;
  size: number;
  modifiedAtSecs: number;
  content: string | undefined;
  skipReason: string | undefined;
}

export interface HybridSearchOptions {
  workspaceDir: string;
  retrievalConfig: RetrievalConfig;
  query: string;
  mode: HybridMode;
  embedder: Embedder;
  indexPath: string;
  pathFilter?: string;
}

export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult> {
  const { workspaceDir, retrievalConfig, query, mode, embedder, pathFilter } = options;
  if (workspaceDir === "") throw WorkspaceIndexError.notConfigured();
  if (!(await pathExists(workspaceDir))) {
    return { files: [], searchedFiles: 0, embeddedFiles: 0, skippedBinaryOrLarge: 0 };
  }

  return await withIndexLock(options.indexPath, async () => {
    const index = await loadIndex(options.indexPath);
    const modelId = embedder.modelId;

    const candidates = await enumerateFiles(workspaceDir, retrievalConfig);
    let indexDirty = pruneAndScope(index, candidates, pathFilter);

    const refreshed = await refreshIndexEntries(candidates, index, retrievalConfig, modelId);
    indexDirty = indexDirty || refreshed.dirty;

    if (indexDirty) {
      await saveIndex(options.indexPath, index);
      indexDirty = false;
    }

    if (refreshed.staleDocs.length > 0) {
      await embedStaleEntries(
        embedder,
        index,
        refreshed.stale,
        refreshed.staleDocs,
        modelId,
        retrievalConfig,
      );
      indexDirty = true;
    }

    if (indexDirty) await saveIndex(options.indexPath, index);

    const queryVector = await embedQuery(embedder, query);
    const scored = scoreCandidates(candidates, index, queryVector, mode, query);

    return {
      files: scored.files,
      searchedFiles: scored.searchedFiles,
      embeddedFiles: scored.embeddedFiles,
      skippedBinaryOrLarge: refreshed.skippedBinaryOrLarge,
    };
  });
}

const indexLocks = new Map<string, Promise<void>>();

async function withIndexLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = indexLocks.get(key);
  const started = prior === undefined ? run() : prior.then(run);
  indexLocks.set(
    key,
    started.then(
      () => undefined,
      () => undefined,
    ),
  );
  return await started;
}

export interface RefreshOutcome {
  stale: [string, number, number][];
  staleDocs: string[];
  skippedBinaryOrLarge: number;
  dirty: boolean;
}

function pruneAndScope(
  index: WorkspaceIndex,
  candidates: FileCandidate[],
  pathFilter: string | undefined,
): boolean {
  let dirty = false;

  const current = new Set(candidates.map((f) => f.displayPath));
  for (const path of [...index.entries.keys()]) {
    if (!current.has(path)) {
      index.entries.delete(path);
      dirty = true;
    }
  }

  const prefix = pathFilter?.replace(/\/+$/, "");
  if (prefix !== undefined && prefix !== "") {
    const withSlash = `${prefix}/`;
    const kept = candidates.filter(
      (f) => f.displayPath === prefix || f.displayPath.startsWith(withSlash),
    );
    candidates.length = 0;
    candidates.push(...kept);
  }

  return dirty;
}

export async function refreshIndexEntries(
  candidates: FileCandidate[],
  index: WorkspaceIndex,
  retrievalConfig: RetrievalConfig,
  modelId: string,
): Promise<RefreshOutcome> {
  const stale: [string, number, number][] = [];
  const staleDocs: string[] = [];
  let skippedBinaryOrLarge = 0;
  let dirty = false;

  for (const file of candidates) {
    if (file.skipReason === "oversize") {
      skippedBinaryOrLarge += 1;
      index.entries.set(file.displayPath, {
        hash: skipTag(file.size, file.modifiedAtSecs),
        size: file.size,
        modified_at_secs: file.modifiedAtSecs,
        model_id: modelId,
        max_embed_chars_per_file: retrievalConfig.maxEmbedCharsPerFile,
        embedded: false,
        reason: "oversize",
        embedding: [],
      });
      dirty = true;
      continue;
    }

    const existing = index.entries.get(file.displayPath);
    const fresh =
      existing !== undefined &&
      existing.embedded &&
      existing.size === file.size &&
      existing.modified_at_secs === file.modifiedAtSecs &&
      existing.model_id === modelId &&
      existing.max_embed_chars_per_file === retrievalConfig.maxEmbedCharsPerFile;

    let bytes: Buffer;
    try {
      bytes = await readFile(file.fsPath);
    } catch {
      file.skipReason = "read failed";
      if (index.entries.delete(file.displayPath)) dirty = true;
      continue;
    }

    const text = decodeUtf8(bytes);
    if (text !== undefined) {
      if (!fresh) {
        stale.push([file.displayPath, file.size, file.modifiedAtSecs]);
        staleDocs.push(
          documentForEmbedding(file.displayPath, text, retrievalConfig.maxEmbedCharsPerFile),
        );
      }
      file.content = text;
    } else {
      skippedBinaryOrLarge += 1;
      const reason = binarySkipReason(retrievalConfig.binary);
      file.skipReason = reason;
      index.entries.set(file.displayPath, {
        hash: skipTag(file.size, file.modifiedAtSecs),
        size: file.size,
        modified_at_secs: file.modifiedAtSecs,
        model_id: modelId,
        max_embed_chars_per_file: retrievalConfig.maxEmbedCharsPerFile,
        embedded: false,
        reason,
        embedding: [],
      });
      dirty = true;
    }
  }

  return { stale, staleDocs, skippedBinaryOrLarge, dirty };
}

function binarySkipReason(mode: RetrievalConfig["binary"]): string {
  switch (mode) {
    case "skip":
      return "non-utf8";
    case "metadata":
      return "binary-metadata-only";
    case "try_embed":
      return "binary-embedding-unsupported";
  }
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function embedStaleEntries(
  embedder: Embedder,
  index: WorkspaceIndex,
  stale: [string, number, number][],
  staleDocs: string[],
  modelId: string,
  retrievalConfig: RetrievalConfig,
): Promise<void> {
  const vectors = await embedDocuments(embedder, staleDocs);
  for (const [i, [path, size, mtime]] of stale.entries()) {
    index.entries.set(path, {
      hash: skipTag(size, mtime),
      size,
      modified_at_secs: mtime,
      model_id: modelId,
      max_embed_chars_per_file: retrievalConfig.maxEmbedCharsPerFile,
      embedded: true,
      embedding: vectors[i]!,
    });
  }
}

async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  let vectors: number[][];
  try {
    vectors = await embedder.embed([query]);
  } catch (e) {
    throw WorkspaceIndexError.embedder(describeEmbedFailure(e));
  }
  const first = vectors[0];
  if (first === undefined) {
    throw WorkspaceIndexError.embedder("embedding response did not include query vector");
  }
  return first;
}

const LLM_ERROR_KINDS = new Set([
  "transport",
  "http_status",
  "serialize",
  "deserialize",
  "incomplete_stream",
  "stream_errored",
  "missing_api_key",
  "provider",
]);

function describeEmbedFailure(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    LLM_ERROR_KINDS.has((error as { kind?: unknown }).kind as string)
  ) {
    return describeLlmError(error as LlmError);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function scoreCandidates(
  candidates: FileCandidate[],
  index: WorkspaceIndex,
  queryVector: number[],
  mode: HybridMode,
  query: string,
): { files: ScoredFile[]; searchedFiles: number; embeddedFiles: number } {
  const qLower = query.toLowerCase();
  const terms = tokenizeQuery(qLower);

  const scored: ScoredFile[] = candidates.map((file) => {
    const lexical =
      file.content === undefined ? 0 : lexicalScore(file.displayPath, file.content, qLower, terms);
    const entry = index.entries.get(file.displayPath);
    const embedded = entry !== undefined && entry.embedded;
    return {
      displayPath: file.displayPath,
      fsPath: file.fsPath,
      content: file.content,
      lexicalScore: lexical,
      semanticScore: embedded ? cosineSimilarity(queryVector, entry.embedding) : undefined,
      combinedScore: 0,
      embedded,
      skipReason: file.skipReason,
    };
  });

  const maxLexCount = Math.max(1, ...scored.map((f) => f.lexicalScore));
  const maxLex = toF32(maxLexCount);
  const embeddedFiles = scored.filter((f) => f.semanticScore !== undefined).length;

  const { lexical: lw, semantic: sw } = MODE_WEIGHTS[mode];
  for (const f of scored) {
    const lexNorm = toF32(toF32(f.lexicalScore) / maxLex);
    const semantic = f.semanticScore ?? 0;
    const semNorm = Number.isNaN(semantic) ? 0 : Math.max(semantic, 0);
    f.combinedScore = toF32(toF32(lexNorm * lw) + toF32(semNorm * sw));
  }

  const searchedFiles = scored.length;
  const files = scored.filter((f) => f.combinedScore > 0);
  files.sort((a, b) => {
    if (b.combinedScore > a.combinedScore) return 1;
    if (b.combinedScore < a.combinedScore) return -1;
    return compareRustStrings(a.displayPath, b.displayPath);
  });

  return { files, searchedFiles, embeddedFiles };
}

export async function enumerateFiles(
  workspaceDir: string,
  retrievalConfig: RetrievalConfig,
): Promise<FileCandidate[]> {
  const pending: string[] = [workspaceDir];
  const out: FileCandidate[] = [];
  let totalBytes = 0;

  while (pending.length > 0) {
    if (out.length >= retrievalConfig.maxIndexedFiles) break;
    if (totalBytes >= retrievalConfig.maxTotalIndexedBytes) break;

    const path = pending.pop()!;
    let meta;
    try {
      meta = await lstat(path);
    } catch {
      continue;
    }

    if (meta.isSymbolicLink()) continue;

    if (basename(path) === ".git") continue;

    if (meta.isDirectory()) {
      let children: string[];
      try {
        children = await readdir(path);
      } catch {
        continue;
      }
      children.sort(compareRustStrings);
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(join(path, children[i]!));
      continue;
    }

    if (!meta.isFile()) continue;

    const size = meta.size;
    const skipReason = size > retrievalConfig.maxFileBytes ? "oversize" : undefined;

    if (skipReason === undefined) totalBytes += size;

    out.push({
      displayPath: displayPathFor(workspaceDir, path),
      fsPath: path,
      size,
      modifiedAtSecs: mtimeSecs(meta.mtimeMs),
      content: undefined,
      skipReason,
    });
  }

  return out;
}

function mtimeSecs(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return 0;
  return Math.floor(mtimeMs / 1000);
}

export function displayPathFor(workspaceDir: string, path: string): string {
  const rel = stripPrefix(path, workspaceDir);
  return (rel ?? path).replaceAll("\\", "/");
}

function unixComponents(p: string): string[] {
  const out: string[] = [];
  if (p.startsWith("/")) out.push("/");
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return out;
}

function stripPrefix(path: string, base: string): string | undefined {
  const p = unixComponents(path);
  const b = unixComponents(base);
  if (b.length > p.length) return undefined;
  for (let i = 0; i < b.length; i += 1) if (p[i] !== b[i]) return undefined;
  return p.slice(b.length).join("/");
}

export function lexicalScore(
  path: string,
  content: string,
  qLower: string,
  terms: string[],
): number {
  const pathLower = path.toLowerCase();
  const contentLower = content.toLowerCase();
  const titleLower = (
    rustLines(content).find((line) => rustTrimStart(line).startsWith("#")) ?? ""
  ).toLowerCase();

  let score = 0;
  if (pathLower.includes(qLower)) score += 50;
  if (titleLower.includes(qLower)) score += 40;
  if (contentLower.includes(qLower)) score += 30;
  for (const term of terms) {
    if (pathLower.includes(term)) score += 12;
    if (titleLower.includes(term)) score += 10;
    if (contentLower.includes(term)) score += 4;
  }
  return score;
}

export function documentForEmbedding(
  path: string,
  content: string,
  maxEmbedCharsPerFile: number,
): string {
  const trimmed = [...content].slice(0, maxEmbedCharsPerFile).join("");
  return `path: ${path}\n\n${trimmed}`;
}

function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

export async function embedDocuments(embedder: Embedder, docs: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  let start = 0;

  while (start < docs.length) {
    let end = start;
    let batchChars = 0;

    while (end < docs.length && end - start < EMBED_BATCH_MAX_ITEMS) {
      const docChars = charCount(docs[end]!);
      if (end > start && batchChars + docChars > EMBED_BATCH_MAX_CHARS) break;
      batchChars += docChars;
      end += 1;
    }

    const inputs = docs.slice(start, end);
    let batch: number[][];
    try {
      batch = await embedder.embed(inputs);
    } catch (e) {
      throw WorkspaceIndexError.embedder(describeEmbedFailure(e));
    }
    if (batch.length !== inputs.length) {
      throw WorkspaceIndexError.countMismatch(batch.length, inputs.length);
    }
    vectors.push(...batch);
    start = end;
  }

  return vectors;
}

export function skipTag(size: number, mtimeSecs: number): string {
  return `mtime:${mtimeSecs}:${size}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot = toF32(dot + toF32(x * y));
    na = toF32(na + toF32(x * x));
    nb = toF32(nb + toF32(y * y));
  }
  if (na === 0 || nb === 0) return 0;
  return toF32(dot / toF32(toF32(Math.sqrt(na)) * toF32(Math.sqrt(nb))));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadIndex(path: string): Promise<WorkspaceIndex> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { entries: new Map() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: new Map() };
  }
  return parseIndex(parsed) ?? { entries: new Map() };
}

function parseIndex(value: unknown): WorkspaceIndex | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entriesValue = (value as { entries?: unknown }).entries;
  if (typeof entriesValue !== "object" || entriesValue === null || Array.isArray(entriesValue)) {
    return undefined;
  }
  const entries = new Map<string, IndexedEntry>();
  for (const [path, raw] of Object.entries(entriesValue as Record<string, unknown>)) {
    const entry = parseEntry(raw);
    if (entry === undefined) return undefined;
    entries.set(path, entry);
  }
  return { entries };
}

function parseEntry(value: unknown): IndexedEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  if (typeof v.hash !== "string") return undefined;
  if (typeof v.model_id !== "string") return undefined;
  if (typeof v.embedded !== "boolean") return undefined;
  if (!Number.isInteger(v.size) || (v.size as number) < 0) return undefined;
  if (!Number.isInteger(v.modified_at_secs)) return undefined;

  let cap: number | undefined;
  if (v.max_embed_chars_per_file !== undefined && v.max_embed_chars_per_file !== null) {
    if (!Number.isInteger(v.max_embed_chars_per_file) || (v.max_embed_chars_per_file as number) < 0)
      return undefined;
    cap = v.max_embed_chars_per_file as number;
  }

  let reason: string | undefined;
  if (v.reason !== undefined && v.reason !== null) {
    if (typeof v.reason !== "string") return undefined;
    reason = v.reason;
  }

  let embedding: number[] = [];
  if (v.embedding !== undefined) {
    if (!Array.isArray(v.embedding)) return undefined;
    if (v.embedding.some((n) => typeof n !== "number")) return undefined;
    embedding = (v.embedding as number[]).map(toF32);
  }

  return {
    hash: v.hash,
    size: v.size as number,
    modified_at_secs: v.modified_at_secs as number,
    model_id: v.model_id,
    ...(cap !== undefined ? { max_embed_chars_per_file: cap } : {}),
    embedded: v.embedded,
    ...(reason !== undefined ? { reason } : {}),
    embedding,
  };
}

export function serializeIndex(index: WorkspaceIndex): string {
  const entries: Record<string, unknown> = {};
  for (const path of [...index.entries.keys()].sort(compareRustStrings)) {
    const e = index.entries.get(path)!;
    entries[path] = {
      hash: e.hash,
      size: e.size,
      modified_at_secs: e.modified_at_secs,
      model_id: e.model_id,
      ...(e.max_embed_chars_per_file !== undefined
        ? { max_embed_chars_per_file: e.max_embed_chars_per_file }
        : {}),
      embedded: e.embedded,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(e.embedding.length > 0 ? { embedding: e.embedding } : {}),
    };
  }
  return JSON.stringify({ entries }, null, 2);
}

async function saveIndex(path: string, index: WorkspaceIndex): Promise<void> {
  try {
    await atomicWrite(path, serializeIndex(index));
  } catch (e) {
    console.warn(`failed to persist workspace index at ${path}: ${String(e)}`);
  }
}
