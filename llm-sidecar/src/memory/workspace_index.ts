/**
 * Workspace-wide embedding index and hybrid search.
 *
 * Ported from `crates/daemon/src/memory/workspace_index.rs`, pinned by
 * `tests/memory_fixtures/workspace_index_parity.json`.
 *
 * Walks the workspace under the same security rules the lexical `search` tool
 * uses (skip symlinks, skip `.git`, cap file size and total bytes, skip
 * non-UTF-8), embeds every text file once, and caches the vectors in a JSON
 * index under the Shore cache directory. Later searches re-embed only files
 * whose size, mtime, embedding model, or embedding character cap changed.
 *
 * Files that cannot be embedded are recorded with `embedded: false` and a
 * reason, so the walker does not re-read them on every query.
 *
 * Two naming conventions meet in this file, deliberately. {@link IndexedEntry}
 * is a *file format* — the Rust wrote these field names to disk and may still
 * read them back during the transition — so it keeps its snake_case. Everything
 * else is an in-memory value and reads as ordinary TypeScript.
 */

import { readFile, readdir, lstat, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { atomicWrite } from "../engine/atomic";
import { toF32, type Embedder } from "../llm/embed";
import { describeLlmError, type LlmError } from "../llm/errors";
import { compareRustStrings, rustLines, rustTrimStart, tokenizeQuery } from "./lines";

/** Most documents in one embedding request. */
const EMBED_BATCH_MAX_ITEMS = 32;

/** Most characters in one embedding request, across all its documents. */
const EMBED_BATCH_MAX_CHARS = 96_000;

const INDEX_FILE = "workspace_index.json";

/**
 * Where a character's index lives:
 * `<cacheDir>/characters/<character>/workspace_index.json`.
 */
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

/** Retrieval limits, from `[retrieval]` in the character's config. */
export interface RetrievalConfig {
  /** Largest file eligible for indexing, in bytes. */
  maxFileBytes: number;
  /** Hard cap on files walked. */
  maxIndexedFiles: number;
  /** Hard cap on cumulative bytes walked. */
  maxTotalIndexedBytes: number;
  /** Most characters of each file fed to the embedder. */
  maxEmbedCharsPerFile: number;
  /** What to do with a file that is not valid UTF-8. */
  binary: "skip" | "metadata" | "try_embed";
}

/**
 * One file's record in the persisted index.
 *
 * Freshness is `(size, modified_at_secs, model_id, max_embed_chars_per_file)`.
 * `hash` is informational: older index files held a SHA256 here, new ones hold
 * an `mtime:{secs}:{size}` tag, and the field survives only so those older
 * files still parse.
 */
export interface IndexedEntry {
  hash: string;
  size: number;
  modified_at_secs: number;
  model_id: string;
  max_embed_chars_per_file?: number;
  embedded: boolean;
  /** Why this file was not embedded. Absent when it was. */
  reason?: string;
  embedding: number[];
}

/** The persisted index: display path to record. */
export interface WorkspaceIndex {
  entries: Map<string, IndexedEntry>;
}

/** One file's contribution to a query result. */
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

/** A query's ranked files, with enough stats to describe what was searched. */
export interface HybridSearchResult {
  files: ScoredFile[];
  searchedFiles: number;
  embeddedFiles: number;
  skippedBinaryOrLarge: number;
}

/**
 * How lexical and semantic signals are fused.
 *
 * The Rust had an enum with a `weights()` method; the weights are the whole of
 * it, so a string union and one lookup say the same thing.
 */
export type HybridMode = "hybrid" | "vector";

/**
 * The blend weights, as f32.
 *
 * `Math.fround` is not decoration: `0.45` as a double is a different number
 * from `0.45f32`, and multiplying by the wrong one moves every combined score
 * in the last few bits — scores that are handed to the model verbatim.
 */
const MODE_WEIGHTS: Record<HybridMode, { lexical: number; semantic: number }> = {
  hybrid: { lexical: toF32(0.45), semantic: toF32(0.55) },
  vector: { lexical: 0, semantic: 1 },
};

/**
 * One file the walk turned up, before it has been read or scored.
 *
 * `content` and `skipReason` are filled in later, by `refreshIndexEntries`.
 */
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
  /** Restrict scoring to a subtree. Embeddings stay cached workspace-wide. */
  pathFilter?: string;
}

