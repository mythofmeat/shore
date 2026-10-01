import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { catalogFromSections, emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { Embedder } from "../src/llm/embed.ts";
import { containsEveryTerm, defaultMinSimilarity, distinctiveTerms, startsAWord } from "../src/memory/closeness.ts";
import { HISTORY_SEARCH_DB_FILE, HistorySearchIndex } from "../src/memory/history_index.ts";
import { resolveMinSimilarity } from "../src/memory/retrieval.ts";
import { indexPendingBatch } from "../src/memory/workspace_index.ts";
import { handleSearchHistory, type HistoryCloseness, type HistoryHit } from "../src/tools/history.ts";
import { formatToolOutput } from "../src/tools/output.ts";
import { DEFAULT_RETRIEVAL_CONFIG, GIT_HISTORY_HINT, handleSearch } from "../src/tools/workspace.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

class AngleEmbedder implements Embedder {
  readonly dimensions = 2;

  constructor(
    readonly modelId: string,
    private readonly exact: Record<string, number>,
    private readonly needles: [string, number][] = [],
  ) {}

  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((input) => {
      const degrees = this.exact[input] ?? this.needles.find(([needle]) => input.includes(needle))?.[1] ?? 90;
      return [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
    });
  }
}

function message(id: string, text: string, minute: number): Message {
  return {
    msg_id: id,
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: `2026-08-13T00:${String(minute).padStart(2, "0")}:00Z`,
  };
}

async function indexedHistory(messages: Message[], embedder: Embedder) {
  const dir = join(testTmp(`closeness-${crypto.randomUUID()}`), "ada");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dirname(dir), HISTORY_DB_FILE);
  const store = HistoryStore.open(dbPath);
  store.putSegment(basename(dir), 0, {
    file: "0001.jsonl",
    message_count: messages.length,
    compacted_at: "2026-08-13T01:00:00Z",
  }, messages);
  store.close();
  const indexPath = join(dir, HISTORY_SEARCH_DB_FILE);
  const index = HistorySearchIndex.open({ conversationDir: dir, character: basename(dir), dbPath, path: indexPath });
  await index.reconcile();
  let embedded: number;
  do embedded = await index.embedPending(embedder); while (embedded > 0);
  index.close();
  return {
    search: (input: Record<string, unknown>, minSimilarity: number | null = 0.7) =>
      handleSearchHistory(input, dir, {
        character: basename(dir),
        dbPath,
        indexPath,
        embedder,
        ...(minSimilarity === null ? {} : { minSimilarity }),
        timeZone: "UTC",
      }),
  };
}

const UNRELATED = new AngleEmbedder("fake", { "punk girl idea": 0 }, [["orchard", 60], ["migration", 75]]);

describe("telling close words apart", () => {
  test("a term counts where it starts a word, not inside one", () => {
    expect(startsAWord("rough day today", "day")).toBe(true);
    expect(startsAWord("it was today", "day")).toBe(false);
    expect(startsAWord("dentists again", "dentist")).toBe(true);
    expect(startsAWord("ren's notes", "ren")).toBe(true);
    expect(startsAWord("the current plan", "ren")).toBe(false);
  });

  test("a character outside the BMP before the term is read whole", () => {
    expect(startsAWord("\u{1F642}tea", "tea")).toBe(true);
    expect(startsAWord("\u{1D400}tea", "tea")).toBe(false);
  });

  test("scripts written without spaces match anywhere", () => {
    expect(startsAWord("世界の話をしよう", "の話")).toBe(true);
    expect(startsAWord("ไปเที่ยวทะเล", "ทะเล")).toBe(true);
  });

  test("stopwords are not required, unless the query is nothing else", () => {
    expect(distinctiveTerms(["today", "was", "rough", "was"])).toEqual(["today", "rough"]);
    expect(distinctiveTerms(["what", "was", "it"])).toEqual(["what", "was", "it"]);
  });

  test("every word must be there for a word match", () => {
    expect(containsEveryTerm("we talked about tea last winter", ["tea", "winter"])).toBe(true);
    expect(containsEveryTerm("we talked about tea", ["tea", "winter"])).toBe(false);
    expect(containsEveryTerm("anything", [])).toBe(false);
  });
});

