import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readdir, readlink, lstat, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bestLineExcerpt,
  characterGitIdentity,
  checkoutTargetsAPathspec,
  DEFAULT_MEMORY_FILE_LIMITS,
  excerptLine,
  findCaseInsensitiveMatch,
  SEARCH_EXCERPT_CHARS,
  GIT_SAFETY_FLAGS,
  handleDelete,
  handleEdit,
  handleGit,
  handleRead,
  handleSearch,
  isPathLikeArg,
  memoryFileLimitFor,
  trashStamp,
  validateGitArgs,
  validateGitSubcommand,
  validateGitSubcommandToken,
  DEFAULT_RETRIEVAL_CONFIG,
  type ToolInput,
} from "../src/tools/workspace";
import { testTmp } from "./support/tmp.ts";
import { compareRustStrings, rustLines } from "../src/memory/lines";
import { expandShared } from "./support/shared_subtrees.ts";
import { recordedValue, recording } from "./support/rerecord.ts";

const CAPTURE = "tests/tools_captures/workspace_tools.json";

const fixture = expandShared<Fixture>(
  JSON.parse(
  readFileSync(new URL("./tools_captures/workspace_tools.json", import.meta.url), "utf8"),
  ),
);

interface Fixture {
  read: ReadCase[];
  edit: EditCase[];
  delete: DeleteCase[];
  trash_stamp: { millis: number; stamp: string }[];
  search: SearchCase[];
  best_line: { name: string; content: string; query_lower: string; line: number; excerpt: string }[];
  git_validation: GitValidation;
  git_identity: { character: string; name: string; email: string }[];
}

type Outcome = { ok: unknown } | { err: string };

interface TreeNode {
  path: string;
  kind: "dir" | "file" | "symlink";
  content?: string;
  bytes?: number[];
  target?: string;
  mtime_secs?: number;
}

interface ReadCase {
  name: string;
  tree: TreeNode[];
  input: ToolInput;
  result: Outcome;
  workspace_unset?: boolean;
  workspace_missing?: boolean;
}

interface EditCase extends Omit<ReadCase, "result"> {
  result?: Outcome;
}

interface DeleteCase {
  name: string;
  tree: TreeNode[];
  input: ToolInput;
  with_data_dir: boolean;
  result?: Outcome;
}

interface SearchCase extends Omit<ReadCase, "result"> {
  max_file_bytes: number | null;
  result?: Outcome;
  searched_files?: number;
  skipped_binary_or_large?: number;
}

interface GitValidation {
  subcommand: { sub: string[]; result: Outcome }[];
  token: { token: string; result: Outcome }[];
  path_like: { arg: string; path_like: boolean }[];
  checkout_pathspec: { rest: string[]; pathspec: boolean }[];
  args: { args: string[]; result: Outcome }[];
  args_workspace_unset: Outcome;
  tree: TreeNode[];
  safety_flags: string[];
}