/**
 * Walk the workspace, refresh the embedding index, and rank files by
 * `combinedScore`. Files with no signal at all are dropped.
 *
 * Concurrent calls against the same index file serialize; different characters
 * hold different locks and do not block each other.
 */
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

    // Persist the prune and the skip records before embedding, so a transient
    // embedder failure does not throw the work away — the next call would
    // otherwise redo the same prune and re-mark the same skips.
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

/**
 * Per-index-path serialization of the load → mutate → save sequence.
 *
 * A single-threaded event loop is not enough on its own: `hybridSearch` awaits
 * between reading the index and writing it, so a heartbeat tick and a user
 * message can interleave and lose one of their updates.
 *
 * Entries are never removed, matching the Rust's `DashMap`. The map holds one
 * settled promise per character, and deleting on the way out would risk
 * dropping a lock a caller had already queued behind.
 */
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

/** Outputs of {@link refreshIndexEntries}. */
export interface RefreshOutcome {
  /** `[displayPath, size, modifiedAtSecs]` per file needing a fresh vector. */
  stale: [string, number, number][];
  /** The documents to embed, positionally aligned with `stale`. */
  staleDocs: string[];
  skippedBinaryOrLarge: number;
  /** Whether the index changed and needs writing. */
  dirty: boolean;
}

/**
 * Drop index entries whose files vanished or fell outside the walk, then scope
 * `candidates` to `pathFilter`. Returns whether the index changed.
 *
 * The prune is computed from the *unscoped* walk, so a path-scoped query does
 * not delete everything outside its scope. Scoping happens afterwards, and
 * only narrows what gets refreshed and ranked.
 */
