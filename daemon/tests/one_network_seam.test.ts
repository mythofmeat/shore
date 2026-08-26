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

  test("the adapter owns the client and the tool loop routes through the adapter", () => {
    const adapter = readFileSync(join(SRC, "llm", "providers", "anthropic.ts"), "utf8");
    const loop = readFileSync(join(SRC, "llm", "providers", "anthropic_loop.ts"), "utf8");

    expect(adapter).toContain("anthropicClientFor");
    expect(loop).toContain("new AnthropicProvider()");
    expect(loop).not.toContain("anthropicClientFor");
  });
});
