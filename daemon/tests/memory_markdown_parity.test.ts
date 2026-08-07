/**
 * Replays `memory_fixtures/markdown_parity.json` against the TypeScript
 * markdown memory store and its query helpers.
 *
 * Every expected value is what the real Rust in
 * `crates/daemon/src/memory/markdown_store.rs` and `markdown_query.rs`
 * returned, or left on disk, in a throwaway worktree at `9023b46d`. Nothing
 * here asserts against a hand-written expectation.
 *
 * The whole directory tree is compared after each call — including empty
 * directories and symlink targets — because several of these operations are
 * defined by what they *didn't* touch: a refused traversal must leave the file
 * outside the store intact, and `delete`'s parent prune is only visible as a
 * directory that stopped existing.
 *
 * Three values cannot be pinned byte for byte and are handled explicitly
 * rather than waved through:
 *
 * - `modified_at` is a wall-clock mtime. Compared by shape and by round trip,
 *   with the fractional-second rule pinned separately against a table of fixed
 *   instants the generator recorded.
 * - `io:` error text comes from the OS via two different runtimes, so only the
 *   variant prefix is compared. Which variant a case produces is the point —
 *   `write` over a directory failing as `io` rather than `path traversal` is a
 *   real assertion.
 * - The tmp root appears inside traversal messages and symlink targets. The
 *   generator recorded its own root so the replay can substitute its own in.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  MarkdownMemoryStore,
  formatModifiedAt,
  type MarkdownEntry,
} from "../src/memory/markdown_store";
import {
  excerptForQuery,
  formatDirectResponse,
  memoryStatus,
  truncateChars,
} from "../src/memory/markdown_query";

type Node =
  | { kind: "dir" }
  | { kind: "file"; content: string }
  | { kind: "symlink"; target: string };

interface StoreCase {
  name: string;
  root: string;
  op: { fn: string; path?: string; content?: string; query?: string };
  before: Record<string, Node>;
  after: Record<string, Node>;
  returns: unknown;
  err: string | null;
}

interface PureCase {
  name: string;
  op: {
    fn: string;
    text?: string;
    query?: string;
    limit?: number;
    hits?: Array<{ path: string; content: string }>;
  };
  returns: string;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "memory_fixtures/markdown_parity.json"), "utf8"),
) as {
  constants: { max_direct_hits: number };
  modified_at_format: Array<{
    tz: string;
    utc_offset_minutes: number;
    stamps: Array<{ label: string; unix_secs: number; nanos: number; formatted: string }>;
  }>;
  store_cases: StoreCase[];
  pure_cases: PureCase[];
};

const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** RFC 3339 with a numeric offset, the fraction optional — chrono's `AutoSi`. */
const RFC3339_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;

/** Recreate a recorded tree under `root`, rewriting the generator's root. */
async function seed(root: string, before: Record<string, Node>, oldRoot: string) {
  const rewrite = (p: string) => join(root, relative(oldRoot, p));
  for (const [rel, node] of Object.entries(before)) {
    if (node.kind !== "dir") continue;
    await mkdir(join(root, rel), { recursive: true });
  }
  for (const [rel, node] of Object.entries(before)) {
    if (node.kind !== "file") continue;
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, b64(node.content), "utf8");
  }
  for (const [rel, node] of Object.entries(before)) {
    if (node.kind !== "symlink") continue;
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await symlink(rewrite(node.target), p);
  }
}

/** The same shape the generator's `snapshot` recorded. */
async function snapshot(root: string): Promise<Record<string, Node>> {
  const out: Record<string, Node> = {};
  async function walk(cur: string): Promise<void> {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const p = join(cur, entry.name);
      const rel = relative(root, p).split("\\").join("/");
      if ((await lstat(p)).isSymbolicLink()) {
        out[rel] = { kind: "symlink", target: await readlink(p) };
        continue;
      }
      if (entry.isDirectory()) {
        out[rel] = { kind: "dir" };
        await walk(p);
      } else {
        out[rel] = { kind: "file", content: await readFile(p, "utf8") };
      }
    }
  }
  await walk(root);
  return out;
}

