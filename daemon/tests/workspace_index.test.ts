import { required } from "../src/util/required.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bodyPreview,
  buildEmbedBody,
  clearEmbedderCache,
  parseEmbeddingResponse,
  toF32,
  type Embedder,
} from "../src/llm/embed";
import {
  cosineSimilarity,
  displayPathFor,
  documentForEmbedding,
  embedDocuments,
  enumerateFiles,
  hybridSearch,
  indexPath,
  lexicalScore,
  refreshIndexEntries,
  skipTag,
  WorkspaceIndexError,
  type HybridMode,
  type RetrievalConfig,
} from "../src/memory/workspace_index";
import {
  documentHash,
  WORKSPACE_INDEX_DB_FILE,
  WorkspaceIndexStore,
  type FileRow,
} from "../src/memory/workspace_store";
import { LEGACY_INDEX_FILE, migrateLegacyIndex } from "../src/memory/workspace_legacy";
import { compareRustStrings, tokenizeQuery } from "../src/memory/lines";
import {
  resolveEmbedder,
  type EmbeddingProvider,
  type EmbeddingSettings,
} from "../src/memory/retrieval";
import { defaultBaseUrl, hardcodedProviderBaseUrl } from "../src/llm/request";
import { expandShared } from "./support/shared_subtrees.ts";

interface RawConfig {
  binary: string;
  max_file_bytes: number;
  max_indexed_files: number;
  max_total_indexed_bytes: number;
  max_embed_chars_per_file: number;
}

interface RawEntry {
  size: number;
  modified_at_secs: number;
  embedded: boolean;
  reason?: string | null;
  embedding?: number[];
  hash?: string;
  model_id?: string;
  max_embed_chars_per_file?: number;
}

interface RawIndex {
  entries: Record<string, RawEntry>;
}

interface RunOutcome {
  error?: string;
  searched_files: number;
  embedded_files: number;
  skipped_binary_or_large: number;
  files: string[];
}

interface Run {
  config?: Partial<RawConfig>;
  query: string;
  mode: string;
  path_filter: string | null;
  counts_only: boolean;
  embedded_paths: string[][];
  embed_input_count: number;
  outcome: RunOutcome;
}

type ScriptStep =
  | { op: "write" | "write_outside"; path: string; text: string; mtime: number }
  | { op: "write_bytes"; path: string; bytes: number[]; mtime: number }
  | { op: "write_millis"; path: string; text: string; mtime_ms: number }
  | { op: "symlink"; path: string; target: string }
  | { op: "mkdir" | "delete" | "socket"; path: string }
  | { op: "seed_index"; raw: string }
  | { op: "config"; config: RawConfig }
  | { op: "search"; run: number }
  | { op: "block_index_parent" };

interface SearchCase {
  name: string;
  model: string;
  topics: string[];
  fail_embed: string | null;
  miscount_embed: boolean;
  missing_root: boolean;
  unconfigured: boolean;
  script: ScriptStep[];
  runs: Run[];
}

interface Candidate {
  display_path: string;
  size: number;
  modified_at_secs: number;
  content: string | null;
  skip_reason: string | null;
}

interface RefreshCase {
  name: string;
  config: RawConfig;
  files: { path: string; bytes: number[]; mtime: number }[];
  delete_after_walk: string[];
  pre_index: RawIndex;
  out: {
    candidates: Candidate[];
    stale: [string, number, number][];
    stale_docs: string[];
    index: RawIndex;
    dirty: boolean;
    skipped_binary_or_large: number;
  };
}

interface EmbedBatch {
  items: number;
  chars: number;
}

interface ResolveEmbedderCase {
  name: string;
  registry: {
    provider_key: string;
    base_url: string | null;
    entry: NonNullable<EmbeddingProvider["entry"]>;
  }[];
  default_ref: string | null;
  embedding: { key: string; dimensions: number | null }[];
  env: { var: string; value: string }[];
  outcome: { error?: string };
}

interface Fixture {
  cases: SearchCase[];
  refresh_index_entries: RefreshCase[];
  display_path_for: { name: string; workspace_dir: string; path: string; out: string }[];
  tokenize_query: { query: string; out: string[] }[];
  lexical_score: {
    name: string;
    path: string;
    content: string;
    query: string;
    q_lower: string;
    terms: string[];
    out: number;
  }[];
  cosine_similarity: { name: string; a: number[]; b: number[]; out: number }[];
  document_for_embedding: {
    name: string;
    path: string;
    content: string;
    max_embed_chars_per_file: number;
    out: string;
  }[];
  skip_tag: { size: number; mtime: number; out: string }[];
  index_path: { cache_dir: string; character: string; out: string }[];
  embed_batching: { name: string; doc_char_counts: number[]; batches: EmbedBatch[] }[];
  build_embed_body: {
    name: string;
    model: string;
    inputs: string[];
    dimensions: number | null;
    out: Record<string, unknown>;
  }[];
  parse_embedding_response: {
    name: string;
    response: unknown;
    expected_count: number;
    out: { error?: string; ok: number[][] };
  }[];
  retrieval: {
    hardcoded_base_url: { provider_key: string; base_url: string | null }[];
    resolve_embedder: ResolveEmbedderCase[];
  };
}

const fixture = expandShared<Fixture>(
  JSON.parse(
  readFileSync(new URL("./memory_captures/workspace_index.json", import.meta.url), "utf8"),
  ),
);

function f32s(values: ArrayLike<number>): number[] {
  return Array.from(values, toF32);
}

function vec(v: Float32Array | undefined): number[] | undefined {
  return v === undefined ? undefined : Array.from(v);
}

class TopicEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly calls: string[][] = [];
  readonly #topics: string[];
  readonly #fail: string | undefined;
  readonly #miscount: boolean;

  constructor(topics: string[], model: string, fail: string | undefined, miscount: boolean) {
    this.#topics = topics;
    this.modelId = model;
    this.dimensions = topics.length;
    this.#fail = fail;
    this.#miscount = miscount;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    this.calls.push([...inputs]);
    if (this.#fail !== undefined) throw { kind: "provider", message: this.#fail };
    const out = inputs.map((text) => {
      const lower = text.toLowerCase();
      return this.#topics.map((topic, i) => (lower.includes(topic) ? toF32(1 / (i + 3)) : 0));
    });
    if (this.#miscount) out.pop();
    return out;
  }

  takeCalls(): string[][] {
    return this.calls.splice(0);
  }
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wsi-parity-"));
  clearEmbedderCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAt(
  path: string,
  data: Buffer | string,
  mtime: number | Date,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  await utimes(path, mtime, mtime);
}

const DEFAULT_RETRIEVAL: RetrievalConfig = {
  maxFileBytes: 2097152,
  maxIndexedFiles: 50000,
  maxTotalIndexedBytes: 1073741824,
  maxEmbedCharsPerFile: 4000,
  binary: "skip",
};

function configOf(raw: Partial<RawConfig> | undefined): RetrievalConfig {
  return {
    maxFileBytes: raw?.max_file_bytes ?? DEFAULT_RETRIEVAL.maxFileBytes,
    maxIndexedFiles: raw?.max_indexed_files ?? DEFAULT_RETRIEVAL.maxIndexedFiles,
    maxTotalIndexedBytes: raw?.max_total_indexed_bytes ?? DEFAULT_RETRIEVAL.maxTotalIndexedBytes,
    maxEmbedCharsPerFile: raw?.max_embed_chars_per_file ?? DEFAULT_RETRIEVAL.maxEmbedCharsPerFile,
    binary: (raw?.binary as RetrievalConfig["binary"] | undefined) ?? DEFAULT_RETRIEVAL.binary,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

describe("hybridSearch", () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const ws = join(root, "workspace");
      const idx = join(root, "cache/workspace_index.db");
      if (!c.missing_root) await mkdir(ws, { recursive: true });

      const embedder = new TopicEmbedder(
        c.topics,
        c.model,
        c.fail_embed ?? undefined,
        c.miscount_embed,
      );
      let config: RetrievalConfig | undefined;
      let runIdx = 0;
      const sockets: Server[] = [];

      for (const step of c.script) {
        switch (step.op) {
          case "write":
            await writeAt(join(ws, step.path), step.text, step.mtime);
            break;
          case "write_bytes":
            await writeAt(join(ws, step.path), Buffer.from(step.bytes), step.mtime);
            break;
          case "write_outside":
            await writeAt(join(root, step.path), step.text, step.mtime);
            break;
          case "symlink":
            await mkdir(dirname(join(ws, step.path)), { recursive: true });
            await symlink(join(root, step.target), join(ws, step.path));
            break;
          case "mkdir":
            await mkdir(join(ws, step.path), { recursive: true });
            break;
          case "write_millis":
            await writeAt(join(ws, step.path), step.text, new Date(step.mtime_ms));
            break;
          case "socket": {
            await mkdir(dirname(join(ws, step.path)), { recursive: true });
            const server = createServer();
            await new Promise<void>((resolve) => {
              server.listen(join(ws, step.path), resolve);
            });
            sockets.push(server);
            break;
          }
          case "block_index_parent":
            await mkdir(dirname(dirname(idx)), { recursive: true });
            await writeFile(dirname(idx), "not a directory");
            break;
          case "delete":
            await rm(join(ws, step.path), { recursive: true, force: true });
            break;
          case "seed_index":
            await mkdir(dirname(idx), { recursive: true });
            await writeFile(join(dirname(idx), "workspace_index.json"), step.raw);
            break;
          case "config":
            config = configOf(step.config);
            break;
          case "search": {
            const run = must(c.runs[runIdx], `run ${runIdx} of ${c.name}`);
            runIdx += 1;
            await replayRun(run, {
              workspaceDir: c.unconfigured ? "" : ws,
              indexFile: idx,
              embedder,
              config: config ?? configOf(run.config),
            });
            break;
          }
          default:
            throw new Error(`unknown script op ${JSON.stringify(step)}`);
        }
      }
      for (const server of sockets) server.close();
      expect(runIdx).toBe(c.runs.length);
    });
  }
});

const MODE_WEIGHTS: Record<string, { lexical: number; semantic: number }> = {
  hybrid: { lexical: toF32(0.45), semantic: toF32(0.55) },
  vector: { lexical: 0, semantic: 1 },
};

function expectScoredAsClaimed(
  files: readonly {
    displayPath: string;
    fsPath: string;
    content?: string | undefined;
    lexicalScore: number;
    semanticScore?: number | undefined;
    combinedScore: number;
    embedded: boolean;
  }[],
  run: Run,
  workspaceDir: string,
): void {
  const where = `${run.mode} search for ${JSON.stringify(run.query)}`;
  const weights = required(MODE_WEIGHTS[run.mode]);
  const maxLex = toF32(Math.max(1, ...files.map((f) => f.lexicalScore)));
  const terms = tokenizeQuery(run.query.toLowerCase());

  let previous = Infinity;
  for (const file of files) {
    expect(file.fsPath, `${where}: ${file.displayPath} is that file inside the workspace`).toBe(
      join(workspaceDir, file.displayPath),
    );
    if (file.content !== undefined) {
      expect(
        readFileSync(file.fsPath, "utf8").startsWith(file.content),
        `${where}: ${file.displayPath} carries what is actually in the file`,
      ).toBe(true);
    }

    expect(
      file.lexicalScore,
      `${where}: ${file.displayPath} is scored on the words of the query`,
    ).toBe(lexicalScore(file.displayPath, file.content ?? "", run.query.toLowerCase(), terms));
    expect(
      file.embedded,
      `${where}: ${file.displayPath} has a semantic score exactly when it was embedded`,
    ).toBe(file.semanticScore !== undefined);
    if (file.semanticScore !== undefined) {
      expect(
        file.semanticScore >= -1.001 && file.semanticScore <= 1.001,
        `${where}: ${file.displayPath} scores as a cosine`,
      ).toBe(true);
    }

    const semantic = file.semanticScore ?? 0;
    const semNorm = Number.isNaN(semantic) ? 0 : Math.max(semantic, 0);
    expect(
      file.combinedScore,
      `${where}: ${file.displayPath} blends the two, the lexical half relative to the best`,
    ).toBe(
      toF32(
        toF32(toF32(toF32(file.lexicalScore) / maxLex) * weights.lexical) +
          toF32(semNorm * weights.semantic),
      ),
    );
    expect(
      file.combinedScore > 0,
      `${where}: ${file.displayPath} matched something, or it would not be here`,
    ).toBe(true);

    expect(file.combinedScore <= previous, `${where}: the best match comes first`).toBe(true);
    previous = file.combinedScore;
  }

  const byScore = new Map<number, string[]>();
  for (const file of files) {
    byScore.set(file.combinedScore, [...(byScore.get(file.combinedScore) ?? []), file.displayPath]);
  }
  for (const tied of byScore.values()) {
    expect(
      [...tied].sort(compareRustStrings),
      `${where}: files that score alike go in path order, byte by byte`,
    ).toEqual(tied);
  }
}

