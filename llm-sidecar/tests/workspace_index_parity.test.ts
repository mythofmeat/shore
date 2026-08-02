/**
 * Replays `memory_fixtures/workspace_index_parity.json` against the TypeScript
 * workspace index, its embedder plumbing, and embedder resolution.
 *
 * Every expected value is what the real Rust in
 * `crates/daemon/src/memory/workspace_index.rs`, `memory/retrieval.rs` and
 * `llm/embed.rs` returned, or left on disk, in a throwaway worktree at
 * `9023b46d`. Nothing here asserts against a hand-written expectation.
 *
 * Each end-to-end case is a *script*: a sequence of filesystem edits, config
 * changes and searches, replayed in order against a fresh temp tree. Several
 * of the behaviours only exist across two searches — an unchanged file must
 * not be re-embedded, a deleted one must be pruned — so a single-shot
 * comparison would miss them entirely.
 *
 * Three things are handled explicitly rather than waved through:
 *
 * - **Floats.** Embeddings and scores are f32 the whole way. A JSON decimal is
 *   the shortest text that round-trips the f32 the Rust wrote, so parsing it
 *   as a double lands one rounding away; every number read out of the fixture
 *   goes through `Math.fround` before it is compared, and the TypeScript does
 *   its arithmetic in f32 too. Comparisons are exact — no epsilon.
 * - **Walk order.** Which files survive a truncated walk depended on the order
 *   the filesystem handed back directory entries, so the capped cases record
 *   counts only and query for something that matches nothing. The TypeScript
 *   sorts, which is a deliberate divergence noted at `enumerateFiles`.
 * - **The tmp root** appears in `fs_path`. The generator wrote it as `<tmp>`
 *   so the replay can substitute its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  loadIndex,
  refreshIndexEntries,
  serializeIndex,
  skipTag,
  WorkspaceIndexError,
  type HybridMode,
  type RetrievalConfig,
  type WorkspaceIndex,
} from "../src/memory/workspace_index";
import { tokenizeQuery } from "../src/memory/lines";
import {
  embeddingProviderBaseUrl,
  resolveEmbedder,
  type EmbeddingProvider,
  type EmbeddingSettings,
} from "../src/memory/retrieval";

const fixture = JSON.parse(
  readFileSync(new URL("./memory_fixtures/workspace_index_parity.json", import.meta.url), "utf8"),
);

/** Every float the fixture carries is an f32 the Rust wrote. */
function f32(value: number | null): number | undefined {
  return value === null ? undefined : toF32(value);
}

function f32s(values: number[]): number[] {
  return values.map(toF32);
}

// ── the embedder the generator used ─────────────────────────────────────

/**
 * The generator's `GenEmbedder`, reimplemented from its recorded topic list.
 *
 * Topic `i` contributes `1.0 / (i + 3)` rather than `1.0`, so cosine
 * similarity genuinely rounds in f32 rather than falling out exact.
 */
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
    return this.calls.splice(0, this.calls.length);
  }
}

// ── temp tree ───────────────────────────────────────────────────────────

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

// ── end-to-end scripts ──────────────────────────────────────────────────

describe("hybridSearch", () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const ws = join(root, "workspace");
      const idx = join(root, "cache/workspace_index.json");
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
            await writeFile(idx, step.raw);
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
    // The prune and the skip records are written *before* the embed call, so a
    // failed search still has to have left them behind.
    await expectIndexOnDisk(ctx.indexFile, run.index_after);
    return;
  }
  if (error !== undefined) throw error;
  const got = result!;

  expect(got.searchedFiles).toBe(run.outcome.searched_files);
  expect(got.embeddedFiles).toBe(run.outcome.embedded_files);
  expect(got.skippedBinaryOrLarge).toBe(run.outcome.skipped_binary_or_large);

  if (run.counts_only) {
    // Which files a truncated walk kept is filesystem-order dependent, so only
    // the arithmetic of the caps is comparable. The query matches nothing, so
    // the file list is empty either way and the counts are the whole content.
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

  // Compared batch by batch, with each batch's inputs sorted. The *number* of
  // calls, and which documents went in which one, is the whole of the batching
  // contract; the order within a batch follows the walk, and this port sorts
  // the walk where the Rust took the filesystem's order (see `enumerateFiles`).
  expect(calls.map((b) => [...b].sort())).toEqual(
    (run.embed_calls as string[][]).map((b) => [...b].sort()),
  );
  // The query is always embedded last, on its own — except when the walk never
  // happened at all, which is the missing-root case's whole point.
  if (calls.length > 0) expect(calls.at(-1)).toEqual([run.query]);

  await expectIndexOnDisk(ctx.indexFile, run.index_after);
}

