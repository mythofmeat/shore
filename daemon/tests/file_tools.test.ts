import { required } from "../src/util/required.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolLimitsFrom, dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { MAX_READ_IMAGE_BYTES } from "../src/tools/read_image.ts";
import { renderToolDefs } from "../src/tools/registry.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { toolResultImages, toolResultText } from "../src/llm/types.ts";
import { defaultToolsConfig } from "../src/config/app.ts";
import { oversizedImage, wideImage } from "./support/oversized_image.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";

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
  expect(resultText(result)).toContain("wide.png: reduced from 4000×1000 PNG (2,116 tokens) to 2000×500 PNG (1,296 tokens). Read it with original: true for the full image.]");
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
  exec.ctx.cacheDir = "";
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

test("Markdown read expands wikilink images by unique name anywhere in the workspace", async () => {
  const { put, run, ctx, exec, root } = await world();
  await mkdir(join(ctx.workspaceDir, "memory", ".attachments"), { recursive: true });
  await mkdir(join(ctx.workspaceDir, "art", "sheets"), { recursive: true });
  await put("memory/.attachments/portrait one.png", Buffer.from(PNG, "base64"));
  await put("art/sheets/card.png", Buffer.from(PNG, "base64"));
  await put("art/sheets/back.png", Buffer.from(PNG, "base64"));
  await put("memory/journal.md", "# Day one\n\n![[portrait one.png|Ada at the pier]]\n![[portrait one.png]] ![[sheets/card.png|300]]\n![[ art/sheets/back.png ]]\n");
  const frames: ServerMessage[] = [];
  exec.sendDirect = (frame) => { frames.push(frame); };
  const result = await run("read", { file_path: "memory/journal.md" });
  expect(result.isError).toBe(false);
  expect(resultText(result)).toContain("3\t![[portrait one.png|Ada at the pier]]");
  expect(resultText(result)).not.toContain("not attached");
  expect(resultImages(result)).toHaveLength(3);
  const captions = required(frames.find((candidate) => candidate.type === "tool_result")).images?.map((image) => image.caption);
  expect(captions).toEqual([
    `Ada at the pier (${join(ctx.workspaceDir, "memory/.attachments/portrait one.png")})`,
    join(ctx.workspaceDir, "art/sheets/card.png"),
    join(ctx.workspaceDir, "art/sheets/back.png"),
  ]);

  await writeFile(join(root, "outside.md"), "![[card.png]]\n");
  expect(resultImages(await run("read", { file_path: join(root, "outside.md") }))).toHaveLength(1);
});

test("Markdown read skips wikilink images that match no file or more than one", async () => {
  const { put, run, ctx } = await world();
  for (const dir of ["a", "b", "ax"]) await mkdir(join(ctx.workspaceDir, dir));
  for (const file of ["a/img.png", "b/img.png", "ax/pic.png"]) await put(file, Buffer.from(PNG, "base64"));
  await put("links.md", "![[img.png]]\n![[img.png]]\n![[mg.png]]\n![[x/pic.png]]\n![[b/img.png]]\n");
  const result = await run("read", { file_path: "links.md" });
  expect(result.isError).toBe(false);
  expect(resultImages(result)).toHaveLength(1);
  const text = resultText(result);
  expect(text).toContain("[Markdown image ![[img.png]] not attached: 2 pictures match: ![[a/img.png]], ![[b/img.png]]]");
  expect(text.match(/\[\[img\.png\]\] not attached/g)).toHaveLength(1);
  expect(text).toContain("[Markdown image ![[mg.png]] not attached: no picture matches; did you mean ![[a/img.png]], ![[b/img.png]]?]");
  expect(text).toContain("[Markdown image ![[x/pic.png]] not attached: no picture matches; did you mean ![[pic.png]]?]");

  for (const dir of ["c", "d"]) await mkdir(join(ctx.workspaceDir, dir));
  for (const file of ["c/img.png", "d/img.png"]) await put(file, Buffer.from(PNG, "base64"));
  await put("crowded.md", "![[img.png]]\n");
  expect(resultText(await run("read", { file_path: "crowded.md" }))).toContain("4 pictures match: ![[a/img.png]], ![[b/img.png]], ![[c/img.png]] and 1 more]");
});

