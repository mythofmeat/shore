import { readFile, readdir, lstat, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { toF32, type Embedder } from "../llm/embed";
import { describeLlmError, type LlmError } from "../llm/errors";
import { compareRustStrings, rustLines, rustTrimStart, tokenizeQuery } from "./lines";
import { migrateLegacyIndex } from "./workspace_legacy.ts";
import {
  documentHash,
  withWorkspaceIndexLock,
  workspaceIndexDbPath,
  WorkspaceIndexStore,
  type FileRow,
} from "./workspace_store.ts";

const EMBED_BATCH_MAX_ITEMS = 32;

const EMBED_BATCH_MAX_CHARS = 96_000;

export function indexPath(cacheDir: string, character: string): string {
  return workspaceIndexDbPath(cacheDir, character);
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
  pendingFiles: number;
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
  embedPending?: boolean;
}

export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult> {
  const { workspaceDir, retrievalConfig, query, mode, embedder, pathFilter } = options;
  if (workspaceDir === "") throw WorkspaceIndexError.notConfigured();
  if (!(await pathExists(workspaceDir))) {
    return { files: [], searchedFiles: 0, embeddedFiles: 0, skippedBinaryOrLarge: 0, pendingFiles: 0 };
  }

  return await withWorkspaceIndexLock(options.indexPath, async () => {
    const store = WorkspaceIndexStore.open(options.indexPath);
    try {
      await migrateIfLegacy(store, options.indexPath, workspaceDir);

      const candidates = await enumerateFiles(workspaceDir, retrievalConfig);
      const existing = store.files();
      pruneAndScope(store, existing, candidates, pathFilter);

      const refreshed = await refreshIndexEntries(
        candidates,
        existing,
        retrievalConfig,
        (hash) => store.hasVector(embedder.modelId, hash),
      );
      store.deleteFiles(refreshed.removed);
      store.putFiles(refreshed.rows);

      let pendingFiles = refreshed.staleDocs.length;
      if (refreshed.staleDocs.length > 0 && options.embedPending !== false) {
        const vectors = await embedDocuments(embedder, refreshed.staleDocs);
        store.putEmbeddings(
          embedder.modelId,
          refreshed.stale.map((entry, i) => ({ hash: entry.hash, vector: vectors[i]! })),
        );
        store.putFiles(refreshed.stale.map((entry) => ({ ...entry.row, embedded: true })));
        store.setMetadata("last_indexed_at", new Date().toISOString());
        pendingFiles = 0;
      }

      const queryVector = await embedQuery(embedder, query);
      const scored = scoreCandidates(candidates, store, embedder.modelId, queryVector, mode, query);

      return {
        files: scored.files,
        searchedFiles: scored.searchedFiles,
        embeddedFiles: scored.embeddedFiles,
        skippedBinaryOrLarge: refreshed.skippedBinaryOrLarge,
        pendingFiles,
      };
    } finally {
      store.close();
    }
  });
}

export interface BackgroundIndexOptions {
  workspaceDir: string;
  retrievalConfig: RetrievalConfig;
  embedder: Embedder;
  indexPath: string;
  maxBatchItems?: number;
}

export interface BackgroundIndexOutcome {
  embedded: number;
  pending: number;
  files: number;
}

export async function indexPendingBatch(
  options: BackgroundIndexOptions,
): Promise<BackgroundIndexOutcome> {
  const { workspaceDir, retrievalConfig, embedder } = options;
  if (workspaceDir === "") return { embedded: 0, pending: 0, files: 0 };
  if (!(await pathExists(workspaceDir))) return { embedded: 0, pending: 0, files: 0 };

  return await withWorkspaceIndexLock(options.indexPath, async () => {
    const store = WorkspaceIndexStore.open(options.indexPath);
    try {
      await migrateIfLegacy(store, options.indexPath, workspaceDir);

      const candidates = await enumerateFiles(workspaceDir, retrievalConfig);
      const existing = store.files();
      pruneAndScope(store, existing, candidates, undefined);

      const refreshed = await refreshIndexEntries(
        candidates,
        existing,
        retrievalConfig,
        (hash) => store.hasVector(embedder.modelId, hash),
      );
      store.deleteFiles(refreshed.removed);
      store.putFiles(refreshed.rows);

      const limit = options.maxBatchItems ?? EMBED_BATCH_MAX_ITEMS;
      const batch = refreshed.stale.slice(0, limit);
      if (batch.length === 0) {
        store.pruneEmbeddings();
        return { embedded: 0, pending: 0, files: candidates.length };
      }

      const vectors = await embedDocuments(embedder, refreshed.staleDocs.slice(0, batch.length));
      store.putEmbeddings(
        embedder.modelId,
        batch.map((entry, i) => ({ hash: entry.hash, vector: vectors[i]! })),
      );
      store.putFiles(batch.map((entry) => ({ ...entry.row, embedded: true })));
      store.setMetadata("last_indexed_at", new Date().toISOString());

      return {
        embedded: batch.length,
        pending: refreshed.stale.length - batch.length,
        files: candidates.length,
      };
    } finally {
      store.close();
    }
  });
}

export async function workspaceIndexStats(dbPath: string) {
  return await withWorkspaceIndexLock(dbPath, async () => {
    const store = WorkspaceIndexStore.open(dbPath);
    try {
      return store.stats();
    } finally {
      store.close();
    }
  });
}

async function migrateIfLegacy(
  store: WorkspaceIndexStore,
  dbPath: string,
  workspaceDir: string,
): Promise<void> {
  if (store.metadata("migrated_from_json_at") !== undefined) return;
  const legacy = legacyPathFor(dbPath);
  const outcome = await migrateLegacyIndex(store, legacy, workspaceDir, documentForEmbedding);
  if (outcome === undefined) return;
  console.warn(
    `shore: migrated workspace index from JSON: ${outcome.files} files, ` +
      `${outcome.vectors} vectors carried over, ${outcome.stale} stale`,
  );
}

function legacyPathFor(dbPath: string): string {
  return join(dirname(dbPath), "workspace_index.json");
}

export interface StaleEntry {
  hash: string;
  row: FileRow;
}

export interface RefreshOutcome {
  stale: StaleEntry[];
  staleDocs: string[];
  skippedBinaryOrLarge: number;
  rows: FileRow[];
  removed: string[];
}

function pruneAndScope(
  store: WorkspaceIndexStore,
  existing: Map<string, FileRow>,
  candidates: FileCandidate[],
  pathFilter: string | undefined,
): void {
  const current = new Set(candidates.map((f) => f.displayPath));
  const gone = [...existing.keys()].filter((path) => !current.has(path));
  if (gone.length > 0) {
    store.deleteFiles(gone);
    for (const path of gone) existing.delete(path);
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
}

export async function refreshIndexEntries(
  candidates: FileCandidate[],
  existing: Map<string, FileRow>,
  retrievalConfig: RetrievalConfig,
  hasVector: (hash: string) => boolean,
): Promise<RefreshOutcome> {
  const stale: StaleEntry[] = [];
  const staleDocs: string[] = [];
  const rows: FileRow[] = [];
  const removed: string[] = [];
  let skippedBinaryOrLarge = 0;

  for (const file of candidates) {
    if (file.skipReason === "oversize") {
      skippedBinaryOrLarge += 1;
      pushIfChanged(rows, existing, skipRow(file, retrievalConfig, "oversize"));
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file.fsPath);
    } catch {
      file.skipReason = "read failed";
      if (existing.has(file.displayPath)) removed.push(file.displayPath);
      continue;
    }

    const text = decodeUtf8(bytes);
    if (text === undefined) {
      skippedBinaryOrLarge += 1;
      const reason = binarySkipReason(retrievalConfig.binary);
      file.skipReason = reason;
      pushIfChanged(rows, existing, skipRow(file, retrievalConfig, reason));
      continue;
    }

    file.content = text;
    const document = documentForEmbedding(
      file.displayPath,
      text,
      retrievalConfig.maxEmbedCharsPerFile,
    );
    const hash = documentHash(document);
    const row: FileRow = {
      display_path: file.displayPath,
      size: file.size,
      modified_at_secs: file.modifiedAtSecs,
      document_hash: hash,
      embed_chars: retrievalConfig.maxEmbedCharsPerFile,
      embedded: true,
      reason: undefined,
    };

    if (hasVector(hash)) {
      pushIfChanged(rows, existing, row);
      continue;
    }

    stale.push({ hash, row });
    staleDocs.push(document);
    pushIfChanged(rows, existing, { ...row, embedded: false });
  }

  return { stale, staleDocs, skippedBinaryOrLarge, rows, removed };
}

function skipRow(
  file: FileCandidate,
  retrievalConfig: RetrievalConfig,
  reason: string,
): FileRow {
  return {
    display_path: file.displayPath,
    size: file.size,
    modified_at_secs: file.modifiedAtSecs,
    document_hash: "",
    embed_chars: retrievalConfig.maxEmbedCharsPerFile,
    embedded: false,
    reason,
  };
}

function pushIfChanged(rows: FileRow[], existing: Map<string, FileRow>, row: FileRow): void {
  const before = existing.get(row.display_path);
  if (
    before !== undefined &&
    before.size === row.size &&
    before.modified_at_secs === row.modified_at_secs &&
    before.document_hash === row.document_hash &&
    before.embed_chars === row.embed_chars &&
    before.embedded === row.embedded &&
    before.reason === row.reason
  ) {
    return;
  }
  rows.push(row);
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
  store: WorkspaceIndexStore,
  modelId: string,
  queryVector: number[],
  mode: HybridMode,
  query: string,
): { files: ScoredFile[]; searchedFiles: number; embeddedFiles: number } {
  const qLower = query.toLowerCase();
  const terms = tokenizeQuery(qLower);
  const rows = store.files();
  const wanted: string[] = [];
  for (const file of candidates) {
    const row = rows.get(file.displayPath);
    if (row !== undefined && row.embedded) wanted.push(row.document_hash);
  }
  const vectors = store.vectorsFor(modelId, wanted);

  const scored: ScoredFile[] = candidates.map((file) => {
    const lexical =
      file.content === undefined ? 0 : lexicalScore(file.displayPath, file.content, qLower, terms);
    const row = rows.get(file.displayPath);
    const vector = row !== undefined && row.embedded ? vectors.get(row.document_hash) : undefined;
    return {
      displayPath: file.displayPath,
      fsPath: file.fsPath,
      content: file.content,
      lexicalScore: lexical,
      semanticScore: vector === undefined ? undefined : cosineSimilarity(queryVector, vector),
      combinedScore: 0,
      embedded: vector !== undefined,
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
  const trimmed = Array.from(content).slice(0, maxEmbedCharsPerFile).join("");
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

export function skipTag(size: number, modifiedAtSecs: number): string {
  return `mtime:${modifiedAtSecs}:${size}`;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
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