function pathOfDocument(document: string): string {
  const head = document.slice("path: ".length);
  const end = head.indexOf("\n\n");
  if (!document.startsWith("path: ") || end < 0) {
    throw new Error(`a document sent for embedding does not name its file: ${document.slice(0, 40)}`);
  }
  return head.slice(0, end);
}

interface RunContext {
  workspaceDir: string;
  indexFile: string;
  embedder: TopicEmbedder;
  config: RetrievalConfig;
}

async function replayRun(run: Run, ctx: RunContext): Promise<void> {
  ctx.embedder.takeCalls();

  let result: Awaited<ReturnType<typeof hybridSearch>> | undefined;
  let error: unknown;
  try {
    result = await hybridSearch({
      workspaceDir: ctx.workspaceDir,
      retrievalConfig: configOf(run.config),
      query: run.query,
      mode: run.mode as HybridMode,
      embedder: ctx.embedder,
      indexPath: ctx.indexFile,
      ...(run.path_filter === null ? {} : { pathFilter: run.path_filter }),
    });
  } catch (e) {
    error = e;
  }
  const calls = ctx.embedder.takeCalls();

  if (run.outcome.error !== undefined) {
    expect(error).toBeInstanceOf(WorkspaceIndexError);
    expect((error as WorkspaceIndexError).message).toBe(run.outcome.error);
    return;
  }
  if (error !== undefined) throw error;
  const got = required(result);

  expect(got.searchedFiles).toBe(run.outcome.searched_files);
  expect(got.embeddedFiles).toBe(run.outcome.embedded_files);
  expect(got.skippedBinaryOrLarge).toBe(run.outcome.skipped_binary_or_large);

  if (run.counts_only) {
    expect(got.files).toEqual([]);
    const inputs = calls.reduce((n, batch) => n + batch.length, 0);
    expect(inputs).toBe(run.embed_input_count);
    return;
  }

  expect(got.files.map((f) => f.displayPath), "the files it found, best first").toEqual(
    run.outcome.files,
  );
  expectScoredAsClaimed(got.files, run, ctx.workspaceDir);

  if (calls.length > 0) {
    expect(calls.at(-1), "the query itself is embedded last, on its own").toEqual([run.query]);
  }
  const documents = calls.slice(0, -1);
  expect(
    documents.map((batch) => [...batch].map(pathOfDocument).sort(compareStrings)),
    "the files embedded, batch by batch",
  ).toEqual(run.embedded_paths.map((batch) => [...batch].sort(compareStrings)));
  for (const document of documents.flat()) {
    const path = pathOfDocument(document);
    const body = document.slice(`path: ${path}\n\n`.length);
    const onDisk = readFileSync(join(ctx.workspaceDir, path), "utf8");
    expect(
      Array.from(onDisk).slice(0, ctx.config.maxEmbedCharsPerFile).join(""),
      `${path} is embedded as its path and its text, cut to the character cap`,
    ).toBe(body);
  }

  const again = await hybridSearch({
    workspaceDir: ctx.workspaceDir,
    retrievalConfig: configOf(run.config),
    query: run.query,
    mode: run.mode as HybridMode,
    embedder: ctx.embedder,
    indexPath: ctx.indexFile,
    ...(run.path_filter === null ? {} : { pathFilter: run.path_filter }),
  });
  const reEmbedded = ctx.embedder.takeCalls().reduce((n, b) => n + b.length, 0);

  expect(
    again.files.map((f) => f.displayPath),
    "re-running the same query returns the same files",
  ).toEqual(got.files.map((f) => f.displayPath));
  expect(
    again.files.map((f) => f.combinedScore),
    "and scores them the same",
  ).toEqual(got.files.map((f) => f.combinedScore));

  if (await Bun.file(ctx.indexFile).exists()) {
    expect(
      reEmbedded,
      "the index was written, so only the query itself is embedded again",
    ).toBeLessThanOrEqual(1);
  } else if (got.files.length > 0) {
    expect(
      reEmbedded,
      "with nowhere to write the index, the work is done again",
    ).toBeGreaterThanOrEqual(1);
  }
}

interface ComparableIndexEntry {
  embedded: boolean;
  embedding?: number[];
  modified_at_secs: number;
  reason: string | null;
  size: number;
}

interface FixtureIndexEntry extends ComparableIndexEntry {
  max_embed_chars_per_file?: number;
  model_id?: string;
}

interface FixtureIndex {
  entries: Record<string, FixtureIndexEntry>;
}

