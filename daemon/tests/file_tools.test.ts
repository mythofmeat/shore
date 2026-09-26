import { required } from "../src/util/required.ts";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolLimitsFrom, dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { BUILTIN_TOOL_SCHEMAS, renderToolDefs } from "../src/tools/registry.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/tools/workspace.ts";
import { toolResultImages, toolResultText } from "../src/llm/types.ts";
import { defaultToolsConfig } from "../src/config/app.ts";
import { oversizedImage, wideImage } from "./support/oversized_image.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function world() {
  const root = await mkdtemp(join(tmpdir(), "shore-files-"));
  roots.push(root);
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir);
  const ctx: ToolContext = {
    workspaceDir, characterName: "Ada", characterDataDir: root, imageDir: join(root, "images"),
    conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
    retrievalConfig: DEFAULT_RETRIEVAL_CONFIG, retrievalMode: "auto",
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

function resultImages(run: Awaited<ReturnType<typeof runToolUse>>) {
  if (run.block.type !== "tool_result") throw new Error("missing tool result");
  return toolResultImages(run.block.content);
}

test("read pages text with line numbers, CRLF, EOF, and no fabricated trailing line", async () => {
  const { put, run } = await world();
  await put("note", "one\r\ntwo\r\nthree\n");
  expect(resultText(await run("read", { file_path: "note", offset: 2, limit: 1 }))).toContain("2\ttwo\nPartial view. Continue with offset=3");
  expect(resultText(await run("read", { file_path: "note", offset: 3 }))).toContain("3\tthree\nEnd of file.");
  expect(resultText(await run("read", { file_path: "note", offset: 4 }))).toContain("beyond EOF");
  await put("empty", "");
  expect(resultText(await run("read", { file_path: "empty" }))).toContain("empty file");
});

test("read bounds long lines, line count and character budget explicitly", async () => {
  const { put, run, exec } = await world();
  await put("long", "🌊".repeat(4000) + "\n" + "x\n".repeat(3000));
  const first = resultText(await run("read", { file_path: "long" }));
  expect(first).toContain("line truncated after 2000 characters");
  expect(first).toContain("Continue with offset=2001");
  exec.limits = { max_result_chars: 1000, timeout_ms: 5000 };
  const bounded = resultText(await run("read", { file_path: "long" }));
  expect(Array.from(bounded).length).toBeLessThanOrEqual(1000);
  expect(bounded).toContain("Partial view");
});

test.each([{ offset: 0 }, { offset: 1.5 }, { limit: 2001 }, { limit: -1 }, { file_path: "" }])("read rejects malformed paging: %j", async (extra) => {
  const { run } = await world();
  const result = await run("read", { file_path: "absent", ...extra });
  expect(result.isError).toBe(true);
  expect(result.rejected).toBe(true);
});

test("read rejects directories, binaries, invalid UTF-8, corrupt and oversized images", async () => {
  const { put, run } = await world();
  await put("binary", Buffer.from([0, 1, 2]));
  await put("encoding", Buffer.from([255, 255]));
  await put("bad.png", "not a PNG");
  await put("large.png", Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(5 * 1024 * 1024)]));
  for (const file_path of [".", "binary", "encoding", "bad.png", "large.png", "missing"]) {
    expect((await run("read", { file_path })).isError).toBe(true);
  }
});

test("read returns real image blocks and prepares large dimensions", async () => {
  const { put, run, exec } = await world();
  const frames: ServerMessage[] = [];
  exec.sendDirect = (frame) => { frames.push(frame); };
  const image = await wideImage();
  await put("wide.png", Buffer.from(image.source.data, "base64"));
  const result = await run("read", { file_path: "wide.png" });
  expect(result.isError).toBe(false);
  if (result.block.type !== "tool_result") throw new Error("missing result");
  const pictures = toolResultImages(result.block.content);
  expect(pictures).toHaveLength(1);
  const source = required(pictures[0]).source;
  expect(source.data.length).toBeLessThanOrEqual(1_000_000);
  expect((await new Bun.Image(Buffer.from(source.data, "base64")).metadata()).width).toBeLessThanOrEqual(2000);
  expect(resultText(result)).toContain("resized or converted");
  expect(resultText(result)).not.toContain(source.data);
  const frame = required(frames.find((candidate) => candidate.type === "tool_result"));
  expect(frame.tool_name).toBe("read");
  expect(frame.images).toHaveLength(1);
  const preview = required(frame.images?.[0]);
  expect(preview.data).toBe(source.data);
  expect(preview.caption).toEndWith("wide.png");
  expect((await readFile(preview.path)).toString("base64")).toBe(image.source.data);
  expect(frame.output).not.toContain(source.data);
  expect((await run("read", { file_path: "wide.png", offset: 1 })).isError).toBe(true);
});