async function makeCase(
  tree: TreeNode[],
  missing = false,
): Promise<{ workspace: string; data: string }> {
  const root = mkdtempSync(testTmp("shore-ws-"));
  const workspace = join(root, "workspace");
  const data = join(root, "char", "data");
  await mkdir(data, { recursive: true });
  if (missing) return { workspace, data };
  await mkdir(workspace, { recursive: true });

  for (const node of tree) {
    const path = join(workspace, node.path);
    if (node.kind === "dir") {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    if (node.kind === "symlink") {
      await symlink(required(node.target), path);
      continue;
    }
    await writeFile(path, node.bytes !== undefined ? Buffer.from(node.bytes) : required(node.content));
    if (node.mtime_secs !== undefined) {
      await utimes(path, node.mtime_secs, node.mtime_secs);
    }
  }

  return { workspace, data };
}

async function snapshot(root: string): Promise<TreeNode[]> {
  const out: TreeNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = required(pending.pop());
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const rel = path.slice(root.length + 1);
      const meta = await lstat(path);
      if (meta.isSymbolicLink()) {
        out.push({ path: rel, kind: "symlink", target: await readlink(path) });
      } else if (meta.isDirectory()) {
        out.push({ path: rel, kind: "dir" });
        pending.push(path);
      } else {
        const bytes = await readFile(path);
        try {
          out.push({
            path: rel,
            kind: "file",
            content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } catch {
          out.push({ path: rel, kind: "file", bytes: [...bytes] });
        }
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await run() };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

function syncOutcome(run: () => void): Outcome {
  try {
    run();
    return { ok: true };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

describe("read", () => {
  for (const [index, c] of fixture.read.entries()) {
    test(c.name, async () => {
      const { workspace } = await makeCase(c.tree, c.workspace_missing === true);
      const ws = c.workspace_unset === true ? "" : workspace;
      const got = await outcome(() => handleRead(c.input, ws));
      recordedValue(CAPTURE, ["read", index, "result"], got);
      if (recording) return;
      expect(got).toEqual(c.result);
    });
  }

  test("directory trees show nested files without filesystem sizes", async () => {
    const { workspace } = await makeCase([
      { path: "sub", kind: "dir" },
      { path: "sub/deep.md", kind: "file", content: "deep file" },
    ]);
    expect(await handleRead({}, workspace)).toBe("workspace/\n└── sub/\n    └── deep.md");
  });
});

function changedPaths(
  before: { path: string; content?: string }[],
  after: { path: string; content?: string }[],
): string[] {
  const key = (n: { path: string; content?: string }) => `${n.path}\u0000${n.content ?? ""}`;
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  const paths = new Set<string>();
  for (const n of after) if (!was.has(key(n))) paths.add(n.path);
  for (const n of before) if (!now.has(key(n))) paths.add(n.path);
  return [...paths].sort();
}

const NO_MATCH_EXCERPT_CHARS = 800;

function applyEdits(
  before: string,
  edits: { old_string: string; new_string: string; replace_all?: unknown }[],
): { text: string; replacements: number } {
  let text = before;
  let replacements = 0;
  for (const edit of edits) {
    if (edit.replace_all === true) {
      replacements += text.split(edit.old_string).length - 1;
      text = text.split(edit.old_string).join(edit.new_string);
    } else {
      text = text.replace(edit.old_string, edit.new_string);
      replacements += 1;
    }
  }
  return { text, replacements };
}

function comparable(nodes: readonly TreeNode[], skip?: string): TreeNode[] {
  return nodes
    .filter((n) => n.kind !== "dir" && n.path !== skip)
    .map((n) => {
      const { mtime_secs: _ignored, ...rest } = n;
      return rest;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function expectEditShape(c: EditCase, got: Outcome, after: TreeNode[]): void {
  const where = c.name;
  const path = c.input.path as string;
  const wholeFile = typeof c.input.content === "string" && c.input.edits === undefined;
  const targeted = Array.isArray(c.input.edits) && c.input.edits.length > 0;

  if ("err" in got) {
    expect(comparable(after), `${where}: a refused edit writes nothing`).toEqual(comparable(c.tree));
    const marker = "Current file contents:\n";
    if (!got.err.includes(marker)) {
      expect(got.err, `${where}: the refusal it gave`).toBe((c.result as { err: string }).err);
      return;
    }
    const body = got.err.slice(got.err.indexOf(marker) + marker.length);
    const onDisk = required(c.tree.find((n) => n.path === path)?.content);
    const truncated = body.endsWith("\n... (truncated)");
    expect(
      truncated ? body.slice(0, -"\n... (truncated)".length) : body,
      `${where}: a failed match quotes the file, cut to ${NO_MATCH_EXCERPT_CHARS} characters`,
    ).toBe(truncated ? Array.from(onDisk).slice(0, NO_MATCH_EXCERPT_CHARS).join("") : onDisk);
    expect(truncated, `${where}: and says so only when there was more`).toBe(
      Array.from(onDisk).length > NO_MATCH_EXCERPT_CHARS,
    );
    return;
  }

  const written = required(after.find((n) => n.path === path));
  expect(comparable(after, path), `${where}: no other file is touched`).toEqual(
    comparable(c.tree, path),
  );

  if (wholeFile) {
    expect(written.content, `${where}: the file now holds what was passed`).toBe(
      c.input.content as string,
    );
    expect(got.ok, `${where}: and it reports the path and the bytes it wrote`).toEqual({
      path,
      bytes_written: Buffer.byteLength(c.input.content as string),
    });
    return;
  }

  expect(targeted, `${where}: an edit is either a whole file or a list of replacements`).toBe(true);
  const before = required(c.tree.find((n) => n.path === path)?.content);
  const applied = applyEdits(
    before,
    c.input.edits as { old_string: string; new_string: string; replace_all?: unknown }[],
  );
  expect(written.content, `${where}: each replacement is applied in turn`).toBe(applied.text);
  expect(got.ok, `${where}: and it reports how many it made`).toEqual({
    path,
    replacements_made: applied.replacements,
  });
}

describe("edit", () => {
  for (const c of fixture.edit) {
    test(c.name, async () => {
      const { workspace } = await makeCase(c.tree);
      const before = await snapshot(workspace);
      const got = await outcome(() => handleEdit(c.input, workspace));
      const after = await snapshot(workspace);
      expectEditShape(c, got, after);

      const written = "ok" in got ? (got.ok as { path?: string }).path : undefined;
      const touched = changedPaths(before, after);
      if (written === undefined) {
        expect(touched, "a refused edit leaves the workspace alone").toEqual([]);
      } else {
        const onTheWay = (p: string) => written.startsWith(`${p}/`);
        expect(
          touched.filter((p) => p !== written && !onTheWay(p)),
          "an edit writes the path it reports, and only the directories leading to it",
        ).toEqual([]);
      }
    });
  }

  test("memory file limits use the three configured tiers", () => {
    expect(memoryFileLimitFor("memory/wrestling.md")?.bytes).toBe(8 * 1024);
    expect(memoryFileLimitFor("workspace/MEMORY.md")?.bytes).toBe(16 * 1024);
    expect(memoryFileLimitFor("SOUL.md")?.bytes).toBe(64 * 1024);
    expect(memoryFileLimitFor("notes.md")).toBeUndefined();
    expect(DEFAULT_MEMORY_FILE_LIMITS).toEqual({
      maxNoteBytes: 8 * 1024,
      maxIndexBytes: 16 * 1024,
      maxPromptBytes: 64 * 1024,
    });
  });

  test("an oversized memory note is rejected before it is written", async () => {
    const { workspace } = await makeCase([]);
    const limits = { maxNoteBytes: 8, maxIndexBytes: 16, maxPromptBytes: 64 };

    expect(handleEdit({ path: "memory/wrestling.md", content: "123456789" }, workspace, limits))
      .rejects.toThrow(
        "memory/wrestling.md would be 9 bytes, exceeding the 8 bytes limit for an individual memory note",
      );
    expect(await snapshot(workspace)).toEqual([]);
  });

  test("the larger prompt-file tier does not constrain unrelated workspace files", async () => {
    const { workspace } = await makeCase([]);
    const limits = { maxNoteBytes: 4, maxIndexBytes: 8, maxPromptBytes: 12 };

    expect(handleEdit({ path: "SOUL.md", content: "123456789012" }, workspace, limits))
      .resolves.toEqual({ path: "SOUL.md", bytes_written: 12 });
    expect(handleEdit({ path: "notes.md", content: "x".repeat(100) }, workspace, limits))
      .resolves.toEqual({ path: "notes.md", bytes_written: 100 });
  });

  test("targeted edits cannot push a memory note over its limit", async () => {
    const { workspace } = await makeCase([
      { path: "memory/topic.md", kind: "file", content: "1234567" },
    ]);
    const limits = { maxNoteBytes: 8, maxIndexBytes: 16, maxPromptBytes: 64 };

    expect(
      handleEdit(
        {
          path: "memory/topic.md",
          edits: [{ old_string: "7", new_string: "789" }],
        },
        workspace,
        limits,
      ),
    ).rejects.toThrow("would be 9 bytes");
    expect(await readFile(join(workspace, "memory/topic.md"), "utf8")).toBe("1234567");
  });

  test("an existing oversized note can be repaired in steps", async () => {
    const { workspace } = await makeCase([
      { path: "memory/topic.md", kind: "file", content: "123456789012" },
    ]);
    const limits = { maxNoteBytes: 8, maxIndexBytes: 16, maxPromptBytes: 64 };

    expect(
      handleEdit(
        {
          path: "memory/topic.md",
          edits: [{ old_string: "9012", new_string: "90" }],
        },
        workspace,
        limits,
      ),
    ).resolves.toEqual({ path: "memory/topic.md", replacements_made: 1 });
    expect(await readFile(join(workspace, "memory/topic.md"), "utf8")).toBe("1234567890");

    expect(
      handleEdit(
        {
          path: "memory/topic.md",
          edits: [{ old_string: "90", new_string: "ab" }],
        },
        workspace,
        limits,
      ),
    ).rejects.toThrow("Existing over-limit files may still be edited when the result is strictly smaller");
  });

  test("targeted edits to binary memory files are exempt", async () => {
    const { workspace } = await makeCase([
      { path: "memory/image.bin", kind: "file", bytes: [255, 97] },
    ]);
    const limits = { maxNoteBytes: 1, maxIndexBytes: 1, maxPromptBytes: 1 };

    expect(
      handleEdit(
        {
          path: "memory/image.bin",
          edits: [{ old_string: "a", new_string: "binary payload" }],
        },
        workspace,
        limits,
      ),
    ).resolves.toEqual({ path: "memory/image.bin", replacements_made: 1 });
  });

  test("whole-file writes containing binary data are exempt", async () => {
    const { workspace } = await makeCase([]);
    const limits = { maxNoteBytes: 1, maxIndexBytes: 1, maxPromptBytes: 1 };

    expect(
      handleEdit({ path: "memory/image.bin", content: "\0binary payload" }, workspace, limits),
    ).resolves.toEqual({ path: "memory/image.bin", bytes_written: 15 });
  });
});

describe("delete", () => {
  for (const c of fixture.delete) {
    test(c.name, async () => {
      const { workspace, data } = await makeCase(c.tree);
      const dataDir = c.with_data_dir ? data : "";
      const got = await outcome(() => handleDelete(c.input, workspace, dataDir));
      const after = await snapshot(workspace);
      const trash = await snapshotTrash(data, c.with_data_dir);

      if ("err" in got) {
        expect(got, c.name).toEqual(required(c.result) as { err: string });
        expect(comparable(after), `${c.name}: a refused delete leaves everything`).toEqual(
          comparable(c.tree),
        );
        expect(trash, `${c.name}: and puts nothing in the trash`).toEqual([]);
        return;
      }

      const path = c.input.path as string;
      const stamps = await readdir(join(data, "trash"));
      expect(stamps, `${c.name}: one delete makes one trash folder`).toHaveLength(1);
      expect(required(stamps[0]), `${c.name}: named for the moment it happened`).toMatch(STAMP);
      expect(got.ok, `${c.name}: it says what it moved, and where`).toEqual({
        path,
        deleted: true,
        trashed_to: `data/trash/${required(stamps[0])}/${path}`,
      });
      expect(comparable(after), `${c.name}: the file is gone and nothing else is`).toEqual(
        comparable(c.tree, path),
      );
      expect(
        trash.filter((n) => n.kind !== "dir"),
        `${c.name}: and is in the trash under the same relative path`,
      ).toEqual([{ ...required(comparable(c.tree).find((n) => n.path === path)), path: `{stamp}/${path}` }]);
    });
  }

  test("stamp format", () => {
    for (const { millis, stamp } of fixture.trash_stamp) {
      expect(trashStamp(new Date(millis))).toBe(stamp);
    }
  });

  test("stamp is UTC regardless of the host zone", () => {
    const source = new URL("../src/tools/workspace", import.meta.url).pathname;
    const millis = fixture.trash_stamp.map((t) => t.millis);
    const probe = `
      import { trashStamp } from ${JSON.stringify(source)};
      console.log(JSON.stringify(${JSON.stringify(millis)}.map((m) => trashStamp(new Date(m)))));
    `;
    const run = Bun.spawnSync(["bun", "-e", probe], {
      env: { ...process.env, TZ: "Asia/Shanghai" },
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual(fixture.trash_stamp.map((t) => t.stamp));
  });
});

const STAMP = /\d{8}T\d{9}Z/;

function replaceStampInPath(path: string, replacement: string): string {
  return path.replace(STAMP, replacement);
}

async function snapshotTrash(dataDir: string, withDataDir: boolean): Promise<TreeNode[]> {
  if (!withDataDir) return [];
  const nodes = await snapshot(join(dataDir, "trash"));
  return nodes.map((n) => ({ ...n, path: replaceStampInPath(n.path, "{stamp}") }));
}

const SEARCH_DEFAULT_RESULTS = 20;
const SEARCH_RESULT_CAP = 100;

const SEARCH_NOTE =
  "These are line-level excerpts, ordered by file recency. Call `read` on the top file paths " +
  "to see surrounding context \u2014 excerpts almost never contain the full answer, and one file " +
  "often references others worth reading too.";

function searchableFiles(c: SearchCase): TreeNode[] {
  const cap = c.max_file_bytes ?? DEFAULT_RETRIEVAL_CONFIG.maxFileBytes;
  const scope = typeof c.input.path === "string" ? c.input.path : undefined;
  const inScope = (path: string): boolean => {
    if (scope === undefined || scope === "." || scope === "") return true;
    return path === scope || path.startsWith(`${scope}/`);
  };
  return c.tree.filter(
    (n) =>
      n.kind === "file" &&
      n.content !== undefined &&
      inScope(n.path) &&
      !n.path.split("/").includes(".git") &&
      Buffer.byteLength(n.content) <= cap,
  );
}

function expectedHits(c: SearchCase): { path: string; line: number; excerpt: string }[] {
  const query = String(c.input.query).trim().toLowerCase();
  const files = [...searchableFiles(c)].sort((a, b) => {
    const byTime = required(b.mtime_secs) - required(a.mtime_secs);
    return byTime !== 0 ? byTime : compareRustStrings(a.path, b.path);
  });

  const hits: { path: string; line: number; excerpt: string }[] = [];
  for (const file of files) {
    rustLines(required(file.content)).forEach((line, i) => {
      const match = findCaseInsensitiveMatch(line, query);
      if (match === undefined) return;
      hits.push({ path: file.path, line: i + 1, excerpt: excerptLine(line, match[0], match[1]) });
    });
  }
  return hits;
}

function expectSearchShape(c: SearchCase, ok: Record<string, unknown>): void {
  const where = c.name;
  const requested = c.input.max_results;
  const limit = Math.min(
    Math.max(typeof requested === "number" ? requested : SEARCH_DEFAULT_RESULTS, 1),
    SEARCH_RESULT_CAP,
  );

  expect(ok.query, `${where}: it echoes the query, trimmed`).toBe(String(c.input.query).trim());
  expect(ok.mode, `${where}: without an embedder every search is lexical`).toBe("lexical");
  expect(
    "semantic_unavailable" in ok,
    `${where}: asking for semantics you cannot have is said out loud`,
  ).toBe((c.input.mode ?? "hybrid") !== "lexical");

  const results = ok.results as { path: string; line: number; excerpt: string }[];
  const wanted = expectedHits(c);
  expect(results, `${where}: every matching line, newest file first, up to the limit`).toEqual(
    wanted.slice(0, limit),
  );
  expect(ok.count, `${where}: the count is how many came back`).toBe(results.length);

  if (results.length === 0) {
    expect("files" in ok, `${where}: nothing matched, so no file summary`).toBe(false);
    const scope = typeof c.input.path === "string" ? c.input.path : undefined;
    const exists =
      scope === undefined ||
      scope === "." ||
      c.tree.some((n) => n.path === scope || n.path.startsWith(`${scope}/`));
    expect(
      ok.note,
      `${where}: a path that is not there is worth saying; an empty result is not`,
    ).toBe(exists ? undefined : "path does not exist");
    return;
  }

  const hitsByPath = new Map<string, number>();
  for (const hit of results) hitsByPath.set(hit.path, (hitsByPath.get(hit.path) ?? 0) + 1);
  expect(ok.files, `${where}: the summary counts the hits per file, in the order they came`).toEqual(
    [...hitsByPath].map(([path, hits]) => ({ path, hits })),
  );
  expect(ok.note, `${where}: and says these are excerpts, not answers`).toBe(SEARCH_NOTE);
}

describe("search", () => {
  for (const c of fixture.search) {
    test(c.name, async () => {
      const { workspace } = await makeCase(c.tree);
      const ws = c.workspace_unset === true ? "" : workspace;
      const config =
        c.max_file_bytes === null
          ? undefined
          : { ...DEFAULT_RETRIEVAL_CONFIG, maxFileBytes: c.max_file_bytes };
      const got = await outcome(() => handleSearch(c.input, ws, config, undefined));

      if (c.result !== undefined) {
        expect(got).toEqual(c.result);
        return;
      }
      expect(got, c.name).toHaveProperty("ok");
      const ok = (got as { ok: Record<string, unknown> }).ok;
      expect(ok.searched_files, `${c.name}: how many files it read`).toBe(c.searched_files);
      expect(ok.skipped_binary_or_large, `${c.name}: and how many it could not`).toBe(
        c.skipped_binary_or_large,
      );
      expectSearchShape(c, ok);
    });
  }
});

describe("excerpting the line a match was found on", () => {
  const CHARS = SEARCH_EXCERPT_CHARS;
  const chars = (t: string) => Array.from(t).length;
  const excerptOf = (line: string, query: string) => {
    const match = findCaseInsensitiveMatch(line, query);
    expect(match, `no match for ${JSON.stringify(query)}`).toBeDefined();
    return excerptLine(line, required(match)[0], required(match)[1]);
  };

  test("a line that already fits comes back whole, with no ellipsis", () => {
    expect(excerptOf("the tea is hot", "tea")).toBe("the tea is hot");
  });

  test("leading and trailing whitespace is dropped, since it is not context", () => {
    expect(excerptOf("     the tea is hot   ", "tea")).toBe("the tea is hot");
  });

  test("the match is always inside what comes back", () => {
    for (const pad of [0, 10, CHARS, CHARS * 3]) {
      const line = `${"a".repeat(pad)} tea ${"b".repeat(pad)}`;
      expect(excerptOf(line, "tea"), `pad ${pad}`).toContain("tea");
    }
  });

  test("what comes back stays within the window, plus its ellipses", () => {
    for (const pad of [0, 50, CHARS, CHARS * 5]) {
      const line = `${"a".repeat(pad)} tea ${"b".repeat(pad)}`;
      expect(chars(excerptOf(line, "tea")), `pad ${pad}`).toBeLessThanOrEqual(CHARS * 2 + 3 + 6);
    }
  });

  test("a truncated side is marked, and an untruncated one is not", () => {
    const long = "x".repeat(CHARS * 2);
    expect(excerptOf(`tea ${long}`, "tea").startsWith("...")).toBe(false);
    expect(excerptOf(`tea ${long}`, "tea").endsWith("...")).toBe(true);
    expect(excerptOf(`${long} tea`, "tea").startsWith("...")).toBe(true);
    expect(excerptOf(`${long} tea`, "tea").endsWith("...")).toBe(false);
    const both = excerptOf(`${long} tea ${long}`, "tea");
    expect(both.startsWith("...") && both.endsWith("...")).toBe(true);
  });

  test("context stays within the requested distance on each side", () => {
    const long = "x".repeat(CHARS * 2);
    const trailingOnly = excerptOf(`tea ${long}`, "tea");
    const bothSides = excerptOf(`${long} tea ${long}`, "tea");
    expect(chars(trailingOnly)).toBeLessThan(chars(bothSides));
  });

  test("a match longer than the window is preserved in full", () => {
    const huge = "t".repeat(CHARS * 2);
    expect(excerptOf(`before ${huge} after`, huge)).toContain(huge);
  });

  test("counting is by character, so multibyte text is not cut short", () => {
    for (const filler of ["\u4E16", "\u{1F600}", "e\u0301"]) {
      const line = `${filler.repeat(CHARS)} tea ${filler.repeat(CHARS)}`;
      const got = excerptOf(line, "tea");
      expect(got, filler).toContain("tea");
      expect(got, filler).not.toContain("\uFFFD");
      expect(chars(got), filler).toBeLessThanOrEqual(CHARS * 2 + 3 + 6);
    }
  });

  test("the line is folded before matching, so any casing in it is found", () => {
    for (const line of ["The TEA is hot", "the tea is hot", "The Tea Is Hot"]) {
      expect(excerptOf(line, "tea").toLowerCase(), line).toContain("tea");
    }
  });

  test("the query is taken already folded, so an unfolded one finds nothing", () => {
    expect(findCaseInsensitiveMatch("the tea is hot", "TEA")).toBeUndefined();
  });

  test("a query that is not there matches nothing", () => {
    for (const query of ["coffee", ""]) {
      const match = findCaseInsensitiveMatch("the tea is hot", query);
      if (query === "") continue;
      expect(match, query).toBeUndefined();
    }
  });
});

describe("best line excerpt", () => {
  for (const c of fixture.best_line) {
    test(c.name, () => {
      expect(bestLineExcerpt(c.content, c.query_lower)).toEqual([c.line, c.excerpt]);
    });
  }
});

describe("git execution", () => {
  test("shortlog without a revision reaches EOF instead of waiting for stdin", async () => {
    const workspace = mkdtempSync(testTmp("shortlog-"));
    await handleGit({ subcommand: "commit", args: ["--allow-empty", "-m", "initial"] }, workspace, "Ada");
    expect(await handleGit({ subcommand: "shortlog", args: ["-sn", "--since=2 days ago"] }, workspace, "Ada")).toMatchObject({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    const history = await handleGit({ subcommand: "shortlog", args: ["-sn", "--since=2 days ago", "HEAD"] }, workspace, "Ada");
    expect(history).toMatchObject({ exit_code: 0 });
    expect((history as { stdout: string }).stdout).toContain("Ada");
  }, 5_000);
});

describe("git validation", () => {
  test("safety flags", () => {
    expect([...GIT_SAFETY_FLAGS]).toEqual(fixture.git_validation.safety_flags);
  });

  for (const c of fixture.git_validation.subcommand) {
    test(`subcommand: git ${c.sub.join(" ")}`, () => {
      expect(syncOutcome(() => validateGitSubcommand(c.sub))).toEqual(c.result);
    });
  }

  for (const c of fixture.git_validation.token) {
    test(`token: ${JSON.stringify(c.token)}`, () => {
      expect(syncOutcome(() => validateGitSubcommandToken(c.token))).toEqual(c.result);
    });
  }

  for (const c of fixture.git_validation.path_like) {
    test(`path-like: ${JSON.stringify(c.arg)}`, () => {
      expect(isPathLikeArg(c.arg)).toBe(c.path_like);
    });
  }

  for (const c of fixture.git_validation.checkout_pathspec) {
    test(`checkout pathspec: ${JSON.stringify(c.rest)}`, () => {
      expect(checkoutTargetsAPathspec(c.rest)).toBe(c.pathspec);
    });
  }

  for (const c of fixture.git_validation.args) {
    test(`args: ${JSON.stringify(c.args)}`, async () => {
      const { workspace } = await makeCase(fixture.git_validation.tree);
      expect(syncOutcome(() => validateGitArgs(workspace, c.args))).toEqual(c.result);
    });
  }

  test("args with no workspace", () => {
    expect(syncOutcome(() => validateGitArgs("", ["notes.md"]))).toEqual(
      fixture.git_validation.args_workspace_unset,
    );
  });
});

describe("git identity", () => {
  for (const c of fixture.git_identity) {
    test(`identity: ${JSON.stringify(c.character)}`, () => {
      expect(characterGitIdentity(c.character)).toEqual([c.name, c.email]);
    });
  }
});
