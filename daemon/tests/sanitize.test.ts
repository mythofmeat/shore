import { describe, expect, test } from "bun:test";

import { sanitizeToolPairs } from "../src/llm/sanitize";
import type { WireMessage } from "../src/llm/types";

interface Case {
  name: string;
  messages: WireMessage[];
  expect: WireMessage[] | null;
}

interface Fixture {
  sanitize_tool_pairs: Case[];
}

const fixture = (await Bun.file(
  new URL("./llm_fixtures/sanitize.json", import.meta.url),
).json()) as Fixture;

describe("the fixture is real", () => {
  test("both answers are represented", () => {
    const clean = fixture.sanitize_tool_pairs.filter((c) => c.expect === null);
    const dirty = fixture.sanitize_tool_pairs.filter((c) => c.expect !== null);
    expect(clean.length).toBeGreaterThan(0);
    expect(dirty.length).toBeGreaterThan(0);
  });

  test("a case exists where stripping empties a message entirely", () => {
    const dropped = fixture.sanitize_tool_pairs.filter(
      (c) => c.expect !== null && c.expect.length < c.messages.length,
    );
    expect(dropped.length).toBeGreaterThan(0);
  });

  test("a case exists where a message survives with fewer blocks", () => {
    const trimmed = fixture.sanitize_tool_pairs.filter((c) => {
      if (c.expect === null) return false;
      const before = c.messages.reduce((n, m) => n + m.content.length, 0);
      const after = c.expect.reduce((n, m) => n + m.content.length, 0);
      return c.expect.length === c.messages.length && after < before;
    });
    expect(trimmed.length).toBeGreaterThan(0);
  });
});

describe("sanitizeToolPairs matches the Rust", () => {
  for (const c of fixture.sanitize_tool_pairs) {
    test(c.name, () => {
      const got = sanitizeToolPairs(c.messages);
      if (c.expect === null) {
        expect(got).toBeUndefined();
        return;
      }
      expect(got).toEqual(c.expect);
    });
  }

  test("the input is never mutated", () => {
    for (const c of fixture.sanitize_tool_pairs) {
      const before = JSON.stringify(c.messages);
      sanitizeToolPairs(c.messages);
      expect(JSON.stringify(c.messages), c.name).toBe(before);
    }
  });
});