test("read image previews travel even when a media copy cannot be saved", async () => {
  const { put, run, exec } = await world();
  exec.ctx.imageDir = "";
  const frames: ServerMessage[] = [];
  exec.sendDirect = (frame) => { frames.push(frame); };
  await put("chart.png", Buffer.from(PNG, "base64"));
  const result = await run("read", { file_path: "chart.png" });
  expect(result.isError).toBe(false);
  const frame = required(frames.find((candidate) => candidate.type === "tool_result"));
  expect(frame.images).toHaveLength(1);
  expect(required(frame.images?.[0]).data).toBe(PNG);
  expect(required(frame.images?.[0]).path).toStartWith("tool-image:");
});

test("Markdown read expands local images beside the numbered source text", async () => {
  const { put, run, ctx, exec } = await world();
  await mkdir(join(ctx.workspaceDir, "docs", "images"), { recursive: true });
  await put("docs/images/chart one.png", Buffer.from(PNG, "base64"));
  await put("docs/guide.md", "# Guide\n\n![Chart](images/chart%20one.png)\n");
  const frames: ServerMessage[] = [];
  exec.sendDirect = (frame) => { frames.push(frame); };
  const result = await run("read", { file_path: "docs/guide.md" });
  expect(result.isError).toBe(false);
  expect(resultText(result)).toContain("3\t![Chart](images/chart%20one.png)");
  if (result.block.type !== "tool_result") throw new Error("missing result");
  expect(toolResultImages(result.block.content)).toHaveLength(1);
  expect(required(toolResultImages(result.block.content)[0]).source.data).toBe(PNG);
  const frame = required(frames.find((candidate) => candidate.type === "tool_result"));
  expect(frame.images).toHaveLength(1);
  expect(required(frame.images?.[0]).caption).toContain("Chart");
});

test("Markdown read resolves reference definitions outside the requested page and deduplicates paths", async () => {
  const { put, run } = await world();
  await put("chart.png", Buffer.from(PNG, "base64"));
  await put("guide.markdown", "[Earlier]: chart.png\n\n![First][earlier]\n![Later][]\n![Later]\n\n[later]: ./chart.png#preview\n[later]: absent.png\n");
  const result = await run("read", { file_path: "guide.markdown", offset: 3, limit: 3 });
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(1);
  expect(resultText(result)).toContain("lines 3–5");
  expect(resultText(result)).not.toContain("1\t[Earlier]");
  expect(resultText(result)).not.toContain("absent.png");
});

test("Markdown read ignores image examples in code, escapes, and HTML", async () => {
  const { put, run } = await world();
  await put("chart.png", Buffer.from(PNG, "base64"));
  const source = "```md\n![fenced](chart.png)\n```\n\n    ![indented](chart.png)\n\n`![inline](chart.png)`\n\\![escaped](chart.png)\n<!-- ![comment](chart.png) -->\n<img src=\"chart.png\">\n";
  await put("examples.md", source);
  expect(resultImages(await run("read", { file_path: "examples.md" }))).toHaveLength(0);
  expect(resultImages(await run("read", { file_path: "examples.md", offset: 2, limit: 1 }))).toHaveLength(0);
});