test("Markdown read searches hidden folders for wikilink images but not .git or symlinks", async () => {
  const { put, run, ctx } = await world();
  for (const dir of [".attachments", ".git"]) await mkdir(join(ctx.workspaceDir, dir));
  await put(".attachments/pic.png", Buffer.from(PNG, "base64"));
  await put(".git/pic.png", Buffer.from(PNG, "base64"));
  await symlink(join(ctx.workspaceDir, ".attachments"), join(ctx.workspaceDir, "linked"));
  await symlink(join(ctx.workspaceDir, ".attachments", "pic.png"), join(ctx.workspaceDir, "alias.png"));
  await put("links.md", "![[pic.png]]\n![[alias.png]]\n");
  const result = await run("read", { file_path: "links.md" });
  expect(resultImages(result)).toHaveLength(1);
  expect(resultText(result)).not.toContain("[[pic.png]] not attached");
  expect(resultText(result)).toContain("[Markdown image ![[alias.png]] not attached: no picture matches]");
});

test("Markdown read leaves wikilinks that are not visible image embeds as text", async () => {
  const { put, run } = await world();
  await put("img.png", Buffer.from(PNG, "base64"));
  await put("b.png", Buffer.from(PNG, "base64"));
  await put("Some Note.md", "");
  await put("notes.md", "");
  const source = "[[img.png]] ![[Some Note]] ![[notes.md]] ![[img.png\n\\![[img.png]] `![[img.png]]` ![img.png]] !\\[[img.png]]\n```\n![[img.png]]\n```\n";
  await put("examples.md", source);
  const examples = await run("read", { file_path: "examples.md" });
  expect(resultImages(examples)).toHaveLength(0);
  expect(resultText(examples)).not.toContain("not attached");

  await put("escaped.md", "\\\\![[img.png]]\n");
  expect(resultImages(await run("read", { file_path: "escaped.md" }))).toHaveLength(1);

  await put("paged.md", "first ![[img.png]]\nsecond ![[b.png]]\n");
  const first = await run("read", { file_path: "paged.md", limit: 1 });
  expect(resultImages(first)).toHaveLength(1);
  expect(resultText(first)).not.toContain("b.png]] not");
  expect(resultImages(await run("read", { file_path: "paged.md", offset: 2 }))).toHaveLength(1);
});

test("Markdown read finds wikilink pictures without an extension and reports embeds that name nothing", async () => {
  const { put, run, ctx } = await world();
  for (const dir of [".attachments", "art", "old"]) await mkdir(join(ctx.workspaceDir, dir));
  await put(".attachments/harbor.webp", Buffer.from(PNG, "base64"));
  for (const file of ["art/sketch.png", "art/sketch.JPG", "old/sketch.png"]) await put(file, Buffer.from(PNG, "base64"));
  await put("market.md", "# Market\n");
  await put("links.md", "![[harbor|the harbor]]\n![[sketch]]\n![[sketch.JPG]]\n![[old/sketch]]\n![[market]] ![[market#Stalls]] ![[#Intro]]\n![[lost-note]]\n");
  await put("typos.md", "![[Harbor]]\n![[sketch.jpg]]\n");
  const result = await run("read", { file_path: "links.md" });
  const text = resultText(result) + resultText(await run("read", { file_path: "typos.md" }));
  expect(resultImages(result)).toHaveLength(3);
  expect(text).toContain(`[the harbor (${join(ctx.workspaceDir, ".attachments/harbor.webp")}) attached`);
  for (const file of ["art/sketch.JPG", "old/sketch.png"]) expect(text).toContain(`[${join(ctx.workspaceDir, file)} attached`);
  expect(text).toContain("[Markdown image ![[sketch]] not attached: 3 pictures match: ![[sketch.JPG]], ![[art/sketch.png]], ![[old/sketch.png]]]");
  for (const embed of ["![[market]]", "![[market#Stalls]]", "![[#Intro]]"]) expect(text).not.toContain(`${embed} not attached`);
  expect(text).toContain("[Markdown image ![[lost-note]] not attached: no picture matches]");
  expect(text).toContain("[Markdown image ![[Harbor]] not attached: no picture matches; did you mean ![[harbor.webp]]?]");
  expect(text).toContain("[Markdown image ![[sketch.jpg]] not attached: no picture matches; did you mean ![[sketch.JPG]], ![[art/sketch.png]], ![[old/sketch.png]]?]");
});

