import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  excerptFor,
  filtersFrom,
  handleLegacySearchHistory,
  matchesTimeRange,
  excerptCharsFrom,
  maxResultsFrom,
  modelMatches,
  normalizeModel,
  QueryMatcher,
  rangeIsEmpty,
} from "../src/tools/history";
import { testTmp } from "./support/tmp.ts";

type Json = Record<string, unknown>;

interface Fixture {
  constants: Record<string, number>;
  tool_def: { name: string; parameters: Json };
  normalize_model: { input: string; expect: string }[];
  model_matches: { model: string | null; filter: string | null; expect: boolean }[];
  tokenization: { query: string; raw_lower: string; terms: string[] }[];
  scoring: {
    query: string;
    content: string;
    score: number | null;
    earliest_index: number | null;
  }[];
  excerpts: {
    name: string;
    content: string;
    query: string | null;
    excerpt_chars: number;
    expect: string;
  }[];
  clamping: { input: Json; max_results: number; excerpt_chars: number }[];
  arg_parsing: {
    input: Json;
    expect:
      | {
          ok: {
            query: string | null;
            start: string | null;
            end: string | null;
            range_is_empty: boolean;
            model_filter: string | null;
          };
        }
      | { error: string };
  }[];
  time_range: {
    start: string | null;
    end: string | null;
    timestamp: string;
    expect: boolean;
    skipped: number;
  }[];
  corpus: {
    segments: { file: string; body: string }[];
    "compaction.json": string;
    "active.jsonl": string;
  };
  end_to_end: { name: string; input: Json; expect: { ok: Json } | { error: string } }[];
  empty_character_dir: { ok: Json } | { error: string };
  unconfigured_character_dir: { ok: Json } | { error: string };
}

const fixture = (await Bun.file(
  new URL("./engine_fixtures/history.json", import.meta.url),
).json()) as Fixture;

async function corpusDir(): Promise<string> {
  const dir = await mkdtemp(testTmp("history-parity-"));
  await mkdir(join(dir, "segments"), { recursive: true });
  for (const seg of fixture.corpus.segments) {
    await writeFile(join(dir, "segments", seg.file), seg.body);
  }
  await writeFile(join(dir, "compaction.json"), fixture.corpus["compaction.json"]);
  await writeFile(join(dir, "active.jsonl"), fixture.corpus["active.jsonl"]);
  return dir;
}

