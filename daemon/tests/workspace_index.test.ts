import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
import { tokenizeQuery } from "../src/memory/lines";
import {
  resolveEmbedder,
  type EmbeddingProvider,
  type EmbeddingSettings,
} from "../src/memory/retrieval";
import { defaultBaseUrl, hardcodedProviderBaseUrl } from "../src/llm/request";

const fixture = JSON.parse(
  readFileSync(new URL("./memory_fixtures/workspace_index.json", import.meta.url), "utf8"),
);

function f32(value: number | null): number | undefined {
  return value === null ? undefined : toF32(value);
}

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

function configOf(raw: Record<string, unknown>): RetrievalConfig {
  return {
    maxFileBytes: raw.max_file_bytes as number,
    maxIndexedFiles: raw.max_indexed_files as number,
    maxTotalIndexedBytes: raw.max_total_indexed_bytes as number,
    maxEmbedCharsPerFile: raw.max_embed_chars_per_file as number,
    binary: raw.binary as RetrievalConfig["binary"],
  };
}

const CORRECTED = new Set([
  "a same-size same-mtime rewrite is missed by design",
  "an entry recorded as not embedded is stale even when the tuple matches",
]);

describe("hybridSearch", () => {
  for (const c of fixture.cases.filter((c: any) => !CORRECTED.has(c.name))) {
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
            await new Promise<void>((resolve) => server.listen(join(ws, step.path), resolve));
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
          case "chmod":
            await chmod(join(ws, step.path), step.mode);
            break;
          case "seed_index":
            await mkdir(dirname(idx), { recursive: true });
            await writeFile(join(dirname(idx), "workspace_index.json"), step.raw);
            break;
          case "config":
            config = configOf(step.config);
            break;
          case "search": {
            const run = c.runs[runIdx];
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
            throw new Error(`unknown script op ${String(step.op)}`);
        }
      }
      for (const server of sockets) server.close();
      expect(runIdx).toBe(c.runs.length);
    });
  }
});

interface RunContext {
  workspaceDir: string;
  indexFile: string;
  embedder: TopicEmbedder;
  config: RetrievalConfig;
}

async function replayRun(run: Record<string, any>, ctx: RunContext): Promise<void> {
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
      pathFilter: run.path_filter ?? undefined,
    });
  } catch (e) {
    error = e;
  }
  const calls = ctx.embedder.takeCalls();

  if (run.outcome.error !== undefined) {
    expect(error).toBeInstanceOf(WorkspaceIndexError);
    expect((error as WorkspaceIndexError).message).toBe(run.outcome.error);
    await expectIndexOnDisk(ctx.indexFile, run.index_after, ctx.embedder.modelId);
    return;
  }
  if (error !== undefined) throw error;
  const got = result!;

  expect(got.searchedFiles).toBe(run.outcome.searched_files);
  expect(got.embeddedFiles).toBe(run.outcome.embedded_files);
  expect(got.skippedBinaryOrLarge).toBe(run.outcome.skipped_binary_or_large);

  if (run.counts_only) {
    expect(got.files).toEqual([]);
    const inputs = calls.reduce((n, batch) => n + batch.length, 0);
    expect(inputs).toBe(run.embed_input_count);
    return;
  }

  expect(got.files.map((f) => f.displayPath)).toEqual(
    run.outcome.files.map((f: any) => f.display_path),
  );
  for (const [i, expected] of run.outcome.files.entries()) {
    const actual = got.files[i]!;
    expect(actual.fsPath).toBe(expected.fs_path.replace("<tmp>", root));
    expect(actual.content).toBe(expected.content ?? undefined);
    expect(actual.lexicalScore).toBe(expected.lexical_score);
    expect(actual.semanticScore).toBe(f32(expected.semantic_score));
    expect(actual.combinedScore).toBe(toF32(expected.combined_score));
    expect(actual.embedded).toBe(expected.embedded);
    expect(actual.skipReason).toBe(expected.skip_reason ?? undefined);
  }

  expect(calls.map((b) => [...b].sort())).toEqual(
    (run.embed_calls as string[][]).map((b) => [...b].sort()),
  );
  if (calls.length > 0) expect(calls.at(-1)).toEqual([run.query]);

  await expectIndexOnDisk(ctx.indexFile, run.index_after, ctx.embedder.modelId);
}

async function expectIndexOnDisk(
  path: string,
  expected: unknown,
  model: string,
): Promise<void> {
  if (expected === null) {
    if (!(await Bun.file(path).exists())) return;
    expectIndexMatches(storedEntries(path, model), {});
    return;
  }
  expectIndexMatches(storedEntries(path, model), expectedEntries(expected));
}

function storedEntries(path: string, model: string): Record<string, unknown> {
  const store = WorkspaceIndexStore.open(path);
  try {
    const out: Record<string, unknown> = {};
    for (const [displayPath, row] of store.files()) {
      const vector = row.embedded
        ? store.vectorsFor(model, [row.document_hash]).get(row.document_hash)
        : undefined;
      out[displayPath] = {
        size: row.size,
        modified_at_secs: row.modified_at_secs,
        embedded: row.embedded,
        reason: row.reason ?? null,
        ...(vector === undefined ? {} : { embedding: f32s(vector) }),
      };
    }
    return out;
  } finally {
    store.close();
  }
}