test("a leading slash anchors a wikilink at the workspace root", async () => {
  const { put, run, ctx } = await world();
  await mkdir(join(ctx.workspaceDir, "a"));
  for (const file of ["img.png", "a/img.png"]) await put(file, Buffer.from(PNG, "base64"));
  await put("links.md", "![[img.png]]\n![[/img.png]]\n![[/a/img.png]]\n![[/b/img.png]]\n");
  const text = resultText(await run("read", { file_path: "links.md" }));
  expect(text).toContain("[Markdown image ![[img.png]] not attached: 2 pictures match: ![[a/img.png]], ![[/img.png]]]");
  expect(text).toContain(`${join(ctx.workspaceDir, "img.png")} attached`);
  expect(text).toContain(`${join(ctx.workspaceDir, "a/img.png")} attached`);
  expect(text).toContain("[Markdown image ![[/b/img.png]] not attached: no picture matches; did you mean ![[a/img.png]], ![[/img.png]]?]");
  expect(resultText(await run("read", { file_path: "/img.png" }))).toContain("ENOENT");
});

test("read opens a [[link]] by note or picture name anywhere in the workspace", async () => {
  const { put, run, ctx } = await world();
  for (const dir of ["places/harbor", ".attachments"]) await mkdir(join(ctx.workspaceDir, dir), { recursive: true });
  const market = await put("places/harbor/market.md", "# Market\n");
  const portrait = await put(".attachments/portrait.png", Buffer.from(PNG, "base64"));
  for (const file_path of ["[[market]]", "[[market.md]]", "[[harbor/market|the market]]", "[[market#Stalls]]", " [[/places/harbor/market]] ", "![[market]]"]) {
    const result = await run("read", { file_path });
    expect(result.isError).toBe(false);
    expect(resultText(result)).toBe(`${market}: lines 1–1\n1\t# Market\nEnd of file.`);
  }
  for (const file_path of ["![[portrait.png]]", "![[portrait|a portrait]]", "[[portrait.png]]"]) {
    const result = await run("read", { file_path });
    expect(resultText(result)).toStartWith(`${portrait}: image/png`);
    expect(resultImages(result)).toHaveLength(1);
  }
  expect(resultText(await run("read", { file_path: "[[places/market]]" }))).toBe("io: [[places/market]]: no note or file matches; did you mean [[market]]?");
  expect(resultText(await run("read", { file_path: "[[portrait]]" }))).toBe("io: [[portrait]]: no note or file matches");
  expect(resultText(await run("read", { file_path: "![[mrket]]" }))).toBe("io: ![[mrket]]: no picture or note matches; did you mean [[market]]?");
  for (const file_path of ["[[]]", "[[#Stalls]]", "[[|alias]]"]) {
    expect(resultText(await run("read", { file_path }))).toBe(`io: ${file_path}: the link names no file`);
  }
});