async function run(input: Json, dir: string): Promise<{ ok: Json } | { error: string }> {
  try {
    return { ok: (await handleLegacySearchHistory(input, dir)) as unknown as Json };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

describe("the fixture is real", () => {
  test("the corpus spans segments and the active window", () => {
    expect(fixture.corpus.segments.length).toBeGreaterThan(1);
    expect(fixture.corpus["active.jsonl"].length).toBeGreaterThan(0);
  });

  test("the corpus contains content no search may reach", () => {
    const all = fixture.corpus.segments.map((s) => s.body).join("");
    expect(all).toContain('"type":"thinking"');
    expect(all).toContain('"type":"tool_result"');
  });

  test("the corpus contains non-ASCII content", () => {
    const all = fixture.corpus.segments.map((s) => s.body).join("");
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(all)).toBe(true);
    expect(/[一-鿿]/u.test(all)).toBe(true);
  });

  test("the corpus contains an unparseable timestamp", () => {
    expect(fixture.corpus["active.jsonl"]).toContain("not-a-timestamp");
  });

  test("both end-to-end outcomes are represented", () => {
    const ok = fixture.end_to_end.filter((c) => "ok" in c.expect);
    const err = fixture.end_to_end.filter((c) => "error" in c.expect);
    expect(ok.length).toBeGreaterThan(0);
    expect(err.length).toBeGreaterThan(0);
  });

  test("some end-to-end cases return results and some return none", () => {
    const withHits = fixture.end_to_end.filter(
      (c) => "ok" in c.expect && (c.expect.ok.count as number) > 0,
    );
    const without = fixture.end_to_end.filter(
      (c) => "ok" in c.expect && (c.expect.ok.count as number) === 0,
    );
    expect(withHits.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  test("at least one case has more candidates than it returns", () => {
    const truncated = fixture.end_to_end.filter(
      (c) =>
        "ok" in c.expect &&
        typeof c.input.max_results === "number" &&
        (c.expect.ok.count as number) === Math.max(1, c.input.max_results as number),
    );
    expect(truncated.length).toBeGreaterThan(0);
  });

  test("the scoring table records both matches and non-matches", () => {
    expect(fixture.scoring.some((c) => c.score !== null)).toBe(true);
    expect(fixture.scoring.some((c) => c.score === null)).toBe(true);
    const distinct = new Set(fixture.scoring.map((c) => c.score).filter((s) => s !== null));
    expect(distinct.size).toBeGreaterThan(2);
  });
});

describe("normalizeModel", () => {
  for (const c of fixture.normalize_model) {
    test(`${c.input || "(empty)"} → ${c.expect}`, () => {
      expect(normalizeModel(c.input)).toBe(c.expect);
    });
  }
});

describe("modelMatches", () => {
  for (const c of fixture.model_matches) {
    test(`${c.model ?? "(none)"} vs ${c.filter ?? "(none)"}`, () => {
      const filter = c.filter === null ? undefined : normalizeModel(c.filter);
      expect(modelMatches(c.model ?? undefined, filter)).toBe(c.expect);
    });
  }
});

describe("query tokenization", () => {
  for (const c of fixture.tokenization) {
    test(`${JSON.stringify(c.query)} → ${JSON.stringify(c.terms)}`, () => {
      const m = new QueryMatcher(c.query);
      expect(m.rawLower).toBe(c.raw_lower);
      expect(m.terms).toEqual(c.terms);
    });
  }

  test("term length is measured in bytes, not characters", () => {
    const cjk = fixture.tokenization.find((c) => c.query === "茶");
    expect(cjk?.terms).toEqual(["茶"]);
    const ascii = fixture.tokenization.find((c) => c.query === "a");
    expect(ascii?.terms).toEqual([]);
  });

  test("term characters are Unicode alphanumerics, not ASCII", () => {
    expect(fixture.tokenization.find((c) => c.query === "🙂")?.terms).toEqual([]);
    expect(fixture.tokenization.find((c) => c.query === "tea 茶")?.terms).toEqual(["tea", "茶"]);
  });
});

describe("scoring", () => {
  for (const [i, c] of fixture.scoring.entries()) {
    test(`#${i} ${JSON.stringify(c.query)} vs ${JSON.stringify(c.content)}`, () => {
      const m = new QueryMatcher(c.query);
      expect(m.score(c.content)).toBe(c.score ?? undefined);
    });
  }

  test("earliest match index resolves to the same character offset", () => {
    for (const c of fixture.scoring) {
      const m = new QueryMatcher(c.query);
      const lower = c.content.toLowerCase();
      const got = m.earliestIndex(lower);
      if (c.earliest_index === null) {
        expect(got, JSON.stringify([c.query, c.content])).toBeUndefined();
        continue;
      }
      const rustChars = [...Buffer.from(lower, "utf8").subarray(0, c.earliest_index).toString("utf8")]
        .length;
      const tsChars = [...lower.slice(0, got)].length;
      expect(tsChars, JSON.stringify([c.query, c.content])).toBe(rustChars);
    }
  });
});

describe("excerptFor", () => {
  for (const c of fixture.excerpts) {
    test(c.name, () => {
      const matcher = c.query === null ? undefined : new QueryMatcher(c.query);
      expect(excerptFor(c.content, matcher, c.excerpt_chars)).toBe(c.expect);
    });
  }

  test("the window is measured in characters, not code units", () => {
    const content = "🙂".repeat(500);
    expect([...excerptFor(content, undefined, 80)].length).toBe(80 + "...".length);
  });

  test("no excerpt ever splits a character", () => {
    for (const c of fixture.excerpts) {
      const matcher = c.query === null ? undefined : new QueryMatcher(c.query);
      expect(excerptFor(c.content, matcher, c.excerpt_chars), c.name).not.toContain("�");
    }
  });
});

describe("numeric clamping", () => {
  test("uses deliberately small search defaults", () => {
    expect(maxResultsFrom({})).toBe(3);
    expect(excerptCharsFrom({})).toBe(240);
  });

  test("clamps explicit result and excerpt sizes", () => {
    expect(maxResultsFrom({ max_results: 0 })).toBe(1);
    expect(maxResultsFrom({ max_results: 1000 })).toBe(50);
    expect(excerptCharsFrom({ excerpt_chars: 0 })).toBe(80);
    expect(excerptCharsFrom({ excerpt_chars: 999999 })).toBe(2000);
  });

  test("invalid numeric arguments fall back instead of widening the search", () => {
    expect(maxResultsFrom({ max_results: "50" })).toBe(3);
    expect(excerptCharsFrom({ excerpt_chars: 5.5 })).toBe(240);
  });
});

describe("argument parsing", () => {
  for (const [i, c] of fixture.arg_parsing.entries()) {
    test(`#${i} ${JSON.stringify(c.input)}`, () => {
      let got: { ok: unknown } | { error: string };
      try {
        const { query, range } = filtersFrom(c.input);
        const rawModel = c.input.model;
        let modelFilter: string | null = null;
        if (typeof rawModel === "string") {
          const trimmed = rawModel.trim();
          modelFilter = trimmed === "" ? null : normalizeModel(trimmed);
        } else if (rawModel !== undefined) {
          throw new Error("invalid args: model must be a string");
        }
        got = {
          ok: {
            query: query ?? null,
            start: range.start?.rfc3339 ?? null,
            end: range.end?.rfc3339 ?? null,
            range_is_empty: rangeIsEmpty(range),
            model_filter: modelFilter,
          },
        };
      } catch (e) {
        got = { error: (e as Error).message };
      }
      expect(got).toEqual(c.expect as never);
    });
  }
});

describe("time range membership", () => {
  for (const [i, c] of fixture.time_range.entries()) {
    test(`#${i} ${c.start ?? "-"}..${c.end ?? "-"} contains ${c.timestamp || "(empty)"}`, () => {
      const input: Json = {};
      if (c.start !== null) input.start_time = c.start;
      if (c.end !== null) input.end_time = c.end;
      const { range } = filtersFrom(input);

      const stats = { skipped: 0 };
      expect(matchesTimeRange(c.timestamp, range, stats)).toBe(c.expect);
      expect(stats.skipped).toBe(c.skipped);
    });
  }

  test("bounds are inclusive at both ends", () => {
    const boundary = fixture.time_range.filter(
      (c) => c.timestamp === c.start || c.timestamp === c.end,
    );
    expect(boundary.length).toBeGreaterThan(0);
    expect(boundary.every((c) => c.expect)).toBe(true);
  });
});

describe("end to end", () => {
  function successful(result: { ok: Json } | { error: string }): Json {
    if ("error" in result) throw new Error(result.error);
    return result.ok;
  }

  test("returns a small, clean, deduplicated result set", async () => {
    const result = successful(await run({ query: "tea" }, await corpusDir()));
    const results = result.results as Json[];
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.every((entry) => typeof entry.text === "string")).toBe(true);
    expect(results.every((entry) => !("excerpt" in entry) && !("source" in entry))).toBe(true);
    expect(results.every((entry) => !(entry.text as string).includes("\n"))).toBe(true);
    expect(new Set(results.map((entry) => entry.text)).size).toBe(results.length);
  });

  test("a multi-term query keeps only the best available term coverage", async () => {
    const result = successful(await run({ query: "tea kettle" }, await corpusDir()));
    const results = result.results as Json[];
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((entry) => {
        const text = String(entry.text).toLowerCase();
        return text.includes("tea") && text.includes("kettle");
      }),
    ).toBe(true);
  });

  test("unselected alternatives are unreachable, with or without the retired flag", async () => {
    const dir = await corpusDir();
    expect(successful(await run({ query: "third take" }, dir)).count).toBe(0);
    expect(
      successful(await run({ query: "third take", include_alternatives: true }, dir)).count,
    ).toBe(0);
  });

  test("the active window is unreachable", async () => {
    const dir = await corpusDir();
    const result = successful(await run({ query: "tea" }, dir));
    const ids = (result.results as Json[]).map((entry) => entry.msg_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("a-recent");
    expect(result.searched_messages).toBe(6);
  });

  test("time-only results remain chronological", async () => {
    const result = successful(
      await run(
        { start_time: "2026-01-01T00:00:00Z", end_time: "2026-01-04T23:59:59Z" },
        await corpusDir(),
      ),
    );
    const timestamps = (result.results as Json[]).map((entry) => Date.parse(String(entry.timestamp)));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  for (const c of fixture.end_to_end.filter((entry) => "error" in entry.expect)) {
    test(c.name, async () => {
      expect(await run(c.input, await corpusDir())).toEqual(c.expect as never);
    });
  }

  test("an empty character directory searches nothing and does not fail", async () => {
    const dir = await mkdtemp(testTmp("history-parity-empty-"));
    expect(await run({ query: "tea" }, dir)).toEqual(fixture.empty_character_dir as never);
  });

  test("an unconfigured character directory is rejected", async () => {
    expect(await run({ query: "tea" }, "")).toEqual(
      fixture.unconfigured_character_dir as never,
    );
  });

  test("result order is deterministic across runs", async () => {
    const dir = await corpusDir();
    const first = await run({ query: "tea" }, dir);
    for (let i = 0; i < 5; i += 1) {
      expect(await run({ query: "tea" }, dir)).toEqual(first as never);
    }
  });
});
