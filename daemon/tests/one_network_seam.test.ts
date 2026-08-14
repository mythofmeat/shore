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
