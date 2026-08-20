import { describe, expect, test } from "bun:test";

import {
  excerptFor,
  filtersFrom,
  matchesTimeRange,
  excerptCharsFrom,
  maxResultsFrom,
  modelMatches,
  normalizeModel,
  QueryMatcher,
  rangeIsEmpty,
} from "../src/tools/history";

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

describe("the fixture is real", () => {
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
      const rustChars = Array.from(
        Buffer.from(lower, "utf8").subarray(0, c.earliest_index).toString("utf8"),
      ).length;
      const tsChars = Array.from(lower.slice(0, got)).length;
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
    expect(Array.from(excerptFor(content, undefined, 80)).length).toBe(80 + "...".length);
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