describe("the similarity minimum", () => {
  test("bge-small has a built-in minimum under any provider or organisation prefix", () => {
    expect(defaultMinSimilarity("BAAI/bge-small-en-v1.5")).toBe(0.7);
    expect(defaultMinSimilarity("bge-small-en-v1.5")).toBe(0.7);
    expect(defaultMinSimilarity("text-embedding-3-large")).toBeUndefined();
  });

  test("the configured embedding model decides it, and its settings can override it", () => {
    expect(resolveMinSimilarity({ defaultRef: "local:BAAI/bge-small-en-v1.5", embedding: {} })).toBe(0.7);
    expect(resolveMinSimilarity({
      defaultRef: "local:BAAI/bge-small-en-v1.5",
      embedding: { "local:BAAI/bge-small-en-v1.5": { minSimilarity: 0.62 } },
    })).toBe(0.62);
    expect(resolveMinSimilarity({ embedding: { "openai:text-embedding-3-large": { minSimilarity: 0.3 } } })).toBe(0.3);
    expect(resolveMinSimilarity({ defaultRef: "openai:text-embedding-3-large", embedding: {} })).toBeUndefined();
    expect(resolveMinSimilarity({ embedding: {} })).toBeUndefined();
  });

  test("min_similarity is read from an embedding model's settings", () => {
    const catalog = catalogFromSections(undefined, { "local:BAAI/bge-small-en-v1.5": { min_similarity: 0.65 } }, undefined);
    expect(catalog.embedding.get("local:BAAI/bge-small-en-v1.5")).toEqual({ minSimilarity: 0.65 });
    expect(catalogFromSections(undefined, { "local:m": { min_similarity: 0 } }, undefined).embedding.get("local:m"))
      .toEqual({ minSimilarity: 0 });
  });

  test("min_similarity outside 0 to 1, or not a number, is rejected", () => {
    expect(() => catalogFromSections(undefined, { "local:m": { min_similarity: 1.5 } }, undefined))
      .toThrow("min_similarity is 1.5; it must be from 0 to 1");
    expect(() => catalogFromSections(undefined, { "local:m": { min_similarity: -0.1 } }, undefined))
      .toThrow("min_similarity is -0.1; it must be from 0 to 1");
    expect(() => catalogFromSections(undefined, { "local:m": { min_similarity: "high" } }, undefined))
      .toThrow("expected a float");
  });

  test("a character's tool context carries the minimum for its embedding model", async () => {
    setTestEnv("LLM_API_KEY", "fixture-key");
    const root = await mkdtemp(testTmp("closeness-context-"));
    const config: LoadedConfig = {
      app: defaultAppConfig(),
      models: emptyCatalog(),
      providers: ProviderRegistry.empty(),
      rawTable: undefined,
      dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
    };
    expect((await buildToolContext(config, config.dirs.data, "ada")).minSimilarity).toBeUndefined();

    config.app.defaults.embedding = "local:BAAI/bge-small-en-v1.5";
    const ctx = await buildToolContext(config, config.dirs.data, "ada");
    expect(ctx.embedder?.modelId).toBe("BAAI/bge-small-en-v1.5");
    expect(ctx.minSimilarity).toBe(0.7);

    config.models.embedding.set("local:BAAI/bge-small-en-v1.5", { minSimilarity: 0.6 });
    expect((await buildToolContext(config, config.dirs.data, "ada")).minSimilarity).toBe(0.6);
  });
});