function expectIndexMatches(
  got: Record<string, ComparableIndexEntry>,
  want: Record<string, ComparableIndexEntry>,
): void {
  const named = Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
  expect(named).toEqual(want);
  for (const [path, row] of Object.entries(got)) {
    if (path in want) continue;
    expect({ path, ...row }).toMatchObject({ path, embedded: false, reason: null });
  }
}

function seededHash(fsPath: string, displayPath: string, cap: number): string {
  let text: string;
  try {
    text = readFileSync(fsPath, "utf8");
  } catch {
    return `absent:${displayPath}`;
  }
  return documentHash(documentForEmbedding(displayPath, text, cap));
}

function indexShape(rows: Map<string, FileRow>): Record<string, ComparableIndexEntry> {
  const out: Record<string, ComparableIndexEntry> = {};
  for (const [path, row] of rows) {
    out[path] = {
      size: row.size,
      modified_at_secs: row.modified_at_secs,
      embedded: row.embedded,
      reason: row.reason ?? null,
    };
  }
  return out;
}

function expectedIndexShape(index: unknown): Record<string, ComparableIndexEntry> {
  const out: Record<string, ComparableIndexEntry> = {};
  for (const [path, e] of Object.entries((index as FixtureIndex).entries)) {
    out[path] = {
      size: e.size,
      modified_at_secs: e.modified_at_secs,
      embedded: e.embedded,
      reason: e.reason ?? null,
    };
  }
  return out;
}

describe("deciding an indexed file needs re-embedding", () => {
  async function refresh(opts: {
    content: string;
    mtime: number;
    recorded?: { size: number; modified_at_secs: number; embedded: boolean };
    vectorFor?: "current" | "none";
  }) {
    const ws = join(root, "workspace");
    await mkdir(ws, { recursive: true });
    const rel = "note.md";
    const bytes = Buffer.from(opts.content);
    await writeAt(join(ws, rel), bytes, opts.mtime);

    const config = configOf(required(fixture.refresh_index_entries[0]).config);
    const candidates = await enumerateFiles(ws, config);
    const currentHash = seededHash(join(ws, rel), rel, config.maxEmbedCharsPerFile);

    const existing = new Map<string, FileRow>();
    if (opts.recorded !== undefined) {
      existing.set(rel, {
        display_path: rel,
        size: opts.recorded.size,
        modified_at_secs: opts.recorded.modified_at_secs,
        document_hash: currentHash,
        embed_chars: config.maxEmbedCharsPerFile,
        embedded: opts.recorded.embedded,
        reason: undefined,
      });
    }

    const has = (h: string) => opts.vectorFor === "current" && h === currentHash;
    const out = await refreshIndexEntries(candidates, existing, config, has);
    return out.stale.map((e) => e.row.display_path);
  }

  test("is decided by whether a vector exists for the content, not by size or mtime", async () => {
    const mtime = 1_700_000_000;
    const sameTuple = { size: 5, modified_at_secs: mtime, embedded: true };

    expect(
      await refresh({ content: "hello", mtime, recorded: sameTuple, vectorFor: "current" }),
      "a file whose vector is present is not re-embedded",
    ).toEqual([]);

    expect(
      await refresh({ content: "hello", mtime, recorded: sameTuple, vectorFor: "none" }),
      "the same file with no vector is, however unchanged the tuple looks",
    ).toContain("note.md");
  });

  test("a rewrite keeping the same size and mtime is caught, because the hash is not", async () => {
    const mtime = 1_700_000_000;
    const recorded = { size: 5, modified_at_secs: mtime, embedded: true };
    expect(
      await refresh({ content: "world", mtime, recorded, vectorFor: "none" }),
      "content can change without size or mtime moving",
    ).toContain("note.md");
  });

  test("a file the index has never seen is embedded", async () => {
    expect(await refresh({ content: "brand new", mtime: 1_700_000_000 })).toContain("note.md");
  });
});

describe("refreshIndexEntries", () => {
  for (const c of fixture.refresh_index_entries) {
    test(c.name, async () => {
      const ws = join(root, "workspace");
      await mkdir(ws, { recursive: true });
      for (const f of c.files) {
        await writeAt(join(ws, f.path), Buffer.from(f.bytes), f.mtime);
      }
      const config = configOf(c.config);
      const candidates = await enumerateFiles(ws, config);
      candidates.sort((a, b) => (a.displayPath < b.displayPath ? -1 : 1));
      for (const rel of c.delete_after_walk) await rm(join(ws, rel));

      const existing = new Map<string, FileRow>();
      const vectors = new Set<string>();
      for (const [path, raw] of Object.entries((c.pre_index as FixtureIndex).entries)) {
        const embedded = raw.embedded && raw.model_id === "topic-v1";
        const hash =
          embedded && raw.max_embed_chars_per_file === config.maxEmbedCharsPerFile
            ? seededHash(join(ws, path), path, config.maxEmbedCharsPerFile)
            : `stale:${path}`;
        existing.set(path, {
          display_path: path,
          size: raw.size,
          modified_at_secs: raw.modified_at_secs,
          document_hash: hash,
          embed_chars: raw.max_embed_chars_per_file ?? 0,
          embedded: raw.embedded,
          reason: raw.reason ?? undefined,
        });
        if (embedded && hash !== undefined) vectors.add(hash);
      }

      const out = await refreshIndexEntries(candidates, existing, config, (h) => vectors.has(h));

      expect(out.stale.map((s) => s.row.display_path)).toEqual(
        (c.out.stale as [string, unknown, unknown][]).map((s) => s[0]),
      );
      expect(out.staleDocs).toEqual(c.out.stale_docs);
      expect(out.skippedBinaryOrLarge).toBe(c.out.skipped_binary_or_large);
      expect(
        candidates.map((f) => ({
          display_path: f.displayPath,
          size: f.size,
          modified_at_secs: f.modifiedAtSecs,
          content: f.content ?? null,
          skip_reason: f.skipReason ?? null,
        })),
      ).toEqual(c.out.candidates);
      for (const path of out.removed) existing.delete(path);
      for (const row of out.rows) existing.set(row.display_path, row);
      expectIndexMatches(indexShape(existing), expectedIndexShape(c.out.index));
    });
  }

  test("a read failure is what the vanished-file cases actually exercise", () => {
    const cases = fixture.refresh_index_entries.filter(
      (c) => c.delete_after_walk.length > 0,
    );
    expect(cases.length).toBeGreaterThan(0);
    const readable = cases.filter(
      (c) => !c.out.candidates.some((f) => f.skip_reason === "oversize"),
    );
    expect(readable.length).toBeGreaterThan(0);
    for (const c of readable) {
      expect(c.out.candidates.some((f) => f.skip_reason === "read failed")).toBe(true);
    }
    expect(readable.map((c) => c.out.dirty)).toContain(true);
    expect(readable.map((c) => c.out.dirty)).toContain(false);
  });
});

