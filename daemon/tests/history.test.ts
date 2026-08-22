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
  new URL("./engine_captures/history.json", import.meta.url),
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

describe("excerpting a message for a search result", () => {
  const chars = (t: string) => Array.from(t).length;
  const excerpt = (content: string, query: string | null, budget: number) =>
    excerptFor(content, query === null ? undefined : new QueryMatcher(query), budget);

  test("content that already fits comes back whole, with no ellipsis", () => {
    expect(excerpt("short content", null, 80)).toBe("short content");
  });

  test("with no query it takes the opening, and says it was cut", () => {
    const got = excerpt("x".repeat(500), null, 80);
    expect(chars(got)).toBe(83);
    expect(got.endsWith("...")).toBe(true);
    expect(got.startsWith("...")).toBe(false);
  });

  test("with a query it centres on the first match, keeping a little before it", () => {
    const got = excerpt(`${"a".repeat(500)}tea${"b".repeat(500)}`, "tea", 200);
    expect(got).toContain("tea");
    expect(got.startsWith("...")).toBe(true);
    expect(got.endsWith("...")).toBe(true);
  });

  test("a match near the start is not padded with ellipsis it does not need", () => {
    const got = excerpt(`tea${"b".repeat(500)}`, "tea", 200);
    expect(got.startsWith("...")).toBe(false);
    expect(got).toContain("tea");
  });

  test("a query that is not there falls back to the opening", () => {
    const got = excerpt("the tea is hot", "coffee", 80);
    expect(got).toBe("the tea is hot");
  });

  test("what comes back stays within the budget, plus its ellipses", () => {
    for (const budget of [1, 10, 80, 360, 2000]) {
      for (const query of [null, "tea"]) {
        const content = `${"a".repeat(2000)}tea${"b".repeat(2000)}`;
        expect(chars(excerpt(content, query, budget)), `${budget}/${query}`).toBeLessThanOrEqual(
          budget + 6,
        );
      }
    }
  });

  test("counting is by character, so multibyte content is not cut short", () => {
    for (const filler of ["\u4E16", "\u{1F600}", "e\u0301"]) {
      for (const query of [null, "tea"]) {
        const content = `${filler.repeat(400)}tea${filler.repeat(400)}`;
        const got = excerpt(content, query, 360);
        expect(got, `${filler}/${query}`).not.toContain("\uFFFD");
        expect(chars(got), `${filler}/${query}`).toBeLessThanOrEqual(366);
      }
    }
  });

  test("an empty budget still returns something rather than throwing", () => {
    expect(() => excerpt("the tea is hot", "tea", 0)).not.toThrow();
    expect(() => excerpt("", null, 80)).not.toThrow();
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
