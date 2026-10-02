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

  test("the adapter owns the client", () => {
    const adapter = readFileSync(join(SRC, "llm", "providers", "anthropic.ts"), "utf8");

    expect(adapter).toContain("anthropicClientFor");
  });
});


test("workflows cannot select provider-specific tool loops", () => {
  const workflows = ["handler/generation.ts", "tools/subagent_loop.ts", "autonomy/in_process.ts", "autonomy/heartbeat_loop.ts", "memory/compaction/manager.ts", "memory/compaction/llm.ts"];
  for (const workflow of workflows) {
    const source = readFileSync(join(SRC, workflow), "utf8");
    expect(source).not.toMatch(/(?:claudeAgent|anthropic|generic)ToolLoopEvents/);
    expect(source).not.toMatch(/sdk\s*[!=]==?\s*["']claude_agent["']/);
    expect(source).not.toMatch(/providers\/(?:claude_agent|anthropic|generic_loop)/);
  }
});