describe("displayPathFor", () => {
  for (const c of fixture.display_path_for) {
    test(c.name, () => {
      expect(displayPathFor(c.workspace_dir, c.path)).toBe(c.out);
    });
  }
});

describe("tokenizeQuery", () => {
  for (const c of fixture.tokenize_query) {
    test(JSON.stringify(c.query), () => {
      expect(tokenizeQuery(c.query)).toEqual(c.out);
    });
  }
});

describe("lexicalScore", () => {
  for (const c of fixture.lexical_score) {
    test(c.name, () => {
      expect(c.q_lower).toBe(c.query.toLowerCase());
      expect(tokenizeQuery(c.q_lower)).toEqual(c.terms);
      expect(lexicalScore(c.path, c.content, c.q_lower, c.terms)).toBe(c.out);
    });
  }

  test("a BOM before a heading costs it the heading weight", () => {
    const withBom = must(
      fixture.lexical_score.find((c) => c.content.startsWith("\uFEFF# tea")),
      "a lexical_score case whose content starts with a BOM",
    );
    const withNel = must(
      fixture.lexical_score.find((c) => c.content.startsWith("\u0085# tea")),
      "a lexical_score case whose content starts with a NEL",
    );
    expect(withBom.out).toBe(34);
    expect(withNel.out).toBe(84);
  });
});

describe("cosineSimilarity", () => {
  for (const c of fixture.cosine_similarity) {
    test(c.name, () => {
      expect(cosineSimilarity(f32s(c.a), f32s(c.b))).toBe(toF32(c.out));
    });
  }

  test("the f32 accumulation is load-bearing", () => {
    const c = must(
      fixture.cosine_similarity.find((x) => x.name === "long accumulation order matters"),
      "the long-accumulation cosine case",
    );
    const a = f32s(c.a);
    const b = f32s(c.b);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += required(a[i]) * required(b[i]);
      na += required(a[i]) * required(a[i]);
      nb += required(b[i]) * required(b[i]);
    }
    expect(dot / (Math.sqrt(na) * Math.sqrt(nb))).not.toBe(toF32(c.out));
    expect(cosineSimilarity(a, b)).toBe(toF32(c.out));
  });
});

describe("documentForEmbedding", () => {
  for (const c of fixture.document_for_embedding) {
    test(c.name, () => {
      expect(documentForEmbedding(c.path, c.content, c.max_embed_chars_per_file)).toBe(c.out);
    });
  }
});

describe("skipTag", () => {
  for (const c of fixture.skip_tag) {
    test(`${c.size}/${c.mtime}`, () => {
      expect(skipTag(c.size, c.mtime)).toBe(c.out);
    });
  }
});

describe("indexPath", () => {
  for (const c of fixture.index_path) {
    test(`${c.cache_dir} / ${c.character}`, () => {
      expect(indexPath(c.cache_dir, c.character)).toBe(
        c.out.replace(/workspace_index\.json$/, WORKSPACE_INDEX_DB_FILE),
      );
    });
  }
});

describe("embedDocuments batching", () => {
  for (const c of fixture.embed_batching) {
    test(c.name, async () => {
      const docs = c.doc_char_counts.map((n, i) =>
        (i === 0 && c.name.includes("counts chars") ? "🌊" : "x").repeat(n),
      );
      const recorder = new TopicEmbedder(["never-matches"], "batch-probe", undefined, false);
      await embedDocuments(recorder, docs);
      expect(
        recorder.calls.map((b) => ({
          items: b.length,
          chars: b.reduce((n, d) => n + Array.from(d).length, 0),
        })),
      ).toEqual(c.batches);
    });
  }

  test("the character cap counts code points, not UTF-16 units", async () => {
    const c = must(
      fixture.embed_batching.find((x) => x.name.includes("counts chars")),
      "the character-counting embed_batching case",
    );
    const docs = c.doc_char_counts.map((n) => "🌊".repeat(n));
    const recorder = new TopicEmbedder(["never-matches"], "batch-probe", undefined, false);
    await embedDocuments(recorder, docs);
    expect(recorder.calls.map((b) => b.length)).toEqual(c.batches.map((b) => b.items));
    expect(docs[0]?.length).toBe(must(c.doc_char_counts[0], "a first document") * 2);
  });
});

describe("buildEmbedBody", () => {
  for (const c of fixture.build_embed_body) {
    test(c.name, () => {
      expect(buildEmbedBody(c.model, c.inputs, c.dimensions ?? undefined)).toEqual(c.out);
      expect(Object.keys(buildEmbedBody(c.model, c.inputs, c.dimensions ?? undefined))).toEqual(
        Object.keys(c.out),
      );
    });
  }
});

describe("parseEmbeddingResponse", () => {
  for (const c of fixture.parse_embedding_response) {
    test(c.name, () => {
      if (c.out.error !== undefined) {
        expect(() => parseEmbeddingResponse(c.response, c.expected_count)).toThrow();
        try {
          parseEmbeddingResponse(c.response, c.expected_count);
        } catch (e) {
          expect(c.out.error).toBe(`provider error: ${(e as { message: string }).message}`);
        }
      } else {
        expect(parseEmbeddingResponse(c.response, c.expected_count)).toEqual(
          c.out.ok.map((row: number[]) => f32s(row)),
        );
      }
    });
  }
});