async function expectIndexOnDisk(path: string, expected: unknown): Promise<void> {
  if (expected === null) {
    // Either nothing was ever written, or the path was deliberately blocked.
    const text = await Bun.file(path)
      .text()
      .catch(() => undefined);
    expect(text).toBeUndefined();
    return;
  }
  const onDisk = JSON.parse(await Bun.file(path).text());
  expect(normalizeIndexJson(onDisk)).toEqual(normalizeIndexJson(expected));
}

/**
 * Compare the persisted index by value, not byte for byte.
 *
 * The two runtimes print the same f32 differently — Rust writes the shortest
 * decimal that round-trips an f32, JavaScript the shortest that round-trips a
 * double — so `0.33333334` and `0.3333333432674408` are the same number
 * written two ways. Rounding both sides to f32 compares what the file *means*,
 * which is also what either runtime reads back out of it.
 */
function normalizeIndexJson(index: any): any {
  const entries: Record<string, unknown> = {};
  for (const [path, e] of Object.entries(index.entries as Record<string, any>)) {
    entries[path] = { ...e, ...(e.embedding !== undefined ? { embedding: f32s(e.embedding) } : {}) };
  }
  return { entries };
}

// ── the refresh phase on its own ────────────────────────────────────────

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

      const index: WorkspaceIndex = { entries: new Map() };
      for (const [path, raw] of Object.entries(c.pre_index.entries as Record<string, any>)) {
        index.entries.set(path, {
          ...raw,
          embedding: raw.embedding === undefined ? [] : f32s(raw.embedding),
        });
      }

      const out = await refreshIndexEntries(candidates, index, config, "topic-v1");

      expect(out.stale).toEqual(c.out.stale);
      expect(out.staleDocs).toEqual(c.out.stale_docs);
      expect(out.skippedBinaryOrLarge).toBe(c.out.skipped_binary_or_large);
      expect(out.dirty).toBe(c.out.dirty);
      expect(
        candidates.map((f) => ({
          display_path: f.displayPath,
          size: f.size,
          modified_at_secs: f.modifiedAtSecs,
          content: f.content ?? null,
          skip_reason: f.skipReason ?? null,
        })),
      ).toEqual(c.out.candidates);
      expect(normalizeIndexJson(JSON.parse(serializeIndex(index)))).toEqual(
        normalizeIndexJson(c.out.index),
      );
    });
  }

  test("a read failure is what the vanished-file cases actually exercise", () => {
    // The container this ran in is root, where mode 000 does not deny a read,
    // so a chmod-based case would have recorded a successful read and pinned
    // nothing. Deleting the file between the walk and the refresh reaches the
    // same branch for the same reason it exists.
    const cases = fixture.refresh_index_entries.filter(
      (c: any) => c.delete_after_walk.length > 0,
    );
    expect(cases.length).toBeGreaterThan(0);
    // An oversize candidate is recorded before anything is read, so it never
    // reaches the branch; every other vanished file does.
    const readable = cases.filter(
      (c: any) => !c.out.candidates.some((f: any) => f.skip_reason === "oversize"),
    );
    expect(readable.length).toBeGreaterThan(0);
    for (const c of readable) {
      expect(c.out.candidates.some((f: any) => f.skip_reason === "read failed")).toBe(true);
    }
    // One of them held an index entry for the vanished file and one did not:
    // that is the whole of what `dirty` reports here.
    expect(readable.map((c: any) => c.out.dirty)).toContain(true);
    expect(readable.map((c: any) => c.out.dirty)).toContain(false);
  });
});