describe("chat search reports when nothing is close", () => {
  const corpus = [
    message("u1", "We walked through the apple orchard", 0),
    message("a1", "Database migration notes", 1),
  ];

  test("an unrelated query says nothing is close instead of returning the nearest messages", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    const result = await history.search({ query: "punk girl idea" });
    expect(result.mode).toBe("hybrid");
    expect(result.results).toEqual([]);
    const closeness = required(result.closeness);
    expect(closeness.best_similarity).toBeCloseTo(0.5, 2);
    expect({ ...closeness, best_similarity: null }).toEqual({
      min_similarity: 0.7,
      best_similarity: null,
      words: ["punk", "girl", "idea"],
      weaker_left_out: true,
    });
    expect(formatToolOutput("search_chat_logs", result)).toContain(
      "No close matches in archived messages: no message contains all of: punk, girl, idea, " +
        "and the best similarity is 0.50 (close needs 0.70). match: nearest returns the nearest weak matches.",
    );
  });

  test("nearest still returns the nearest messages, marked weak with their similarity", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    const result = await history.search({ query: "punk girl idea", match: "nearest" });
    expect(result.match).toBe("nearest");
    const hits = result.results as unknown as HistoryHit[];
    expect(hits.map((hit) => hit.msg_id)).toEqual(["u1", "a1"]);
    expect(hits.map((hit) => hit.weak)).toEqual([true, true]);
    expect(hits[0]?.similarity).toBeCloseTo(0.5, 2);
    expect(result.closeness?.weaker_left_out).toBe(false);
    const text = formatToolOutput("search_chat_logs", result);
    expect(text).toContain("Matching: nearest messages, including weak matches.");
    expect(text).toContain("— weak match, similarity 0.50;");
  });

  test("a semantically close message is kept and weaker ones are left out", async () => {
    const embedder = new AngleEmbedder("fake", { "fruit grove": 0 }, [["orchard", 20], ["migration", 75]]);
    const history = await indexedHistory(corpus, embedder);
    const result = await history.search({ query: "fruit grove" });
    const hits = result.results as unknown as HistoryHit[];
    expect(hits.map((hit) => hit.msg_id)).toEqual(["u1"]);
    expect(hits[0]?.weak).toBeUndefined();
    expect(hits[0]?.similarity).toBeCloseTo(0.94, 2);
    expect(result.closeness?.weaker_left_out).toBe(true);
    const text = formatToolOutput("search_chat_logs", result);
    expect(text).toContain("Close matches only; weaker matches were left out (match: nearest includes them).");
    expect(text).toContain("— match, similarity 0.94;");
  });

  test("a message holding every query word is close however low its similarity", async () => {
    const embedder = new AngleEmbedder("fake", { "drift tells": 0, "the drift tells came back": 80 });
    const history = await indexedHistory([message("u1", "the drift tells came back", 0)], embedder);
    const result = await history.search({ query: "drift tells" });
    const hits = result.results as unknown as HistoryHit[];
    expect(hits.map((hit) => hit.msg_id)).toEqual(["u1"]);
    expect(hits[0]?.similarity).toBeCloseTo(0.17, 1);
    expect(hits[0]?.weak).toBeUndefined();
  });

  test("a long query is told that shorter queries match better", async () => {
    const embedder = new AngleEmbedder("fake", { "punk girl idea silvershore character": 0 }, [["orchard", 60]]);
    const history = await indexedHistory(corpus, embedder);
    const text = formatToolOutput("search_chat_logs", await history.search({ query: "punk girl idea silvershore character" }));
    expect(text).toContain("Long queries match less well; two or three distinctive words work best.");
  });

  test("without a minimum for the embedding model, semantic matches are kept as before", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    const result = await history.search({ query: "punk girl idea" }, null);
    expect((result.results as unknown as HistoryHit[]).map((hit) => hit.msg_id)).toEqual(["u1", "a1"]);
    expect(result.closeness?.min_similarity).toBeNull();
    expect(result.closeness?.weaker_left_out).toBe(false);
  });

  test("lexical search leaves out messages with only some of the words", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    const result = await history.search({ query: "apple notes", mode: "lexical" });
    expect(result.results).toEqual([]);
    expect(result.closeness).toEqual({ min_similarity: 0.7, best_similarity: null, words: ["apple", "notes"], weaker_left_out: true });
    expect(formatToolOutput("search_chat_logs", result)).toContain(
      "No close matches in archived messages: no message contains all of: apple, notes. match: nearest",
    );
    const nearest = await history.search({ query: "apple notes", mode: "lexical", match: "nearest" });
    expect((nearest.results as unknown as HistoryHit[]).map((hit) => hit.msg_id).sort()).toEqual(["a1", "u1"]);
  });

  test("phrase matching and time ranges have nothing to judge", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    const phrase = await history.search({ query: "apple orchard", match: "phrase" });
    expect(phrase.closeness).toBeUndefined();
    expect((phrase.results as unknown as HistoryHit[]).map((hit) => hit.msg_id)).toEqual(["u1"]);
    const range = await history.search({ start_time: "2026-08-13T00:00:00Z" });
    expect(range.closeness).toBeUndefined();
    expect(range.results).toHaveLength(2);
  });

  test("an unknown match is rejected", async () => {
    const history = await indexedHistory(corpus, UNRELATED);
    expect(await outcomeOf(history.search({ query: "x", match: "fuzzy" }))).toThrow("match must be ranked, nearest, or phrase");
  });
});