describe("bodyPreview", () => {
  test("cuts by byte, on a character boundary", () => {
    expect(bodyPreview("abc", 10)).toBe("abc");
    expect(bodyPreview("abcdef", 3)).toBe("abc");
    expect(bodyPreview("🌊🌊", 4)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 5)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 7)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 8)).toBe("🌊🌊");
    expect(bodyPreview("é", 1)).toBe("");
  });
});

describe("hardcodedProviderBaseUrl", () => {
  for (const c of fixture.retrieval.hardcoded_base_url) {
    test(c.provider_key || "(empty)", () => {
      expect(hardcodedProviderBaseUrl(c.provider_key)).toBe(c.base_url ?? undefined);
    });
  }

  test("it is not the same table chat uses", () => {
    const disagreements = fixture.retrieval.hardcoded_base_url.filter(
      (c) => (c.base_url ?? undefined) !== defaultBaseUrl(c.provider_key),
    );
    expect(disagreements.map((c) => c.provider_key).sort(compareStrings)).toEqual([
      "anthropic",
      "deepseek",
      "nanogpt",
      "openai",
      "zai",
      "zhipuai",
    ]);
  });
});

describe("resolveEmbedder", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  for (const c of fixture.retrieval.resolve_embedder) {
    test(c.name, async () => {
      for (const e of c.env) {
        saved.set(e.var, process.env[e.var]);
        process.env[e.var] = e.value;
      }

      const providers: Record<string, EmbeddingProvider> = {};
      for (const p of c.registry) {
        providers[p.provider_key] = {
          entry: p.entry,
          ...(p.base_url !== null ? { baseUrl: p.base_url } : {}),
        };
      }
      const embedding: Record<string, EmbeddingSettings> = {};
      for (const e of c.embedding) {
        embedding[e.key] = e.dimensions === null ? {} : { dimensions: e.dimensions };
      }

      const requested: string[] = [];
      const stubFetch = (async (url: unknown) => {
        requested.push(String(url));
        return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const call = () =>
        resolveEmbedder({
          ...(c.default_ref === null ? {} : { defaultRef: c.default_ref }),
          embedding,
          providers,
          fetchImpl: stubFetch,
        });

      if (c.outcome.error !== undefined) {
        expect(call).toThrow(c.outcome.error.replace(" (see CONFIGURATION.md).", "."));
        return;
      }
      const embedder = call();

      const ref = c.default_ref ?? required(Object.keys(embedding)[0]);
      const [providerKey, modelId] = splitOnce(ref, ":");
      expect(embedder.modelId, "the model is the half of the identity after the colon").toBe(modelId);
      expect(embedder.dimensions, "the width comes from the overlay for that identity").toBe(
        embedding[ref]?.dimensions,
      );
      expect(call(), "resolving the same configuration twice reuses one embedder").toBe(embedder);

      const configured = c.registry.find((entry) => entry.provider_key === providerKey);
      const baseUrl =
        configured?.base_url ?? hardcodedProviderBaseUrl(providerKey) ?? "https://api.openai.com/v1";

      await embedder.embed(["x"]);
      expect(requested, "and it asks the endpoint the provider was given").toEqual([
        `${baseUrl}/embeddings`,
      ]);
    });
  }

  test("the cache key separates models, endpoints and widths", () => {
    process.env.SHORE_TEST_EMBED_CACHE = "k";
    saved.set("SHORE_TEST_EMBED_CACHE", undefined);
    const providers: Record<string, EmbeddingProvider> = {
      acme: {
        entry: {
          enabled: true,
          keys: [
            { name: "k", env: "SHORE_TEST_EMBED_CACHE", enabled: true, warn_on_fallback: false },
          ],
        },
        baseUrl: "https://acme.test/v1",
      },
    };
    const build = (target: string, dims: number | undefined, baseUrl: string) =>
      resolveEmbedder({
        defaultRef: target,
        embedding: dims === undefined ? {} : { [target]: { dimensions: dims } },
        providers: { acme: { ...required(providers.acme), baseUrl } },
      });

    const a = build("acme:m", undefined, "https://acme.test/v1");
    expect(build("acme:m", undefined, "https://acme.test/v1")).toBe(a);
    expect(build("acme:other", undefined, "https://acme.test/v1")).not.toBe(a);
    expect(build("acme:m", 512, "https://acme.test/v1")).not.toBe(a);
    expect(build("acme:m", undefined, "https://elsewhere.test/v1")).not.toBe(a);
  });
});

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

describe("index persistence", () => {
  test("a file row round-trips through the store", () => {
    const path = join(root, "rt.db");
    const store = WorkspaceIndexStore.open(path);
    const row: FileRow = {
      display_path: "a.md",
      size: 8,
      modified_at_secs: 1000,
      document_hash: "abc",
      embed_chars: 4000,
      embedded: true,
      reason: undefined,
    };
    store.putFiles([row]);
    store.close();

    const reopened = WorkspaceIndexStore.open(path);
    expect(reopened.files().get("a.md")).toEqual(row);
    reopened.close();
  });

  test("a vector round-trips as f32 without going through decimal text", () => {
    const store = WorkspaceIndexStore.open(join(root, "vec.db"));
    const vector = [1 / 3, -0.5, 0, 1e-8];
    store.putEmbeddings("topic-v1", [{ hash: "h", vector }]);
    expect(vec(store.vectorsFor("topic-v1", ["h"]).get("h"))).toEqual(f32s(vector));
    store.close();
  });

  test("the same document under two models keeps both vectors", () => {
    const store = WorkspaceIndexStore.open(join(root, "models.db"));
    store.putEmbeddings("old", [{ hash: "h", vector: [1, 0] }]);
    store.putEmbeddings("new", [{ hash: "h", vector: [0, 1] }]);
    expect(vec(store.vectorsFor("old", ["h"]).get("h"))).toEqual([1, 0]);
    expect(vec(store.vectorsFor("new", ["h"]).get("h"))).toEqual([0, 1]);
    expect(store.hasVector("other", "h")).toBe(false);
    store.close();
  });

  test("re-embedding one file rewrites one row, not the whole index", () => {
    const store = WorkspaceIndexStore.open(join(root, "one.db"));
    store.putEmbeddings("m", [
      { hash: "a", vector: [1, 0] },
      { hash: "b", vector: [0, 1] },
    ]);
    store.putEmbeddings("m", [{ hash: "a", vector: [0.5, 0.5] }]);
    expect(vec(store.vectorsFor("m", ["a"]).get("a"))).toEqual(f32s([0.5, 0.5]));
    expect(vec(store.vectorsFor("m", ["b"]).get("b"))).toEqual([0, 1]);
    store.close();
  });

  test("pruning drops vectors no live file points at", () => {
    const store = WorkspaceIndexStore.open(join(root, "prune.db"));
    store.putFiles([
      {
        display_path: "a.md",
        size: 1,
        modified_at_secs: 1,
        document_hash: "a",
        embed_chars: 10,
        embedded: true,
        reason: undefined,
      },
    ]);
    store.putEmbeddings("m", [
      { hash: "a", vector: [1] },
      { hash: "orphan", vector: [2] },
    ]);
    expect(store.pruneEmbeddings()).toBe(1);
    expect(store.hasVector("m", "a")).toBe(true);
    expect(store.hasVector("m", "orphan")).toBe(false);
    store.close();
  });

  test("a store whose schema version moved on is rebuilt, not read", () => {
    const path = join(root, "ver.db");
    const store = WorkspaceIndexStore.open(path);
    store.putEmbeddings("m", [{ hash: "h", vector: [1] }]);
    store.close();

    const raw = new Database(path, { readwrite: true });
    raw.run("PRAGMA user_version = 9999");
    raw.close();

    const reopened = WorkspaceIndexStore.open(path);
    expect(reopened.hasVector("m", "h")).toBe(false);
    expect(reopened.files().size).toBe(0);
    reopened.close();
  });
});

describe("freshness keyed on the document, not the tuple", () => {
  const config: RetrievalConfig = {
    maxFileBytes: 1_000_000,
    maxIndexedFiles: 100,
    maxTotalIndexedBytes: 1_000_000,
    maxEmbedCharsPerFile: 4000,
    binary: "skip",
  };

  test("a rewrite with the same size and mtime is caught", async () => {
    const ws = join(root, "ws-rewrite");
    await writeAt(join(ws, "a.md"), "tea aaa", 1000);

    const first = await enumerateFiles(ws, config);
    const before = await refreshIndexEntries(first, new Map(), config, () => false);
    expect(before.staleDocs).toEqual(["path: a.md\n\ntea aaa"]);

    const embedded = new Map<string, FileRow>(
      before.rows.map((r) => [r.display_path, { ...r, embedded: true }]),
    );
    const vectors = new Set(before.stale.map((s) => s.hash));

    await writeAt(join(ws, "a.md"), "tea bbb", 1000);
    const second = await enumerateFiles(ws, config);
    expect(required(second[0]).size).toBe(required(first[0]).size);
    expect(required(second[0]).modifiedAtSecs).toBe(required(first[0]).modifiedAtSecs);

    const after = await refreshIndexEntries(second, embedded, config, (h) => vectors.has(h));
    expect(after.staleDocs).toEqual(["path: a.md\n\ntea bbb"]);
  });

  test("a skip record for a file that is now readable is replaced, not kept", async () => {
    const ws = join(root, "ws-reason");
    await writeAt(join(ws, "a.md"), "tea", 1000);
    const candidates = await enumerateFiles(ws, config);
    const existing = new Map<string, FileRow>([
      [
        "a.md",
        {
          display_path: "a.md",
          size: 3,
          modified_at_secs: 1000,
          document_hash: "",
          embed_chars: 4000,
          embedded: false,
          reason: "non-utf8",
        },
      ],
    ]);

    const out = await refreshIndexEntries(candidates, existing, config, () => false);

    expect(out.staleDocs).toEqual(["path: a.md\n\ntea"]);
    expect(out.rows).toEqual([
      {
        display_path: "a.md",
        size: 3,
        modified_at_secs: 1000,
        document_hash: documentHash("path: a.md\n\ntea"),
        embed_chars: 4000,
        embedded: false,
        reason: undefined,
      },
    ]);
  });

  test("a file that comes back unchanged is not re-embedded", async () => {
    const ws = join(root, "ws-stable");
    await writeAt(join(ws, "a.md"), "tea", 1000);
    const candidates = await enumerateFiles(ws, config);
    const first = await refreshIndexEntries(candidates, new Map(), config, () => false);
    const vectors = new Set(first.stale.map((s) => s.hash));
    const embedded = new Map<string, FileRow>(
      first.rows.map((r) => [r.display_path, { ...r, embedded: true }]),
    );

    const again = await enumerateFiles(ws, config);
    const out = await refreshIndexEntries(again, embedded, config, (h) => vectors.has(h));

    expect(out.staleDocs).toEqual([]);
    expect(out.rows).toEqual([]);
  });
});

describe("legacy JSON migration", () => {
  async function seed(raw: string, files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(root, "mig-"));
    const ws = join(dir, "workspace");
    for (const [path, text] of Object.entries(files)) {
      await writeAt(join(ws, path), text, 1000);
    }
    await writeFile(join(dir, LEGACY_INDEX_FILE), raw);
    return dir;
  }

  function legacyJson(entries: Record<string, unknown>): string {
    return JSON.stringify({ entries });
  }

  test("a vector is carried over and the file is not re-embedded", async () => {
    const dir = await seed(
      legacyJson({
        "a.md": {
          hash: "mtime:1000:5",
          size: 5,
          modified_at_secs: 1000,
          model_id: "topic-v1",
          max_embed_chars_per_file: 4000,
          embedded: true,
          embedding: [0.25, 0.5],
        },
      }),
      { "a.md": "hello" },
    );
    const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
    const out = await migrateLegacyIndex(
      store,
      join(dir, LEGACY_INDEX_FILE),
      join(dir, "workspace"),
      documentForEmbedding,
    );

    expect(out).toEqual({ files: 1, vectors: 1, stale: 0 });
    const hash = seededHash(join(dir, "workspace", "a.md"), "a.md", 4000);
    expect(store.hasVector("topic-v1", hash)).toBe(true);
    expect(vec(store.vectorsFor("topic-v1", [hash]).get(hash))).toEqual(f32s([0.25, 0.5]));
    expect(store.files().get("a.md")?.embedded).toBe(true);
    store.close();
  });

  test("the JSON file is deleted once it has been drained", async () => {
    const dir = await seed(legacyJson({}), {});
    const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
    await migrateLegacyIndex(
      store,
      join(dir, LEGACY_INDEX_FILE),
      join(dir, "workspace"),
      documentForEmbedding,
    );
    store.close();
    expect(await Bun.file(join(dir, LEGACY_INDEX_FILE)).exists()).toBe(false);
  });

  test("a vector whose file has changed underneath it is dropped, not trusted", async () => {
    const dir = await seed(
      legacyJson({
        "a.md": {
          hash: "mtime:1000:5",
          size: 999,
          modified_at_secs: 1000,
          model_id: "topic-v1",
          max_embed_chars_per_file: 4000,
          embedded: true,
          embedding: [0.25, 0.5],
        },
      }),
      { "a.md": "hello" },
    );
    const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
    const out = await migrateLegacyIndex(
      store,
      join(dir, LEGACY_INDEX_FILE),
      join(dir, "workspace"),
      documentForEmbedding,
    );
    expect(out).toEqual({ files: 0, vectors: 0, stale: 1 });
    store.close();
  });

  test("skip records survive the move with their reason", async () => {
    const dir = await seed(
      legacyJson({
        "big.bin": {
          hash: "mtime:1000:9",
          size: 9,
          modified_at_secs: 1000,
          model_id: "topic-v1",
          max_embed_chars_per_file: 4000,
          embedded: false,
          reason: "oversize",
        },
      }),
      {},
    );
    const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
    await migrateLegacyIndex(
      store,
      join(dir, LEGACY_INDEX_FILE),
      join(dir, "workspace"),
      documentForEmbedding,
    );
    expect(store.files().get("big.bin")).toMatchObject({
      embedded: false,
      reason: "oversize",
    });
    store.close();
  });

  test("a malformed legacy file migrates to nothing rather than throwing", async () => {
    for (const raw of [
      "not json at all { [ }",
      "[1, 2, 3]",
      '{"entries": []}',
      '{"entries": {"a.md": 3}}',
      '{"entries": {"a.md": {"hash": "h"}}}',
      '{"entries": {"a.md": {"hash": 1, "size": 1, "modified_at_secs": 1, "model_id": "m", "embedded": true}}}',
      '{"entries": {"a.md": {"hash": "h", "size": 1.5, "modified_at_secs": 1, "model_id": "m", "embedded": true}}}',
      '{"entries": {"a.md": {"hash": "h", "size": 1, "modified_at_secs": 1, "model_id": "m", "embedded": "yes"}}}',
      '{"entries": {"a.md": {"hash": "h", "size": 1, "modified_at_secs": 1, "model_id": "m", "embedded": true, "embedding": ["x"]}}}',
      "{}",
    ]) {
      const dir = await seed(raw, {});
      const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
      const out = await migrateLegacyIndex(
        store,
        join(dir, LEGACY_INDEX_FILE),
        join(dir, "workspace"),
        documentForEmbedding,
      );
      expect(out).toEqual({ files: 0, vectors: 0, stale: 0 });
      expect(store.files().size).toBe(0);
      store.close();
    }
  });

  test("no legacy file at all is not a migration", async () => {
    const dir = await mkdtemp(join(root, "none-"));
    const store = WorkspaceIndexStore.open(join(dir, "workspace_index.db"));
    const out = await migrateLegacyIndex(
      store,
      join(dir, LEGACY_INDEX_FILE),
      dir,
      documentForEmbedding,
    );
    expect(out).toBeUndefined();
    store.close();
  });
});