test("Markdown read does not expand images outside the visible page or truncated line", async () => {
  const { put, run, exec } = await world();
  await put("chart.png", Buffer.from(PNG, "base64"));
  await put("paged.md", "![before](chart.png)\ntext only\n![after](chart.png)\n");
  expect(resultImages(await run("read", { file_path: "paged.md", offset: 2, limit: 1 }))).toHaveLength(0);
  await put("truncated.md", "a".repeat(1995) + "![hidden](chart.png)\n![shown](chart.png)\n");
  expect(resultImages(await run("read", { file_path: "truncated.md", limit: 1 }))).toHaveLength(0);
  expect(resultImages(await run("read", { file_path: "truncated.md", offset: 2 }))).toHaveLength(1);
  exec.limits = { max_result_chars: 1000, timeout_ms: 5000 };
  await put("budget.md", "text ".repeat(90) + "\n" + "text ".repeat(90) + "\n![hidden](chart.png)\n");
  const bounded = await run("read", { file_path: "budget.md" });
  expect(resultImages(bounded)).toHaveLength(0);
  expect(resultText(bounded)).not.toContain("![hidden]");
});

test("Markdown read keeps source offsets correct for BOM, Unicode, CRLF, and multiline image syntax", async () => {
  const { put, run } = await world();
  await put("chart.png", Buffer.from(PNG, "base64"));
  await put("unicode.MD", "\uFEFF🌊 heading\r\n\r\n![a\r\nchart](chart.png)\r\n");
  expect(resultImages(await run("read", { file_path: "unicode.MD", offset: 3, limit: 2 }))).toHaveLength(1);
  expect(resultImages(await run("read", { file_path: "unicode.MD", offset: 3, limit: 1 }))).toHaveLength(0);
  expect(resultImages(await run("read", { file_path: "unicode.MD", offset: 4, limit: 1 }))).toHaveLength(0);
});

test("Markdown read decodes local destinations and accepts absolute paths", async () => {
  const { put, run, ctx } = await world();
  const absolute = await put("chart #1.png", Buffer.from(PNG, "base64"));
  await put("a(b)&c.png", Buffer.from(PNG, "base64"));
  await put("paths.md", `![Absolute](<${absolute.replace("#", "%23")}> "title")\n![Escaped](a\\(b\\)&amp;c.png?raw=1#preview)\n`);
  const result = await run("read", { file_path: join(ctx.workspaceDir, "paths.md") });
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(2);
});

test("Markdown read leaves remote and data references as text without fetching them", async () => {
  const { put, run } = await world();
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { requests += 1; return new Response(Buffer.from(PNG, "base64")); } });
  try {
    await put("remote.md", `![http](${server.url.toString()}chart.png)\n![relative](//127.0.0.1:${String(server.port)}/chart.png)\n![data](data:image/png;base64,${PNG})\n![file](file:///tmp/chart.png)\n`);
    const result = await run("read", { file_path: "remote.md" });
    expect(result.isError).toBe(false);
    expect(resultImages(result)).toHaveLength(0);
    expect(resultText(result)).toContain("![http]");
    expect(requests).toBe(0);
  } finally { await server.stop(true); }
});

test("Markdown read preserves text when local images are missing, invalid, or too large", async () => {
  const { put, run, exec } = await world();
  exec.limits.max_inline_image_bytes = 10 * 1024 * 1024;
  await put("bad.png", "not an image");
  await put("large.png", Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(5 * 1024 * 1024)]));
  for (const ref of ["missing.png", "bad.png", "large.png", "bad%GG.png", ".", "image%00.png"]) {
    await put("broken.md", `Keep this text\n![broken](${ref})\n`);
    const result = await run("read", { file_path: "broken.md" });
    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain("1\tKeep this text");
    expect(resultText(result)).toContain("not attached");
    expect(resultImages(result)).toHaveLength(0);
  }
});

test("Markdown read sends ten small images and counts duplicate paths only once", async () => {
  const { put, run, exec } = await world();
  exec.limits = toolLimitsFrom(defaultToolsConfig());
  const names = Array.from({ length: 10 }, (_, i) => `image${i}`);
  for (const name of names) await put(`${name}.png`, Buffer.from(PNG, "base64"));
  await put("many.md", names.map((name) => `![${name}](${name}.png)\n![same](./${name}.png)`).join("\n"));
  const result = await run("read", { file_path: "many.md" });
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(10);
  expect(resultText(result)).not.toContain("not attached");
});

