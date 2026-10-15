
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { MAX_READ_IMAGE_BYTES } from "../src/tools/read_image.ts";
import { renderToolDefs } from "../src/tools/registry.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { toolResultText } from "../src/llm/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function world() {
  const root = await mkdtemp(join(tmpdir(), "shore-files-"));
  roots.push(root);
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir);
  const ctx: ToolContext = {
    workspaceDir, characterName: "Ada", characterDataDir: root, imageDir: join(root, "images"), cacheDir: join(root, "cache"),
    conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
  };
  const exec: ToolExecution = {
    ctx, sendDirect: () => {}, schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-09-21", newMessageId: () => crypto.randomUUID(),
  };
  const run = (name: string, input: unknown) => runToolUse({ id: crypto.randomUUID(), name, input }, exec, []);
  const put = async (path: string, content: string | Buffer) => { await writeFile(join(workspaceDir, path), content); return join(workspaceDir, path); };
  return { root, ctx, exec, run, put };
}

function resultText(run: Awaited<ReturnType<typeof runToolUse>>): string {
  if (run.block.type !== "tool_result") throw new Error("missing tool result");
  return toolResultText(run.block.content);
}

test("read rejects binaries, invalid UTF-8, corrupt and oversized images", async () => {
  const { put, run } = await world();
  await put("binary", Buffer.from([0, 1, 2]));
  await put("encoding", Buffer.from([255, 255]));
  await put("bad.png", "not a PNG");
  await truncate(await put("large.png", Buffer.from(PNG, "base64")), MAX_READ_IMAGE_BYTES + 1);
  for (const file_path of ["binary", "encoding", "bad.png", "large.png", "missing"]) {
    expect((await run("read", { file_path })).isError).toBe(true);
  }
});

test("read and edit follow absolute paths, parent paths and symlinks like bash", async () => {
  const { root, ctx, run } = await world();
  const outside = join(root, "outside");
  await writeFile(outside, "before");
  await symlink(outside, join(ctx.workspaceDir, "link"));
  expect(resultText(await run("read", { file_path: "../outside" }))).toContain("1\tbefore");
  expect((await run("edit", { file_path: "link", old_string: "before", new_string: "after" })).isError).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("after");
  expect(resultText(await run("read", { file_path: outside }))).toContain("1\tafter");
});

test("edit validates exact, unique matches without writing, with explicit replace all", async () => {
  const { put, run } = await world();
  const path = await put("note", "first\r\nrepeat repeat\r\nlast");
  for (const old_string of ["FIRST", "first\n", "repeat", ""]) {
    expect((await run("edit", { file_path: "note", old_string, new_string: "new" })).isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("first\r\nrepeat repeat\r\nlast");
  }
  expect((await run("edit", { file_path: "note", old_string: "repeat", new_string: "$&", replace_all: true })).isError).toBe(false);
  expect(await readFile(path, "utf8")).toBe("first\r\n$& $&\r\nlast");
  expect((await run("edit", { file_path: "note", old_string: "last", new_string: "" })).isError).toBe(false);
  expect(await readFile(path, "utf8")).toEndWith("\r\n");
  expect((await run("edit", { file_path: "absent", old_string: "x", new_string: "y" })).isError).toBe(true);
});

test("edit rejects overlapping ambiguity and preserves BOM", async () => {
  const { put, run } = await world();
  const path = await put("note", "\uFEFFaaa");
  expect((await run("edit", { file_path: "note", old_string: "aa", new_string: "x" })).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("\uFEFFaaa");
  expect((await run("edit", { file_path: "note", old_string: "aaa", new_string: "ok" })).isError).toBe(false);
  expect(await readFile(path, "utf8")).toBe("\uFEFFok");
});

describe("the native patch helper", () => {
  beforeAll(async () => {
    const build = Bun.spawn([process.execPath, "run", "scripts/build_patch.ts"], { cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await build.exited;
    if (code !== 0) throw new Error(`scripts/build_patch.ts exited with ${code}`);
  }, 1_800_000);

  test("patch failures use native validation and report sequential partial application", async () => {
    const { put, run, ctx } = await world();
    const path = await put("note", "original\n");
    const invalid = await run("apply_patch", { patch: "--- a/note\n+++ b/note\n@@\n-original\n+other" });
    expect(invalid.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("original\n");
    const partial = await run("apply_patch", { patch: "*** Begin Patch\n*** Add File: earlier\n+created\n*** Update File: note\n@@\n-absent\n+new\n*** End Patch" });
    expect(partial.isError).toBe(true);
    expect(resultText(partial)).toContain("earlier changes may remain");
    expect(await readFile(join(ctx.workspaceDir, "earlier"), "utf8")).toBe("created\n");
    expect(await readFile(path, "utf8")).toBe("original\n");
  });
});

test("tools enforce availability, dry run and host permissions", async () => {
  const { put, run, exec, ctx } = await world();
  const path = await put("locked", "old");
  exec.schemas = new Map();
  for (const name of ["read", "edit", "apply_patch", "bash"]) {
    expect((await run(name, { file_path: path, old_string: "old", new_string: "new" })).rejected).toBe(true);
  }
  exec.schemas = BUILTIN_TOOL_SCHEMAS;
  ctx.dryRun = true;
  expect((await run("edit", { file_path: path, old_string: "old", new_string: "new" })).isError).toBe(true);
  expect((await run("apply_patch", { patch: "*** Begin Patch\n*** Delete File: locked\n*** End Patch" })).isError).toBe(true);
  expect((await run("read", { file_path: path })).isError).toBe(false);
  ctx.dryRun = false;
  if (process.getuid?.() !== 0) {
    await chmod(path, 0o000);
    try {
      expect((await run("read", { file_path: path })).isError).toBe(true);
      expect((await run("edit", { file_path: path, old_string: "old", new_string: "new" })).isError).toBe(true);
    } finally { await chmod(path, 0o600); }
  }
  expect(await readFile(path, "utf8")).toBe("old");
  expect(renderToolDefs({ enabled_tools: ["edit", "apply_patch"], enabled_subagents: [] }, "Ada", "User").map((d) => d.name).sort()).toEqual(["apply_patch", "edit"]);
});