function expectIndexMatches(
  got: Record<string, any>,
  want: Record<string, unknown>,
): void {
  const named = Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
  expect(named).toEqual(want);
  for (const [path, row] of Object.entries(got)) {
    if (path in want) continue;
    expect({ path, ...row }).toMatchObject({ path, embedded: false, reason: null });
  }
}

function expectedEntries(expected: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, e] of Object.entries(expected.entries as Record<string, any>)) {
    out[path] = {
      size: e.size,
      modified_at_secs: e.modified_at_secs,
      embedded: e.embedded,
      reason: e.reason ?? null,
      ...(e.embedding === undefined ? {} : { embedding: f32s(e.embedding) }),
    };
  }
  return out;
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

function indexShape(rows: Map<string, FileRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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

function expectedIndexShape(index: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, e] of Object.entries(index.entries as Record<string, any>)) {
    out[path] = {
      size: e.size,
      modified_at_secs: e.modified_at_secs,
      embedded: e.embedded,
      reason: e.reason ?? null,
    };
  }
  return out;
}

describe("refreshIndexEntries", () => {
  for (const c of fixture.refresh_index_entries.filter((c: any) => !CORRECTED.has(c.name))) {
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
      for (const [path, raw] of Object.entries(c.pre_index.entries as Record<string, any>)) {
        const embedded = raw.embedded === true && raw.model_id === "topic-v1";
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
        c.out.stale.map((s: any[]) => s[0]),
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
      (c: any) => c.delete_after_walk.length > 0,
    );
    expect(cases.length).toBeGreaterThan(0);
    const readable = cases.filter(
      (c: any) => !c.out.candidates.some((f: any) => f.skip_reason === "oversize"),
    );
    expect(readable.length).toBeGreaterThan(0);
    for (const c of readable) {
      expect(c.out.candidates.some((f: any) => f.skip_reason === "read failed")).toBe(true);
    }
    expect(readable.map((c: any) => c.out.dirty)).toContain(true);
    expect(readable.map((c: any) => c.out.dirty)).toContain(false);
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
    const withBom = fixture.lexical_score.find((c: any) => c.content.startsWith("﻿# tea"));
    const withNel = fixture.lexical_score.find((c: any) => c.content.startsWith("# tea"));
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
    const c = fixture.cosine_similarity.find((x: any) => x.name === "long accumulation order matters");
    const a = f32s(c.a);
    const b = f32s(c.b);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
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
      const docs = c.doc_char_counts.map((n: number, i: number) =>
        (i === 0 && c.name.includes("counts chars") ? "🌊" : "x").repeat(n),
      );
      const recorder = new TopicEmbedder(["never-matches"], "batch-probe", undefined, false);
      await embedDocuments(recorder, docs);
      expect(
        recorder.calls.map((b) => ({
          items: b.length,
          chars: b.reduce((n, d) => n + [...d].length, 0),
        })),
      ).toEqual(c.batches);
    });
  }

  test("the character cap counts code points, not UTF-16 units", async () => {
    const c = fixture.embed_batching.find((x: any) => x.name.includes("counts chars"));
    const docs = c.doc_char_counts.map((n: number) => "🌊".repeat(n));
    const recorder = new TopicEmbedder(["never-matches"], "batch-probe", undefined, false);
    await embedDocuments(recorder, docs);
    expect(recorder.calls.map((b) => b.length)).toEqual(c.batches.map((b: any) => b.items));
    expect(docs[0]!.length).toBe(c.doc_char_counts[0] * 2);
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
      (c: any) => (c.base_url ?? undefined) !== defaultBaseUrl(c.provider_key),
    );
    expect(disagreements.map((c: any) => c.provider_key).sort()).toEqual([
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
          defaultRef: c.default_ref ?? undefined,
          embedding,
          providers,
          fetchImpl: stubFetch,
        });

      if (c.outcome.error !== undefined) {
        expect(call).toThrow(String(c.outcome.error).replace(" (see CONFIGURATION.md).", "."));
        return;
      }
      const embedder = call();
      expect(embedder.modelId).toBe(c.outcome.model_id);
      expect(embedder.dimensions).toBe(c.outcome.dimensions ?? undefined);
      expect(call()).toBe(embedder);

      const parts = c.outcome.cache_key.split("::");
      const keyDimensions = parts.at(-1)!;
      const keyBaseUrl = parts.at(-2)!;
      expect(parts[0]).toBe(splitOnce(c.default_ref ?? Object.keys(embedding)[0]!, ":")[0]);
      expect(parts.slice(1, -2).join("::")).toBe(c.outcome.model_id);
      expect(keyDimensions).toBe(
        c.outcome.dimensions === null ? "native" : String(c.outcome.dimensions),
      );

      await embedder.embed(["x"]);
      expect(requested).toEqual([
        `${keyBaseUrl === "default" ? "https://api.openai.com/v1" : keyBaseUrl}/embeddings`,
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
        providers: { acme: { ...providers.acme!, baseUrl } },
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
    raw.exec("PRAGMA user_version = 9999");
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
    expect(second[0]!.size).toBe(first[0]!.size);
    expect(second[0]!.modifiedAtSecs).toBe(first[0]!.modifiedAtSecs);

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
    expect(got[0]!.modifiedAtSecs).toBe(0);
  });
});