test("read opens any other file by its whole name and a folder by a link ending in /", async () => {
  const { put, run, ctx } = await world();
  for (const dir of ["logs", "old/logs", "places/harbor", "art/.drafts"]) await mkdir(join(ctx.workspaceDir, dir), { recursive: true });
  const log = await put("logs/2025-log.csv", "day,mood\n");
  await put("old/logs/2025-log.csv", "old\n");
  await put("places/harbor/market.md", "# Market\n");
  await put("places/notes.txt", "notes\n");
  await put("art/portrait.png", Buffer.from(PNG, "base64"));
  await put("art/.drafts/sketch.png", Buffer.from(PNG, "base64"));
  expect(resultText(await run("read", { file_path: "[[notes.txt]]" }))).toBe(`${join(ctx.workspaceDir, "places/notes.txt")}: lines 1–1\n1\tnotes\nEnd of file.`);
  expect(resultText(await run("read", { file_path: "[[2025-log.csv]]" }))).toBe("io: [[2025-log.csv]]: 2 files match: [[/logs/2025-log.csv]], [[old/logs/2025-log.csv]]");
  expect(resultText(await run("read", { file_path: "[[/logs/2025-log.csv]]" }))).toStartWith(`${log}: lines 1–1\n1\tday,mood`);
  const found = await run("read", { file_path: "2025-log.csv" });
  expect(found.isError).toBe(true);
  expect(resultText(found)).toContain("2 files match");
  expect(resultText(await run("read", { file_path: "notes.txt" }))).toEndWith("[notes.txt does not exist; found [[notes.txt]] by name.]");
  const harbor = `${join(ctx.workspaceDir, "places/harbor")}/: folder\n└── market.md\n0 folders, 1 file`;
  for (const file_path of ["[[harbor/]]", "[[places/harbor/]]", "[[/places/harbor/]]", "places/harbor", "places/harbor/", "harbor"]) {
    const result = await run("read", { file_path });
    expect(result.isError).toBe(false);
    expect(resultText(result)).toStartWith(harbor);
  }
  expect(resultText(await run("read", { file_path: "[[logs/]]" }))).toBe("io: [[logs/]]: 2 folders match: [[/logs/]], [[old/logs/]]");
  expect(resultText(await run("read", { file_path: "[[harbr/]]" }))).toBe("io: [[harbr/]]: no folder matches; did you mean [[harbor/]]?");
  expect(resultText(await run("read", { file_path: "[[harbor]]" }))).toBe("io: [[harbor]]: no note or file matches; did you mean [[harbor/]]?");
  expect(resultText(await run("read", { file_path: "[[.drafts/]]" }))).toBe(`${join(ctx.workspaceDir, "art/.drafts")}/: folder\n└── sketch.png\n0 folders, 1 file`);
  expect(resultText(await run("read", { file_path: "." }))).toBe([
    `${ctx.workspaceDir}/: folder`,
    "├── art/",
    "│   └── portrait.png",
    "├── logs/",
    "│   └── 2025-log.csv",
    "├── old/",
    "│   └── logs/",
    "│       └── 2025-log.csv",
    "└── places/",
    "    ├── harbor/",
    "    │   └── market.md",
    "    └── notes.txt",
    "6 folders, 5 files; 1 hidden not shown, read them by path",
  ].join("\n"));
  for (const input of [{ file_path: "[[harbor/]]", limit: 5 }, { file_path: "[[harbor/]]", original: true }]) {
    expect((await run("read", input)).isError).toBe(true);
  }
});

test("read cuts a long folder listing off within the result budget", async () => {
  const { put, run, exec, ctx } = await world();
  exec.limits.max_result_chars = 1000;
  await mkdir(join(ctx.workspaceDir, "many"));
  for (let index = 0; index < 200; index += 1) await put(`many/file-${String(index).padStart(3, "0")}.txt`, "");
  const text = resultText(await run("read", { file_path: "many" }));
  expect(text.length).toBeLessThanOrEqual(1000);
  expect(text).toContain("├── file-000.txt");
  expect(text).toEndWith("entries; read a subfolder to see the rest.]");
});