// ── pure functions ──────────────────────────────────────────────────────

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
      // The query is lowercased and tokenized by the caller; the fixture
      // recorded both so a tokenizer change cannot quietly rescore everything.
      expect(c.q_lower).toBe(c.query.toLowerCase());
      expect(tokenizeQuery(c.q_lower)).toEqual(c.terms);
      expect(lexicalScore(c.path, c.content, c.q_lower, c.terms)).toBe(c.out);
    });
  }

  test("a BOM before a heading costs it the heading weight", () => {
    // Not a curiosity: JS's own `trimStart` strips U+FEFF and Rust's does not,
    // so the naive port scores this 84 where the Rust scored 34.
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
    // Same inputs in doubles give a different answer, which is the reason
    // every step of the loop is rounded.
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
      expect(indexPath(c.cache_dir, c.character)).toBe(c.out);
    });
  }
});

describe("embedDocuments batching", () => {
  for (const c of fixture.embed_batching) {
    test(c.name, async () => {
      // Rebuilt from the recorded character counts rather than shipping
      // hundreds of kilobytes of filler in the fixture. `🌊` is there because
      // one case turns on chars-not-UTF-16-units, and the reconstruction has
      // to preserve that distinction to mean anything.
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
    // Counting `.length` instead would see twice the characters and split
    // every batch in half.
    expect(docs[0]!.length).toBe(c.doc_char_counts[0] * 2);
  });
});

// ── embedder wire shapes ────────────────────────────────────────────────

describe("buildEmbedBody", () => {
  for (const c of fixture.build_embed_body) {
    test(c.name, () => {
      expect(buildEmbedBody(c.model, c.inputs, c.dimensions ?? undefined)).toEqual(c.out);
      // Key order is part of the body the Rust sent.
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
          // The Rust's Display prefixes the variant; the message is the part
          // this code chose.
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
    // Not fixture-generated: the Rust used `floor_char_boundary` over a byte
    // length, and slicing by JS string index would cut by UTF-16 unit.
    expect(bodyPreview("abc", 10)).toBe("abc");
    expect(bodyPreview("abcdef", 3)).toBe("abc");
    expect(bodyPreview("🌊🌊", 4)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 5)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 7)).toBe("🌊");
    expect(bodyPreview("🌊🌊", 8)).toBe("🌊🌊");
    expect(bodyPreview("é", 1)).toBe("");
  });
});

// ── embedder resolution ─────────────────────────────────────────────────