describe("enumerateFiles", () => {
  test("a capped walk keeps the same files every time", async () => {
    const ws = join(root, "ws");
    for (let i = 0; i < 30; i += 1) await writeAt(join(ws, `f${i}.md`), "x", 1000);
    await writeAt(join(ws, "sub", "deep.md"), "x", 1000);
    const config: RetrievalConfig = {
      maxFileBytes: 1000,
      maxIndexedFiles: 7,
      maxTotalIndexedBytes: 1000,
      maxEmbedCharsPerFile: 100,
      binary: "skip",
    };
    const first = (await enumerateFiles(ws, config)).map((f) => f.displayPath);
    const second = (await enumerateFiles(ws, config)).map((f) => f.displayPath);
    expect(first).toEqual(second);
    expect(first.length).toBe(7);
    expect(first).toEqual([...first].sort());
  });

  test("a pre-epoch mtime is recorded as zero", async () => {
    const ws = join(root, "ws2");
    await writeAt(join(ws, "old.md"), "x", new Date(-86_400_000));
    const got = await enumerateFiles(ws, {
      maxFileBytes: 1000,
      maxIndexedFiles: 10,
      maxTotalIndexedBytes: 1000,
      maxEmbedCharsPerFile: 100,
      binary: "skip",
    });
    expect(required(got[0]).modifiedAtSecs).toBe(0);
  });
});
