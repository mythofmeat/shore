import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { handleSearchHistory } from "../src/tools/history";
import { testTmp } from "./support/tmp.ts";
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
    score?: number;
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
  end_to_end: {
    name: string;
    input: Record<string, unknown>;
    expect: {
      error?: string;
      msg_ids?: string[];
      model_filter?: string | null;
      searched_messages?: number;
    };
  }[];
  empty_character_dir: { ok: Json } | { error: string };
  unconfigured_character_dir: { ok: Json } | { error: string };
}

const fixture = (await Bun.file(
  new URL("./engine_captures/history.json", import.meta.url),
).json()) as Fixture;

describe("the fixture is real", () => {
  test("the scoring table records both matches and non-matches", () => {
    expect(fixture.scoring.some((c) => c.score !== undefined)).toBe(true);
    expect(fixture.scoring.some((c) => c.score === undefined)).toBe(true);
    const distinct = new Set(fixture.scoring.map((c) => c.score).filter((s) => s !== undefined));
    expect(distinct.size).toBeGreaterThan(2);
  });
});

describe("searching a conversation's history", () => {
  interface Stored {
    msg_id: string;
    role: string;
    timestamp?: string;
    model?: string;
    content_blocks?: { type: string; text?: string }[];
    alternatives?: { content?: string; content_blocks?: { type: string; text?: string }[] }[];
  }

  const corpus = fixture.corpus;

  function storedMessages(): Map<string, Stored> {
    const out = new Map<string, Stored>();
    const lines = [
      ...corpus.segments.flatMap((s) => s.body.split("\n")),
      ...corpus["active.jsonl"].split("\n"),
    ];
    for (const line of lines) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as Stored;
      out.set(message.msg_id, message);
    }
    return out;
  }

  function visibleText(message: Stored): string {
    return (message.content_blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }

  async function characterDir(): Promise<string> {
    const dir = await mkdtemp(testTmp("shore-history-"));
    await mkdir(join(dir, "segments"), { recursive: true });
    for (const segment of corpus.segments) {
      await writeFile(join(dir, "segments", segment.file), segment.body);
    }
    await writeFile(join(dir, "compaction.json"), corpus["compaction.json"]);
    await writeFile(join(dir, "active.jsonl"), corpus["active.jsonl"]);
    return dir;
  }

  for (const c of fixture.end_to_end) {
    test(c.name, async () => {
      const dir = await characterDir();
      let got: Awaited<ReturnType<typeof handleSearchHistory>> | undefined;
      let thrown: unknown;
      try {
        got = await handleSearchHistory(c.input, dir, {
          defaultMode: "lexical",
          timeZone: "UTC",
          now: () => Date.parse("2026-01-05T00:00:00Z"),
        });
      } catch (e) {
        thrown = e;
      }

      if (c.expect.error !== undefined) {
        expect((thrown as Error | undefined)?.message, c.name).toBe(c.expect.error);
        return;
      }
      expect(thrown, c.name).toBeUndefined();
      const result = required(got);

      expect(result.query ?? null, `${c.name}: it echoes the query it searched for`).toBe(
        (c.input.query as string | undefined) ?? null,
      );
      expect(result.model_filter ?? null, `${c.name}: and the model it was filtered to`).toBe(
        c.expect.model_filter ?? null,
      );
      expect(
        result.results.map((r) => r.msg_id),
        `${c.name}: the messages it found, best first`,
      ).toEqual(required(c.expect.msg_ids));
      expect(result.count, `${c.name}: the count is how many came back`).toBe(
        result.results.length,
      );
      expect(
        result.searched_messages,
        `${c.name}: and it says how much history it read`,
      ).toBe(required(c.expect.searched_messages));

      const stored = storedMessages();
      for (const hit of result.results) {
        const message = stored.get(String(hit.msg_id));
        if (message === undefined) continue;
        expect(hit.role, `${String(hit.msg_id)}: comes back as the role it was written in`).toBe(
          message.role,
        );
        const storedTs = message.timestamp;
        if (storedTs === undefined) {
          expect(hit.timestamp ?? null, `${String(hit.msg_id)}: carries no time`).toBe(null);
        } else if (Number.isNaN(Date.parse(storedTs))) {
          expect(
            hit.timestamp,
            `${String(hit.msg_id)}: an unparseable stamp is passed through untouched`,
          ).toBe(storedTs);
        } else {
          expect(
            Date.parse(String(hit.timestamp)),
            `${String(hit.msg_id)}: and the instant it was written`,
          ).toBe(Date.parse(storedTs));
          expect(
            String(hit.timestamp),
            `${String(hit.msg_id)}: rendered with an explicit offset`,
          ).toMatch(/[+-]\d{2}:\d{2}$/u);
        }
        expect(hit.model ?? null, `${String(hit.msg_id)}: and which model wrote it`).toBe(
          message.model ?? null,
        );

        const core = String(hit.text).replace(/^…\s*/u, "").replace(/\s*…$/u, "");
        expect(
          visibleText(message).includes(core),
          `${String(hit.msg_id)}: its excerpt is taken from what the message actually says`,
        ).toBe(true);
      }
    });
  }
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

  test("the earliest match is where the match starts, with nothing matching before it", () => {
    for (const c of fixture.scoring) {
      const m = new QueryMatcher(c.query);
      const lower = c.content.toLowerCase();
      const got = m.earliestIndex(lower);
      const where = JSON.stringify([c.query, c.content]);

      if (c.score === undefined) {
        expect(got, `${where}: nothing matched, so there is no earliest match`).toBeUndefined();
        continue;
      }
      expect(got, `${where}: something matched, so it starts somewhere`).toBeDefined();
      if (got !== 0) {
        expect(
          m.earliestIndex(lower.slice(0, got)),
          `${where}: and nothing matches before that`,
        ).toBeUndefined();
      }
      expect(
        m.earliestIndex(lower.slice(got)),
        `${where}: while the match itself begins right there`,
      ).toBe(0);
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