describe("embeddingProviderBaseUrl", () => {
  for (const c of fixture.retrieval.hardcoded_base_url) {
    test(c.provider_key || "(empty)", () => {
      expect(embeddingProviderBaseUrl(c.provider_key)).toBe(c.base_url ?? undefined);
    });
  }

  test("it is not the same table chat uses", async () => {
    // Merging the two would be a silent bug: they genuinely disagree, and the
    // Rust kept them apart on purpose.
    const { defaultBaseUrl } = await import("../src/llm/request");
    const disagreements = fixture.retrieval.hardcoded_base_url.filter(
      (c: any) => (c.base_url ?? undefined) !== defaultBaseUrl(c.provider_key),
    );
    expect(disagreements.map((c: any) => c.provider_key).sort()).toEqual([
      "anthropic",
      "deepseek",
      "nanogpt",
      // `openai` is the one benign disagreement: an absent answer here means
      // `OpenAIEmbedder`'s own default, which is the same endpoint.
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
        expect(call).toThrow(c.outcome.error);
        return;
      }
      const embedder = call();
      expect(embedder.modelId).toBe(c.outcome.model_id);
      expect(embedder.dimensions).toBe(c.outcome.dimensions ?? undefined);
      // The same inputs must reuse the cached embedder rather than rebuild it.
      expect(call()).toBe(embedder);

      // The cache key never leaves the Rust function, so it is read back
      // apart: `provider::model::baseUrl::dimensions`, split from the right
      // because a model id may itself contain colons.
      const parts = c.outcome.cache_key.split("::");
      const keyDimensions = parts.at(-1)!;
      const keyBaseUrl = parts.at(-2)!;
      expect(parts[0]).toBe(splitOnce(c.default_ref ?? Object.keys(embedding)[0]!, ":")[0]);
      expect(parts.slice(1, -2).join("::")).toBe(c.outcome.model_id);
      expect(keyDimensions).toBe(
        c.outcome.dimensions === null ? "native" : String(c.outcome.dimensions),
      );

      // And the endpoint half of the key is checked against the thing it
      // actually decides: where the request goes.
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

// ── index file round trip ───────────────────────────────────────────────

describe("index persistence", () => {
  test("every persisted index in the fixture round-trips through load and save", async () => {
    // The file format is the contract with the Rust half for as long as it is
    // still reading it: field order, omitted optionals, and byte-ordered keys.
    let checked = 0;
    for (const c of fixture.cases) {
      for (const run of c.runs) {
        if (run.index_after === null || run.index_after === undefined) continue;
        const path = join(root, `idx-${checked}.json`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(run.index_after, null, 2));
        const loaded = await loadIndex(path);
        expect(normalizeIndexJson(JSON.parse(serializeIndex(loaded)))).toEqual(
          normalizeIndexJson(run.index_after),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("a malformed index loads as empty rather than throwing", async () => {
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
      const path = join(root, "bad.json");
      await writeFile(path, raw);
      const loaded = await loadIndex(path);
      expect(loaded.entries.size).toBe(0);
    }
  });

  test("a missing index file loads as empty", async () => {
    const loaded = await loadIndex(join(root, "nope", "missing.json"));
    expect(loaded.entries.size).toBe(0);
  });

  test("entries serialize in UTF-8 byte order", () => {
    // The Rust wrote a BTreeMap<String, _>, which orders by UTF-8 bytes; a JS
    // object would enumerate in insertion order and a plain sort would use
    // UTF-16 code units, which disagree above the BMP.
    const index: WorkspaceIndex = { entries: new Map() };
    for (const path of ["\u{1f30a}.md", ".md", "b.md", "a.md"]) {
      index.entries.set(path, {
        hash: "h",
        size: 1,
        modified_at_secs: 1,
        model_id: "m",
        embedded: false,
        embedding: [],
      });
    }
    expect(Object.keys(JSON.parse(serializeIndex(index)).entries)).toEqual([
      "a.md",
      "b.md",
      ".md",
      "\u{1f30a}.md",
    ]);
  });

  test("an entry serializes to exactly the bytes the Rust wrote", () => {
    // Compared as text, which the fixture cases cannot do: they carry f32
    // embeddings, and the two runtimes print the same f32 with different
    // digits. Everything else about the format — two-space indent, field
    // order, and the three optionals omitted rather than written as null — is
    // the contract with the Rust half for as long as it still reads this file.
    const index: WorkspaceIndex = { entries: new Map() };
    index.entries.set("a.md", {
      hash: "mtime:1000:8",
      size: 8,
      modified_at_secs: 1000,
      model_id: "topic-v1",
      embedded: false,
      embedding: [],
    });
    index.entries.set("b.md", {
      hash: "mtime:1001:2",
      size: 2,
      modified_at_secs: 1001,
      model_id: "topic-v1",
      max_embed_chars_per_file: 4000,
      embedded: false,
      reason: "non-utf8",
      embedding: [],
    });
    expect(serializeIndex(index)).toBe(
      [
        "{",
        '  "entries": {',
        '    "a.md": {',
        '      "hash": "mtime:1000:8",',
        '      "size": 8,',
        '      "modified_at_secs": 1000,',
        '      "model_id": "topic-v1",',
        '      "embedded": false',
        "    },",
        '    "b.md": {',
        '      "hash": "mtime:1001:2",',
        '      "size": 2,',
        '      "modified_at_secs": 1001,',
        '      "model_id": "topic-v1",',
        '      "max_embed_chars_per_file": 4000,',
        '      "embedded": false,',
        '      "reason": "non-utf8"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });
});

// ── walk determinism ────────────────────────────────────────────────────

describe("enumerateFiles", () => {
  test("a capped walk keeps the same files every time", async () => {
    // The deliberate divergence from the Rust: it walked in whatever order the
    // filesystem gave, so a capped workspace indexed a different slice of
    // itself depending on the filesystem and, across a rebuild, on nothing in
    // particular.
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
    // A negative number is silently taken as "now" by `utimes`; a Date is not.
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
