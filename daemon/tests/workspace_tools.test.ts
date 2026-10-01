import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { bestLineExcerpt, characterGitIdentity, excerptLine, findCaseInsensitiveMatch, GIT_HISTORY_HINT, SEARCH_EXCERPT_CHARS, handleSearch, DEFAULT_RETRIEVAL_CONFIG, type ToolInput } from "../src/tools/workspace";
import { testTmp } from "./support/tmp.ts";
import { compareRustStrings, rustLines } from "../src/memory/lines";
import { expandShared } from "./support/shared_subtrees.ts";


const fixture = expandShared<Fixture>(
  JSON.parse(
  readFileSync(new URL("./tools_captures/workspace_tools.json", import.meta.url), "utf8"),
  ),
);

interface Fixture {
  search: SearchCase[];
  best_line: { name: string; content: string; query_lower: string; line: number; excerpt: string }[];
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

interface WorkspaceCase {
  name: string;
  tree: TreeNode[];
  input: ToolInput;
  result: Outcome;
  workspace_unset?: boolean;
  workspace_missing?: boolean;
}

interface SearchCase extends Omit<WorkspaceCase, "result"> {
  max_file_bytes: number | null;
  result?: Outcome;
  searched_files?: number;
  skipped_binary_or_large?: number;
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

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await run() };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
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
      `${where}: a path that is not there is worth saying; an empty result points at git history`,
    ).toBe(exists ? GIT_HISTORY_HINT : "path does not exist");
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

describe("git identity", () => {
  for (const c of fixture.git_identity) {
    test(`identity: ${JSON.stringify(c.character)}`, () => {
      expect(characterGitIdentity(c.character)).toEqual([c.name, c.email]);
    });
  }
});
