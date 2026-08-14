import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readdir, readlink, lstat, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bestLineExcerpt,
  characterGitIdentity,
  checkoutTargetsAPathspec,
  excerptLine,
  findCaseInsensitiveMatch,
  GIT_SAFETY_FLAGS,
  handleDelete,
  handleEdit,
  handleRead,
  handleSearch,
  isPathLikeArg,
  trashStamp,
  validateGitArgs,
  validateGitSubcommand,
  validateGitSubcommandToken,
  DEFAULT_RETRIEVAL_CONFIG,
  type ToolInput,
} from "../src/tools/workspace";
import { testTmp } from "./support/tmp.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./tools_fixtures/workspace_tools.json", import.meta.url), "utf8"),
) as Fixture;

interface Fixture {
  read: ReadCase[];
  edit: EditCase[];
  delete: DeleteCase[];
  trash_stamp: { millis: number; stamp: string }[];
  search: SearchCase[];
  excerpt: { name: string; line: string; query: string; matched: boolean; excerpt: string | null }[];
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

interface EditCase extends ReadCase {
  after: TreeNode[];
}

interface DeleteCase {
  name: string;
  tree: TreeNode[];
  input: ToolInput;
  with_data_dir: boolean;
  result: Outcome;
  after: TreeNode[];
  trash: TreeNode[];
}

interface SearchCase extends ReadCase {
  max_file_bytes: number | null;
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
      await symlink(node.target!, path);
      continue;
    }
    await writeFile(path, node.bytes !== undefined ? Buffer.from(node.bytes) : node.content!);
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
    const dir = pending.pop()!;
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

const READ_DIVERGES_FROM_RUST = new Map([
  ["memory prefix directory", "invalid args: path is empty"],
  ["workspace prefix root", "invalid args: path is empty"],
]);

describe("read", () => {
  for (const c of fixture.read) {
    test(c.name, async () => {
      const { workspace } = await makeCase(c.tree, c.workspace_missing === true);
      const ws = c.workspace_unset === true ? "" : workspace;
      const got = blankDirectorySizes(await outcome(() => handleRead(c.input, ws)));

      const rustError = READ_DIVERGES_FROM_RUST.get(c.name);
      if (rustError !== undefined) {
        expect(c.result).toEqual({ err: rustError });
        const viaDot = await outcome(() => handleRead({ path: `${String(c.input.path)}/.` }, ws));
        expect(got).toEqual(blankDirectorySizes(viaDot));
        return;
      }

      expect(got).toEqual(blankDirectorySizes(c.result));
    });
  }

  test("directory size is the filesystem's", async () => {
    const { workspace } = await makeCase([
      { path: "sub", kind: "dir" },
      { path: "sub/deep.md", kind: "file", content: "deep file" },
    ]);
    const listing = (await handleRead({}, workspace)) as { entries: { name: string; size: number }[] };
    const sub = listing.entries.find((e) => e.name === "sub");
    expect(sub?.size).toBe((await lstat(join(workspace, "sub"))).size);
  });
});

function blankDirectorySizes(o: Outcome): Outcome {
  if (!("ok" in o)) return o;
  const ok = o.ok as Record<string, unknown> | null;
  if (ok === null || typeof ok !== "object" || !Array.isArray(ok.entries)) return o;
  const entries = (ok.entries as Record<string, unknown>[]).map((e) =>
    e.type === "directory" ? { ...e, size: null } : e,
  );
  return { ok: { ...ok, entries } };
}

describe("edit", () => {
  for (const c of fixture.edit) {
    test(c.name, async () => {
      const { workspace } = await makeCase(c.tree);
      expect(await outcome(() => handleEdit(c.input, workspace))).toEqual(c.result);
      expect(await snapshot(workspace)).toEqual(c.after);
    });
  }
});

describe("delete", () => {
  for (const c of fixture.delete) {
    test(c.name, async () => {
      const { workspace, data } = await makeCase(c.tree);
      const dataDir = c.with_data_dir ? data : "";
      const got = await outcome(() => handleDelete(c.input, workspace, dataDir));

      const expected = await substituteStamp(c.result, data);
      expect(got).toEqual(expected);

      expect(await snapshot(workspace)).toEqual(c.after);
      expect(await snapshotTrash(data, c.with_data_dir)).toEqual(
        c.trash.map((n) => ({ ...n, path: replaceStampInPath(n.path, "{stamp}") })),
      );
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

async function substituteStamp(expected: Outcome, dataDir: string): Promise<Outcome> {
  if (!("ok" in expected)) return expected;
  const ok = expected.ok as Record<string, unknown> | null;
  if (ok === null || typeof ok !== "object" || typeof ok.trashed_to !== "string") return expected;

  const stamps = await readdir(join(dataDir, "trash"));
  expect(stamps).toHaveLength(1);
  expect(stamps[0]).toMatch(new RegExp(`^${STAMP.source}$`));

  return { ok: { ...ok, trashed_to: ok.trashed_to.replace(STAMP, stamps[0]!) } };
}

async function snapshotTrash(dataDir: string, withDataDir: boolean): Promise<TreeNode[]> {
  if (!withDataDir) return [];
  const nodes = await snapshot(join(dataDir, "trash"));
  return nodes.map((n) => ({ ...n, path: replaceStampInPath(n.path, "{stamp}") }));
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
      expect(await outcome(() => handleSearch(c.input, ws, config, undefined))).toEqual(c.result);
    });
  }
});

describe("excerpt", () => {
  for (const c of fixture.excerpt) {
    test(c.name, () => {
      const match = findCaseInsensitiveMatch(c.line, c.query);
      expect(match !== undefined).toBe(c.matched);
      expect(match === undefined ? null : excerptLine(c.line, match[0], match[1])).toEqual(
        c.excerpt,
      );
    });
  }
});

describe("best line excerpt", () => {
  for (const c of fixture.best_line) {
    test(c.name, () => {
      expect(bestLineExcerpt(c.content, c.query_lower)).toEqual([c.line, c.excerpt]);
    });
  }
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