/** The recorded tree with contents decoded and the generator's root swapped. */
function expectedTree(
  after: Record<string, Node>,
  root: string,
  oldRoot: string,
): Record<string, Node> {
  const out: Record<string, Node> = {};
  for (const [rel, node] of Object.entries(after)) {
    if (node.kind === "file") out[rel] = { kind: "file", content: b64(node.content) };
    else if (node.kind === "symlink") {
      out[rel] = { kind: "symlink", target: join(root, relative(oldRoot, node.target)) };
    } else out[rel] = node;
  }
  return out;
}

/**
 * Compare a thrown error to the recorded one.
 *
 * `io:` messages carry OS strings that Rust and Node word differently, so only
 * the variant survives; everything else is compared in full, because the
 * traversal messages are the only way a caller tells a refusal from a miss.
 */
function expectSameError(actual: unknown, recorded: string, root: string, oldRoot: string) {
  const message = (actual as Error).message;
  if (recorded.startsWith("io: ")) {
    expect(message.startsWith("io: ")).toBe(true);
    return;
  }
  expect(message).toBe(recorded.split(oldRoot).join(root));
}

describe("markdown store parity", () => {
  /**
   * The generator was run three times under different `TZ` values, because
   * `modified_at` is rendered in local time and a UTC-only table would leave
   * the offset field — sign, hours and minutes alike — completely unpinned.
   * Kolkata is in there for the half hour; nothing else exercises the minutes.
   *
   * `Date` re-reads `TZ` on every call, so the replay can walk the same zones
   * in one process.
   */
  test("the modified-at format matches chrono's AutoSi, truncated to milliseconds", () => {
    const originalTz = process.env.TZ;
    try {
      for (const group of fixture.modified_at_format) {
        process.env.TZ = group.tz;
        expect(-new Date().getTimezoneOffset() + 0).toBe(group.utc_offset_minutes);

        for (const stamp of group.stamps) {
          const ms = Math.floor(stamp.nanos / 1e6);
          // What chrono printed, minus the sub-millisecond digits JavaScript's
          // `Date` cannot represent — and with the fraction dropped entirely
          // when nothing is left of it, which is the rule a hand-written port
          // misses by always printing three digits.
          const truncated = stamp.formatted.replace(
            /\.\d+/,
            ms === 0 ? "" : `.${String(ms).padStart(3, "0")}`,
          );
          expect(formatModifiedAt(new Date(stamp.unix_secs * 1000 + ms))).toBe(truncated);
        }

        // The whole-second row must carry no fractional part at all.
        expect(group.stamps[0]!.formatted).not.toContain(".");
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  for (const c of fixture.store_cases) {
    test(c.name, async () => {
      const root = await mkdtempReal();
      try {
        await seed(root, c.before, c.root);
        const base = join(root, "memories");

        let returned: unknown = null;
        let threw: unknown;
        try {
          const store = await MarkdownMemoryStore.open(base);
          switch (c.op.fn) {
            case "list_all":
              returned = entriesJson(await store.listAll());
              break;
            case "read":
              returned = entryJson(await store.read(c.op.path!));
              break;
            case "write":
              await store.write(c.op.path!, b64(c.op.content!));
              break;
            case "delete":
              await store.delete(c.op.path!);
              break;
            case "search_text":
              returned = entriesJson(await store.searchText(c.op.query!));
              break;
            case "memory_status": {
              const s = await memoryStatus(store);
              returned = {
                total_files: s.totalFiles,
                topic_files: s.topicFiles,
                daily_files: s.dailyFiles,
                image_files: s.imageFiles,
              };
              break;
            }
            case "search_and_format":
              returned = formatDirectResponse(
                c.op.query!,
                await store.searchText(c.op.query!),
              );
              break;
            default:
              throw new Error(`unhandled op ${c.op.fn}`);
          }
        } catch (e) {
          threw = e;
        }

        if (c.err !== null) {
          expect(threw).toBeDefined();
          expectSameError(threw, c.err, root, c.root);
        } else {
          if (threw !== undefined) throw threw;
          expectReturnsMatch(returned, c);
        }

        expect(await snapshot(root)).toEqual(expectedTree(c.after, root, c.root));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("markdown query parity", () => {
  for (const c of fixture.pure_cases) {
    test(c.name, () => {
      switch (c.op.fn) {
        case "excerpt_for_query":
          expect(excerptForQuery(b64(c.op.text!), c.op.query!, c.op.limit!)).toBe(
            c.returns,
          );
          break;
        case "truncate_chars":
          expect(truncateChars(b64(c.op.text!), c.op.limit!)).toBe(c.returns);
          break;
        case "format_direct_response": {
          const hits: MarkdownEntry[] = c.op.hits!.map((h) => ({
            path: h.path,
            content: b64(h.content),
            size: Buffer.byteLength(b64(h.content), "utf8"),
            modifiedAt: "",
          }));
          expect(formatDirectResponse(c.op.query!, hits)).toBe(c.returns);
          break;
        }
        default:
          throw new Error(`unhandled pure op ${c.op.fn}`);
      }
    });
  }
});

// ── helpers ──────────────────────────────────────────────────────────────

async function mkdtempReal(): Promise<string> {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  // Resolved, because the store canonicalizes its base and the recorded
  // symlink targets are absolute. An unresolved `/tmp` alias would make every
  // containment check compare two different spellings of the same directory.
  return await realpath(await mkdtemp(join(tmpdir(), "markdown-store-")));
}

const entryJson = (e: MarkdownEntry) => ({
  path: e.path,
  content: Buffer.from(e.content, "utf8").toString("base64"),
  size: e.size,
  modified_at: e.modifiedAt,
});

const entriesJson = (list: MarkdownEntry[]) => list.map(entryJson);

/**
 * Compare a returned value to the recorded one, entry by entry.
 *
 * `size` is compared exactly except on a symlinked entry reached through
 * `list_all`. There the Rust read the *directory entry's* metadata, which does
 * not follow the link, and so reported the byte length of the link target's
 * path while returning the target's content. `read` stats through the link and
 * got it right, so it keeps the exact comparison. The assertion pins that the
 * difference is exactly and only that, by checking the recorded number against
 * the recorded link target.
 */
function expectReturnsMatch(returned: unknown, c: StoreCase) {
  if (!Array.isArray(c.returns)) {
    if (isEntry(c.returns)) {
      expectEntryMatch(returned as ReturnedEntry, c.returns, c);
      return;
    }
    expect(returned).toEqual(c.returns as never);
    return;
  }
  const actual = returned as ReturnedEntry[];
  expect(actual.map((e) => e.path)).toEqual(c.returns.map((e: ReturnedEntry) => e.path));
  for (let i = 0; i < c.returns.length; i += 1) {
    expectEntryMatch(actual[i]!, c.returns[i] as ReturnedEntry, c);
  }
}

interface ReturnedEntry {
  path: string;
  content: string;
  size: number;
  modified_at: string;
}

const isEntry = (v: unknown): v is ReturnedEntry =>
  typeof v === "object" && v !== null && "modified_at" in v;

function expectEntryMatch(actual: ReturnedEntry, expected: ReturnedEntry, c: StoreCase) {
  expect(actual.path).toBe(expected.path);
  expect(actual.content).toBe(expected.content);

  const link = c.before[`memories/${expected.path}`];
  if (c.op.fn === "list_all" && link !== undefined && link.kind === "symlink") {
    expect(actual.size).toBe(Buffer.byteLength(b64(actual.content), "utf8"));
    expect(expected.size).toBe(Buffer.byteLength(link.target, "utf8"));
  } else {
    expect(actual.size).toBe(expected.size);
  }

  // Wall clock on both sides: the format is asserted, the instant is not.
  expect(expected.modified_at).toMatch(RFC3339_LOCAL);
  expect(actual.modified_at).toMatch(RFC3339_LOCAL);
  expect(Number.isNaN(Date.parse(actual.modified_at))).toBe(false);
}