test("Markdown read shares the per-result image budget and skips images that do not fit", async () => {
  const { put, run, exec } = await world();
  const png = Buffer.from(PNG, "base64");
  await put("a.png", png);
  await put("b.png", Buffer.concat([png, Buffer.alloc(1)]));
  await put("c.png", png);
  await put("budget.md", "![missing](missing.png)\n![a](a.png)\n![same](./a.png)\n![b](b.png)\n![c](c.png)\n");
  exec.limits.max_inline_image_bytes = 2 * png.length;
  const result = await run("read", { file_path: "budget.md" });
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(2);
  expect(resultText(result)).toContain("Markdown image missing.png not attached");
  expect(resultText(result)).toContain("Markdown image(s) b.png not read: they would not fit");
  expect(resultText(result)).toContain("5\t![c](c.png)");
  expect(resultText(result)).toContain("c.png) attached");

  exec.limits.config = { read: { max_inline_image_bytes: 3 * png.length + 1 } };
  expect(resultImages(await run("read", { file_path: "budget.md" }))).toHaveLength(3);
  exec.limits.config.read = { max_inline_image_bytes: 0 };
  const disabled = await run("read", { file_path: "budget.md" });
  expect(disabled.isError).toBe(false);
  expect(resultImages(disabled)).toHaveLength(0);
  expect(resultText(disabled)).toContain("5\t![c](c.png)");
  expect(resultText(disabled)).toContain("Markdown image(s) a.png, b.png, c.png not read: inline images are disabled for this tool");
  const direct = await run("read", { file_path: "a.png" });
  expect(direct.isError).toBe(false);
  expect(resultImages(direct)).toHaveLength(0);
  expect(resultText(direct)).toContain("inline images are disabled for this tool");
});

test("Markdown read does not read, save, or show sources that cannot fit the budget", async () => {
  const { put, run, exec } = await world();
  const png = Buffer.from(PNG, "base64");
  const names = Array.from({ length: 5 }, (_, i) => `i${String(i)}.png`);
  for (const name of names) await put(name, png);
  await put("five.md", names.map((name) => `![x](${name})`).join("\n"));
  const sent: ServerMessage[] = [];
  exec.sendDirect = (message) => sent.push(message);
  exec.limits.max_inline_image_bytes = 2 * png.length;
  const result = await run("read", { file_path: "five.md" });
  expect(resultImages(result)).toHaveLength(2);
  expect(sent.filter((message) => message.type === "send_image")).toHaveLength(2);
  expect(resultText(result)).toContain("Markdown image(s) i2.png, i3.png, i4.png not read");
});

test("Markdown read budgets prepared bytes, so large sources are resized to fit", async () => {
  const { put, run, exec } = await world();
  exec.limits = toolLimitsFrom(defaultToolsConfig());
  const large = Buffer.from((await oversizedImage()).source.data, "base64");
  await put("a.png", large);
  await put("b.png", large);
  await put("large.md", "![a](a.png)\n![b](b.png)\n");
  const result = await run("read", { file_path: "large.md" });
  expect(2 * large.length).toBeGreaterThan(defaultToolsConfig().max_inline_image_bytes);
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(2);
});

test("Markdown image notes are bounded and follow the page without displacing it", async () => {
  const { put, run, exec } = await world();
  const png = Buffer.from(PNG, "base64");
  const valid = Array.from({ length: 25 }, (_, i) => `v${String(i)}.png`);
  for (const name of valid) await put(name, png);
  const missing = Array.from({ length: 5 }, (_, i) => `![m](missing${String(i)}.png)`);
  const filler = Array.from({ length: 400 }, (_, i) => `filler line ${String(i)}`);
  await put("many.md", [...missing, ...valid.map((name) => `![v](${name})`), ...filler].join("\n"));
  exec.limits.max_result_chars = 4000;
  const result = await run("read", { file_path: "many.md" });
  const text = resultText(result);
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(15);
  expect(text.match(/Markdown image missing\d\.png not attached/g)).toHaveLength(3);
  expect(text).toContain("[2 more Markdown image reference(s) could not be attached]");
  expect(text).toContain("[10 more local image reference(s) not read; at most 20 are expanded per read.");
  expect(text).not.toContain("tool_result truncated");
  expect(text.indexOf("Partial view. Continue with offset=")).toBeGreaterThan(-1);
  expect(text.indexOf("Partial view. Continue with offset=")).toBeLessThan(text.indexOf("Markdown image missing0.png"));
  expect(result.output).toBe(text);
});

