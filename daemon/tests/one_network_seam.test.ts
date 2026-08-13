/**
 * There is one place that constructs an Anthropic SDK client — issue #80.
 *
 * The tool loop used to build its own, and every tools-enabled Claude turn
 * bypassed call capture as a result: no `calls` row, no `http_calls` row, for
 * what is the normal case. That was fixed by wrapping the loop in
 * `capturedEvents` at both call sites, which left the second seam in place and
 * the fix a thing to remember. This makes it structural: a new caller that
 * builds its own client fails here.
 *
 * Wire capture patches global fetch, so it covers anything that goes out. Call
 * capture does not — it wraps a specific event stream — which is why the
 * construction site is what has to stay singular.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = join(import.meta.dir, "..", "src");
const FACTORY = join(SRC, "llm", "providers", "anthropic_client.ts");

function sourceFiles(): string[] {
  return [...new Glob("**/*.ts").scanSync(SRC)].map((rel) => join(SRC, rel));
}

describe("the Anthropic client has one construction site", () => {
  test("nothing outside the factory calls `new Anthropic(`", () => {
    const offenders = sourceFiles().filter((path) => {
      if (path === FACTORY) return false;
      return /\bnew Anthropic\s*\(/.test(readFileSync(path, "utf8"));
    });

    expect(offenders).toEqual([]);
  });

  test("the factory itself is the one that does", () => {
    expect(/\bnew Anthropic\s*\(/.test(readFileSync(FACTORY, "utf8"))).toBe(true);
  });

  test("both the plain adapter and the tool loop route through it", () => {
    for (const file of ["anthropic.ts", "anthropic_loop.ts"]) {
      const text = readFileSync(join(SRC, "llm", "providers", file), "utf8");
      expect(text).toContain("anthropicClientFor");
    }
  });
});
