import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePath } from "../src/tools/workspace_path.ts";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-workspace-path-"));
  const ws = join(root, "workspace");
  mkdirSync(ws);
  writeFileSync(join(ws, "SOUL.md"), "soul");
  return ws;
}

describe("resolving a tool's path inside the workspace", () => {
  test("an existing file resolves to its workspace path, through the workspace/ and ./ prefixes", () => {
    const ws = workspace();
    expect(resolvePath(ws, "./workspace/SOUL.md")).toBe(join(ws, "SOUL.md"));
  });

  test("a memory path stays in the memory folder: a link from there to elsewhere in the workspace is refused", () => {
    const ws = workspace();
    mkdirSync(join(ws, "memory"));
    symlinkSync(join(ws, "SOUL.md"), join(ws, "memory", "soul.md"));
    expect(() => resolvePath(ws, "memory/soul.md")).toThrow("resolved path escapes workspace");
    expect(resolvePath(ws, "memory/new/notes.md")).toBe(join(ws, "memory", "new", "notes.md"));
  });

  test("a path in a memory folder that doesn't exist yet resolves as written", () => {
    const ws = workspace();
    expect(resolvePath(ws, "memory/new.md")).toBe(join(ws, "memory", "new.md"));
  });

  test("a new file deep under a link that leaves the workspace is refused", () => {
    const ws = workspace();
    const outside = mkdtempSync(join(tmpdir(), "shore-workspace-outside-"));
    symlinkSync(outside, join(ws, "out"));
    expect(() => resolvePath(ws, "out/new/deeper.md")).toThrow("resolved path escapes workspace");
    expect(() => resolvePath(ws, "out")).toThrow("resolved path escapes workspace");
  });
});