test("Markdown read bounds the document scanned for image references", async () => {
  const { put, run } = await world();
  await put("a.png", Buffer.from(PNG, "base64"));
  await put("huge.md", "![a](a.png)\n" + "a".repeat(1024 * 1024));
  const huge = await run("read", { file_path: "huge.md", limit: 1 });
  expect(huge.isError).toBe(false);
  expect(resultImages(huge)).toHaveLength(0);
  expect(resultText(huge)).toContain("1\t![a](a.png)");
  expect(resultText(huge)).toContain("Markdown images not expanded");
});

test("read does not expand Markdown syntax in other text files", async () => {
  const { put, run } = await world();
  await put("chart.png", Buffer.from(PNG, "base64"));
  await put("notes.txt", "![chart](chart.png)\n");
  expect(resultImages(await run("read", { file_path: "notes.txt" }))).toHaveLength(0);
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

test("native patches add, contextual update, rename, and delete", async () => {
  const { put, run, ctx } = await world();
  await put("old", "first\nold\nlast\n");
  await put("gone", "delete me");
  const patch = "*** Begin Patch\n*** Add File: added\n+hello\n*** Update File: old\n*** Move to: renamed\n@@\n first\n-old\n+new\n last\n*** Delete File: gone\n*** End Patch";
  const result = await run("apply_patch", { patch });
  expect(result.isError).toBe(false);
  expect(await readFile(join(ctx.workspaceDir, "added"), "utf8")).toBe("hello\n");
  expect(await readFile(join(ctx.workspaceDir, "renamed"), "utf8")).toBe("first\nnew\nlast\n");
  expect(await Bun.file(join(ctx.workspaceDir, "old")).exists()).toBe(false);
  expect(await Bun.file(join(ctx.workspaceDir, "gone")).exists()).toBe(false);
});

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

test("edit and partial patch changes queue prompt reload and participate in write tracking", async () => {
  const { put, run, ctx } = await world();
  await put("MEMORY.md", "old\n");
  const edits: string[] = [];
  const tracked: string[] = [];
  ctx.deferEdit = (path) => { edits.push(path); };
  ctx.trackWorkspaceWrite = async (name, _input, write) => { tracked.push(name); return write(); };
  await run("edit", { file_path: "MEMORY.md", old_string: "old", new_string: "new" });
  await run("apply_patch", { patch: "*** Begin Patch\n*** Update File: MEMORY.md\n@@\n-new\n+updated\n*** Delete File: absent\n*** End Patch" });
  expect(tracked).toEqual(["edit", "apply_patch"]);
  expect(edits).toEqual(["MEMORY.md", "MEMORY.md"]);
  const signal = AbortSignal.abort();
  expect(dispatchTool("apply_patch", { patch: "anything" }, { ...ctx, signal })).rejects.toThrow();
});

test("read handles JPEG, WebP and GIF as visual content", async () => {
  const { put, run } = await world();
  const wide = await wideImage();
  const bytes = Buffer.from(wide.source.data, "base64");
  const pictures = [
    ["image.jpg", await new Bun.Image(bytes).resize(10, 10).jpeg().toBuffer()],
    ["image.webp", await new Bun.Image(bytes).resize(10, 10).webp().toBuffer()],
    ["image.gif", Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64")],
  ] as const;
  for (const [file_path, data] of pictures) {
    await put(file_path, Buffer.from(data));
    const result = await run("read", { file_path });
    expect(result.isError).toBe(false);
    if (result.block.type !== "tool_result") throw new Error("missing result");
    expect(toolResultImages(result.block.content)).toHaveLength(1);
    if (file_path.endsWith("gif")) expect(resultText(result)).toContain("first frame only");
  }
});

test("native patch paths follow symlinks and permit host-accessible parent paths", async () => {
  const { root, ctx, run } = await world();
  const outside = join(root, "outside");
  await writeFile(outside, "before\n");
  await symlink(outside, join(ctx.workspaceDir, "link"));
  const result = await run("apply_patch", { patch: "*** Begin Patch\n*** Update File: link\n@@\n-before\n+after\n*** Add File: ../parent-added\n+literal $(exit 1)\n*** End Patch" });
  expect(result.isError).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("after\n");
  expect(await readFile(join(root, "parent-added"), "utf8")).toBe("literal $(exit 1)\n");
});

test("a model-requested read reaches the HTTP continuation and is not rerun after image rejection", async () => {
  const { put, exec } = await world();
  await put("actual.png", Buffer.from(PNG, "base64"));
  const { OpenAIProvider } = await import("../src/llm/providers/openai.ts");
  const { genericToolLoopEvents } = await import("../src/llm/providers/generic_loop.ts");
  const { withToolImages } = await import("../src/llm/tool_images.ts");
  const { toolPhase } = await import("../src/tools/execute.ts");
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json() as Record<string, unknown>);
    if (bodies.length === 2) return Response.json({ error: { message: "image input is not supported", type: "invalid_request_error" } }, { status: 400 });
    const first = bodies.length === 1;
    const delta = first ? { tool_calls: [{ index: 0, id: "read-actual", type: "function", function: { name: "read", arguments: '{"file_path":"actual.png"}' } }] } : { content: "continued without image" };
    const chunk = { id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const warnings: string[] = [];
  const phase = toolPhase(exec);
  let executed = 0;
  const runTool = phase.runTool;
  phase.runTool = (use) => { executed += 1; return runTool(use); };
  try {
    const provider = withToolImages(new OpenAIProvider(), { support: () => undefined, rejected: () => {}, warn: (message) => warnings.push(message) });
    const events = await Array.fromAsync(genericToolLoopEvents(provider, {
      sdk: "openai", model: "fixture", api_key: "test", base_url: server.url.toString(), max_tokens: 64,
      replay_prior_thinking: "all", messages: [{ role: "user", content: [{ type: "text", text: "read actual.png" }] }],
      tools: renderToolDefs({ enabled_tools: ["read"], enabled_subagents: [] }, "Ada", "User"),
    }, phase));
    expect(events.at(-1)).toMatchObject({ type: "done", content: "continued without image" });
    expect(executed).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[1])).toContain(`data:image/png;base64,${PNG}`);
    expect(JSON.stringify(bodies[2])).not.toContain(PNG);
    expect(warnings).toHaveLength(1);
    const stored = phase.messages.at(-1)?.content_blocks[0];
    if (stored?.type !== "tool_result") throw new Error("missing persisted read");
    expect(toolResultImages(stored.content)).toHaveLength(1);
  } finally { await server.stop(true); }
});

test.skipIf(process.platform === "win32")("cancelling a native patch stops the helper and reports earlier changes", async () => {
  const { run, ctx } = await world();
  const { runProcess } = await import("../src/tools/workspace.ts");
  await runProcess("mkfifo", ["blocked"], { cwd: ctx.workspaceDir });
  const abort = new AbortController();
  ctx.signal = abort.signal;
  const running = run("apply_patch", { patch: "*** Begin Patch\n*** Add File: earlier\n+created\n*** Update File: blocked\n@@\n-old\n+new\n*** End Patch" });
  const path = join(ctx.workspaceDir, "earlier");
  try {
    const deadline = Date.now() + 2000;
    while (!await Bun.file(path).exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await Bun.file(path).exists()).toBe(true);
  } finally { abort.abort(); }
  const result = await running;
  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain("earlier changes may remain");
  expect(await readFile(path, "utf8")).toBe("created\n");
});

test("an unavailable helper fails explicitly without changing a file", async () => {
  const { run, put } = await world();
  const path = await put("note", "old\n");
  try {
    setTestEnv("SHORE_APPLY_PATCH_PATH", "/nonexistent/shore-apply-patch");
    const result = await run("apply_patch", { patch: "*** Begin Patch\n*** Delete File: note\n*** End Patch" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Patch helper failed");
    expect(await readFile(path, "utf8")).toBe("old\n");
    setTestEnv("SHORE_APPLY_PATCH_PATH", "relative-helper");
    expect(resultText(await run("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }))).toContain("absolute executable path");
  } finally {
    restoreTestEnv();
  }
});