export function pruneAndScope(
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

/**
 * Read each candidate's content and work out which need a fresh embedding.
 *
 * Freshness is the `(size, mtime, model, char cap)` tuple — no content hash.
 * The miss case is an editor that preserves mtime across a content change;
 * agent edits through `write`/`edit` always bump it, and any later real edit
 * self-corrects.
 */
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
      // The file was walked but cannot be read now — deleted under us, or
      // permissions changed. Drop any vector we still hold, so the file stops
      // turning up in results it can no longer justify.
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

/**
 * Decode strictly, or `undefined` when the bytes are not UTF-8.
 *
 * `ignoreBOM: true` is the opposite of what it sounds like: it means "treat a
 * leading U+FEFF as ordinary content" rather than silently swallowing it.
 * Rust's `String::from_utf8` keeps the BOM, and whether it survives decides
 * whether a heading is recognised as one.
 */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Embed the stale documents and write the vectors back into the index. */
async function embedStaleEntries(
  embedder: Embedder,
  index: WorkspaceIndex,
  stale: [string, number, number][],
  staleDocs: string[],
  modelId: string,
  retrievalConfig: RetrievalConfig,
): Promise<void> {
  // `embedDocuments` checks every batch against its own inputs, and `stale`
  // and `staleDocs` are pushed in lockstep, so the two lengths cannot differ
  // here. The Rust checked again anyway; the second check is dropped.
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

/** Embed the query and return its single vector. */
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

/**
 * The text that goes into `embedder failed: {…}`.
 *
 * The Rust interpolated `LlmError`'s `Display`, so the variant name is part of
 * the message a user sees — `provider error: …`, not the bare detail. An
 * embedder rejecting with anything else is a bug rather than a wire failure,
 * and gets whatever it can say for itself instead of `[object Object]`.
 */
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

/**
 * Score every candidate, drop the ones with no signal, and sort best-first.
 *
 * The lexical half is normalized against the best lexical score *in this
 * result set*, not an absolute scale — so the top lexical hit always
 * contributes its full weight regardless of how many terms happened to match.
 */
export function scoreCandidates(
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
    // Rust's `f32::max` returns the other operand when one side is NaN, where
    // `Math.max` propagates it. A NaN similarity is only reachable from a
    // hand-edited index, but the clamp is what keeps it out of the sort.
    const semantic = f.semanticScore ?? 0;
    const semNorm = Number.isNaN(semantic) ? 0 : Math.max(semantic, 0);
    f.combinedScore = toF32(toF32(lexNorm * lw) + toF32(semNorm * sw));
  }

  const searchedFiles = scored.length;
  const files = scored.filter((f) => f.combinedScore > 0);
  files.sort((a, b) => {
    // A NaN comparison is `Ordering::Equal` in the Rust, which falls through
    // to the path tiebreak rather than leaving the order unspecified.
    if (b.combinedScore > a.combinedScore) return 1;
    if (b.combinedScore < a.combinedScore) return -1;
    return compareRustStrings(a.displayPath, b.displayPath);
  });

  return { files, searchedFiles, embeddedFiles };
}

/**
 * Walk the workspace, depth-first, collecting indexable files.
 *
 * Directory entries are sorted before they are pushed, which the Rust did not
 * do. It matters only when a cap truncates the walk: the Rust took whatever
 * order the filesystem handed back, so *which* files a capped workspace
 * indexed varied by filesystem and could change between runs on the same tree.
 * Sorting makes a truncated walk reproducible; below the caps the result is
 * identical either way, since the final ranking is sorted anyway.
 */
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

    // Subsumed, strictly speaking: `lstat` reports a symlink as neither file
    // nor directory, so the `isFile` check below would drop it anyway — and
    // mutation testing duly finds this line unkillable. It stays because the
    // decision not to follow links out of the workspace belongs where it is
    // made, not as a side effect of how `lstat` reports types.
    if (meta.isSymbolicLink()) continue;

    // The workspace carries a git history of memory changes; the git store is
    // machine state, not indexable memory. Skipping it also keeps `.git` churn
    // from eating the caps, and keeps a linked worktree's `gitdir:` path — a
    // `.git` *file*, not a directory — out of the index.
    if (basename(path) === ".git") continue;

    if (meta.isDirectory()) {
      let children: string[];
      try {
        children = await readdir(path);
      } catch {
        continue;
      }
      // Pushed in reverse so the stack pops them in ascending order.
      children.sort(compareRustStrings);
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(join(path, children[i]!));
      continue;
    }

    if (!meta.isFile()) continue;

    const size = meta.size;
    const skipReason = size > retrievalConfig.maxFileBytes ? "oversize" : undefined;

    // Only files we will actually try to ingest count toward the byte cap. An
    // oversize file is recorded but never read, so letting its size
    // short-circuit the rest of the walk would hide the whole workspace behind
    // one big binary.
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

/**
 * Whole seconds since the epoch, or 0 for a timestamp before it.
 *
 * The Rust reached 0 by way of `duration_since(UNIX_EPOCH)` failing on a
 * pre-epoch mtime rather than by a deliberate clamp, but the value it stored
 * is the one freshness comparisons are made against, so it is the behaviour
 * that matters.
 */
function mtimeSecs(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return 0;
  return Math.floor(mtimeMs / 1000);
}

/**
 * The path as the index and the model see it: relative to the workspace root,
 * with backslashes normalized to forward slashes.
 *
 * Falls back to the absolute path when the file is not under the root, which
 * the walk should make impossible.
 */
export function displayPathFor(workspaceDir: string, path: string): string {
  const rel = stripPrefix(path, workspaceDir);
  return (rel ?? path).replaceAll("\\", "/");
}

/**
 * Split a path the way `std::path::Components` does on Unix: an absolute path
 * leads with a root component, and empty and `.` segments fall away. `\` is an
 * ordinary character in a filename here, which is why `displayPathFor`
 * substitutes it only *after* the comparison.
 */
function unixComponents(p: string): string[] {
  const out: string[] = [];
  if (p.startsWith("/")) out.push("/");
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return out;
}

/** `Path::strip_prefix`: component-wise, so `/wsx` is not inside `/ws`. */
function stripPrefix(path: string, base: string): string | undefined {
  const p = unixComponents(path);
  const b = unixComponents(base);
  if (b.length > p.length) return undefined;
  for (let i = 0; i < b.length; i += 1) if (p[i] !== b[i]) return undefined;
  return p.slice(b.length).join("/");
}

/**
 * A file's lexical relevance to a query.
 *
 * Three whole-query weights (path 50, heading 40, body 30) plus per-term ones
 * (12/10/4). A heading hit implies a body hit, so the tiers compound rather
 * than compete.
 */
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

/** The text handed to the embedder for one file. */
export function documentForEmbedding(
  path: string,
  content: string,
  maxEmbedCharsPerFile: number,
): string {
  const trimmed = [...content].slice(0, maxEmbedCharsPerFile).join("");
  return `path: ${path}\n\n${trimmed}`;
}

/** Count code points, as Rust's `chars().count()` does. */
function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * Embed documents in batches bounded by both item count and character count.
 *
 * A single document over the character cap still goes out on its own rather
 * than being dropped or split — the provider's own limit is the backstop, and
 * silently truncating here would make a file's vector disagree with its
 * content in a way nothing downstream could see.
 */
export async function embedDocuments(embedder: Embedder, docs: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  let start = 0;

  while (start < docs.length) {
    let end = start;
    let batchChars = 0;

    while (end < docs.length && end - start < EMBED_BATCH_MAX_ITEMS) {
      const docChars = charCount(docs[end]!);
      // `end > start` is what keeps a single over-cap document in its own
      // batch instead of an empty one: the first document of a batch is always
      // taken, whatever its size. The Rust followed this with an
      // `if end == start { end += 1 }` rescue, which can never fire for that
      // reason — dropped rather than reproduced as an unreachable line.
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

/**
 * The tag stored in `hash`. Freshness no longer reads it — that is the
 * `(size, mtime, model, char cap)` tuple — but the field stays so index files
 * written by older versions still parse.
 */
export function skipTag(size: number, mtimeSecs: number): string {
  return `mtime:${mtimeSecs}:${size}`;
}

/**
 * Cosine similarity, accumulated in f32 exactly as the Rust did.
 *
 * The rounding is the point. These scores reach the model as decimals, and an
 * f64 accumulation of the same vectors gives a visibly different number.
 */
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

// ── persistence ─────────────────────────────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the index, or start empty.
 *
 * Any problem — missing file, invalid JSON, a record with the wrong shape —
 * yields an empty index rather than an error. The index is a cache: rebuilding
 * it costs embedding calls, and refusing to search because it is corrupt would
 * cost the search entirely.
 */
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
    // A JSON decimal is the shortest text that round-trips the f32 the Rust
    // wrote; parsing it as a double lands one rounding away, and `fround`
    // takes it back to the exact value.
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

/**
 * Serialize in the Rust's field order, with keys in UTF-8 byte order and the
 * three optional fields omitted when unset — so the file stays readable by the
 * Rust half for as long as it is still there to read it.
 */
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

/**
 * Persist the index, or complain and carry on.
 *
 * A search that cannot cache its vectors is slower, not broken — so a failure
 * here must not take the query down with it.
 */
async function saveIndex(path: string, index: WorkspaceIndex): Promise<void> {
  try {
    await atomicWrite(path, serializeIndex(index));
  } catch (e) {
    console.warn(`failed to persist workspace index at ${path}: ${String(e)}`);
  }
}