test("read lists every file a name fits as links with the fewest folders that pick each one", async () => {
  const { put, run, ctx } = await world();
  for (const dir of ["north/places", "south/places", "places", "art", "old"]) await mkdir(join(ctx.workspaceDir, dir), { recursive: true });
  for (const file of ["inn.md", "north/places/inn.md", "places/inn.md", "south/places/inn.md"]) await put(file, `${file}\n`);
  for (const file of ["art/sketch.png", "art/sketch.jpg", "old/sketch.png"]) await put(file, Buffer.from(PNG, "base64"));
  const inns = await run("read", { file_path: "[[inn]]" });
  expect(inns.isError).toBe(true);
  expect(resultText(inns)).toBe("io: [[inn]]: 4 notes match: [[/inn]], [[north/places/inn]], [[/places/inn]], [[south/places/inn]]");
  for (const [file_path, file] of [["[[/inn]]", "inn.md"], ["[[north/places/inn]]", "north/places/inn.md"], ["[[/places/inn]]", "places/inn.md"], ["[[south/places/inn]]", "south/places/inn.md"]] as const) {
    expect(resultText(await run("read", { file_path }))).toStartWith(`${join(ctx.workspaceDir, file)}: lines 1–1\n1\t${file}`);
  }
  expect(resultText(await run("read", { file_path: "![[sketch]]" }))).toBe("io: ![[sketch]]: 3 pictures match: ![[sketch.jpg]], ![[art/sketch.png]], ![[old/sketch.png]]");
  for (const [file_path, file] of [["![[sketch.jpg]]", "art/sketch.jpg"], ["![[art/sketch.png]]", "art/sketch.png"], ["![[old/sketch.png]]", "old/sketch.png"]] as const) {
    expect(resultText(await run("read", { file_path }))).toStartWith(`${join(ctx.workspaceDir, file)}: image/png`);
  }
});

test("read tries a missing path or a folder without a trailing / as a name and says it did", async () => {
  const { root, put, run, ctx } = await world();
  for (const dir of ["places/harbor", "lighthouse", "notes", "art"]) await mkdir(join(ctx.workspaceDir, dir), { recursive: true });
  const market = await put("places/harbor/market.md", "# Market\n");
  const lighthouse = await put("notes/lighthouse.md", "# Lighthouse\n");
  const portrait = await put("art/portrait.png", Buffer.from(PNG, "base64"));
  await put("MEMORY.md", "# Memory\n");
  const named = await run("read", { file_path: "market" });
  expect(named.isError).toBe(false);
  expect(resultText(named)).toBe(`${market}: lines 1–1\n1\t# Market\nEnd of file.\n[market does not exist; found [[market]] by name.]`);
  expect(resultText(await run("read", { file_path: "harbor/market.md" }))).toEndWith("[harbor/market.md does not exist; found [[market]] by name.]");
  expect(resultText(await run("read", { file_path: "lighthouse.md" }))).toBe(`${lighthouse}: lines 1–1\n1\t# Lighthouse\nEnd of file.\n[lighthouse.md does not exist; found [[lighthouse]] by name.]`);
  expect(resultText(await run("read", { file_path: "lighthouse" }))).toBe(`${lighthouse}: lines 1–1\n1\t# Lighthouse\nEnd of file.\n[lighthouse is a folder; found [[lighthouse]] by name. Read lighthouse/ to list the folder.]`);
  expect(resultText(await run("read", { file_path: "lighthouse/" }))).toBe(`${join(ctx.workspaceDir, "lighthouse")}/: folder\n0 folders, 0 files`);
  expect(resultText(await run("read", { file_path: "art" }))).toBe(`${join(ctx.workspaceDir, "art")}/: folder\n└── portrait.png\n0 folders, 1 file`);
  const picture = await run("read", { file_path: "portrait.png" });
  expect(resultText(picture)).toStartWith(`${portrait}: image/png`);
  expect(resultText(picture)).toContain("[portrait.png does not exist; found ![[portrait.png]] by name.]");
  expect(resultImages(picture)).toHaveLength(1);
  expect(resultText(await run("read", { file_path: "MEMORY.md" }))).toBe(`${join(ctx.workspaceDir, "MEMORY.md")}: lines 1–1\n1\t# Memory\nEnd of file.`);
  const stale = join(ctx.workspaceDir, "old/market.md");
  expect(resultText(await run("read", { file_path: stale }))).toBe(`io: ${stale} does not exist; tried as [[old/market.md]]: no note, file or folder matches; did you mean [[market]]?`);
  expect(resultText(await run("read", { file_path: "portrait" }))).toBe(`io: ${join(ctx.workspaceDir, "portrait")} does not exist; tried as [[portrait]]: no note, file or folder matches`);
  for (const file_path of [join(root, "market"), "../market"]) {
    const outside = await run("read", { file_path });
    expect(outside.isError).toBe(true);
    expect(resultText(outside)).not.toContain("tried as");
  }
});