describe("workspace search reports when nothing is close", () => {
  async function workspace(files: Record<string, string>, embedder: Embedder) {
    const root = await mkdtemp(testTmp("closeness-workspace-"));
    const ws = join(root, "workspace");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(ws, path)), { recursive: true });
      await writeFile(join(ws, path), text);
    }
    const indexPath = join(root, "cache", "workspace_index.db");
    const options = { workspaceDir: ws, retrievalConfig: DEFAULT_RETRIEVAL_CONFIG, embedder, indexPath };
    let pending: number;
    do pending = (await indexPendingBatch(options)).pending; while (pending > 0);
    return (input: Record<string, unknown>, minSimilarity: number | null = 0.7) =>
      handleSearch(input, ws, DEFAULT_RETRIEVAL_CONFIG, {
        embedder,
        indexPath,
        ...(minSimilarity === null ? {} : { minSimilarity }),
      }) as Promise<Record<string, unknown>>;
  }

  const files = { "notes/orchard.md": "We walked through the apple orchard\n", "notes/db.md": "Database migration notes\n" };

  test("an unrelated query says nothing is close and points at git history", async () => {
    const search = await workspace(files, UNRELATED);
    const result = await search({ query: "punk girl idea" });
    expect(result.results).toEqual([]);
    const closeness = result.closeness as HistoryCloseness;
    expect(closeness.best_similarity).toBeCloseTo(0.5, 2);
    expect({ ...closeness, best_similarity: null }).toEqual({
      min_similarity: 0.7,
      best_similarity: null,
      words: ["punk", "girl", "idea"],
      weaker_left_out: true,
    });
    expect(result.note).toBe(GIT_HISTORY_HINT);
    const text = formatToolOutput("search", result);
    expect(text).toContain(
      "No close matches: no file contains all of: punk, girl, idea, and the best similarity is 0.50 (close needs 0.70).",
    );
    expect(text).toContain(GIT_HISTORY_HINT);
  });

  test("nearest returns the nearest files, marked weak with their similarity", async () => {
    const search = await workspace(files, UNRELATED);
    const result = await search({ query: "punk girl idea", match: "nearest" });
    const hits = result.results as { path: string; weak?: boolean }[];
    expect(hits.map((hit) => hit.path)).toEqual(["notes/orchard.md", "notes/db.md"]);
    expect(hits.map((hit) => hit.weak)).toEqual([true, true]);
    expect(formatToolOutput("search", result)).toContain("notes/orchard.md (weak match, similarity 0.50)");
  });

  test("a close file is kept, weaker ones are left out, and its similarity is shown", async () => {
    const embedder = new AngleEmbedder("fake", { "fruit grove": 0 }, [["orchard", 20], ["migration", 75]]);
    const search = await workspace(files, embedder);
    const result = await search({ query: "fruit grove" });
    expect((result.results as { path: string }[]).map((hit) => hit.path)).toEqual(["notes/orchard.md"]);
    const text = formatToolOutput("search", result);
    expect(text).toContain("Close matches only; weaker matches were left out (match: nearest includes them).");
    expect(text).toContain("notes/orchard.md (similarity 0.94)");
  });

  test("a file holding every query word is close however low its similarity", async () => {
    const embedder = new AngleEmbedder("fake", { "drift tells": 0 }, [["drift", 80], ["migration", 75]]);
    const search = await workspace({ "voice.md": "Old drift tells: stacked adjectives.\n", "notes/db.md": "Database migration notes\n" }, embedder);
    const result = await search({ query: "drift tells" });
    expect((result.results as { path: string }[]).map((hit) => hit.path)).toEqual(["voice.md"]);
  });

  test("without a minimum for the embedding model, every embedded file is kept as before", async () => {
    const search = await workspace(files, UNRELATED);
    const result = await search({ query: "punk girl idea" }, null);
    expect((result.results as unknown[]).length).toBe(2);
    expect((result.closeness as { weaker_left_out: boolean }).weaker_left_out).toBe(false);
  });

  test("an unknown match is rejected", async () => {
    const search = await workspace(files, UNRELATED);
    expect(await outcomeOf(search({ query: "x", match: "fuzzy" }))).toThrow("search `match` must be ranked or nearest");
  });
});