test("read leaves notes in hidden folders and all-caps notes out of names but reads them by path", async () => {
  const { put, run, ctx } = await world();
  for (const dir of [".drafts", "memory", "docs", "log"]) await mkdir(join(ctx.workspaceDir, dir));
  for (const file of [".drafts/market.md", ".pier.md", "memory/MEMORY.md", "docs/README.md", "README.md", "log/2026-10-03.md", "NPC-list.md"]) await put(file, `${file}\n`);
  expect(resultText(await run("read", { file_path: "[[market]]" }))).toBe("io: [[market]]: no note or file matches");
  expect(resultText(await run("read", { file_path: "[[.pier]]" }))).toBe("io: [[.pier]]: no note or file matches");
  expect(resultText(await run("read", { file_path: "[[MEMORY]]" }))).toBe("io: [[MEMORY]]: no note or file matches; all-caps notes are skipped as names, so read it by path: memory/MEMORY.md; did you mean [[memory/]]?");
  expect(resultText(await run("read", { file_path: "[[README]]" }))).toBe("io: [[README]]: no note or file matches; all-caps notes are skipped as names, so read one by path: README.md, docs/README.md");
  for (const [file_path, file] of [["[[2026-10-03]]", "log/2026-10-03.md"], ["[[NPC-list]]", "NPC-list.md"]] as const) {
    expect(resultText(await run("read", { file_path }))).toContain(`1\t${file}`);
  }
  for (const file of [".drafts/market.md", "memory/MEMORY.md"]) expect(resultText(await run("read", { file_path: file }))).toContain(`1\t${file}`);
});

test("read suggests the closest names when nothing matches, including ones off only by case", async () => {
  const { put, run, ctx } = await world();
  await mkdir(join(ctx.workspaceDir, "art"));
  for (const file of ["Harbor.md", "harbour.md", "market.md"]) await put(file, `${file}\n`);
  await put("art/harbor.png", Buffer.from(PNG, "base64"));
  expect(resultText(await run("read", { file_path: "[[harbor]]" }))).toBe("io: [[harbor]]: no note or file matches; did you mean [[Harbor]], [[harbour]]?");
  expect(resultText(await run("read", { file_path: "![[harbr]]" }))).toBe("io: ![[harbr]]: no picture or note matches; did you mean ![[harbor.png]], [[Harbor]]?");
  expect(resultText(await run("read", { file_path: "[[lighthouse]]" }))).toBe("io: [[lighthouse]]: no note or file matches");
});

test("Markdown read preserves text when local images are missing, invalid, or too large", async () => {
  const { put, run, exec } = await world();
  exec.limits.max_inline_image_bytes = 10 * 1024 * 1024;
  await put("bad.png", "not an image");
  await truncate(await put("large.png", Buffer.from(PNG, "base64")), MAX_READ_IMAGE_BYTES + 1);
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

describe("the native patch helper", () => {
  beforeAll(async () => {
    const build = Bun.spawn([process.execPath, "run", "scripts/build_patch.ts"], { cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await build.exited;
    if (code !== 0) throw new Error(`scripts/build_patch.ts exited with ${code}`);
  }, 1_800_000);

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
    expect(await outcomeOf(dispatchTool("apply_patch", { patch: "anything" }, { ...ctx, signal }))).toThrow();
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
    if (file_path.endsWith("gif")) expect(resultText(result)).toContain("image.gif: reduced from 1×1 GIF (1 token) to 1×1 PNG (1 token), first frame only.");
  }
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
