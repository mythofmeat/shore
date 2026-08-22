import { required } from "../src/util/required.ts";

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
import { truncateChars } from "../src/memory/markdown_query";
import { expandShared } from "./support/shared_subtrees.ts";

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

const fixture = expandShared(
  JSON.parse(
    readFileSync(join(import.meta.dir, "memory_captures/memory_markdown.json"), "utf8"),
  ),
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

const RFC3339_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;

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

function expectSameError(actual: unknown, recorded: string, root: string, oldRoot: string) {
  const message = (actual as Error).message;
  if (recorded.startsWith("io: ")) {
    expect(message.startsWith("io: ")).toBe(true);
    return;
  }
  expect(message).toBe(recorded.split(oldRoot).join(root));
}

describe("reading and writing the markdown store", () => {
  test("the modified-at format matches chrono's AutoSi, truncated to milliseconds", () => {
    const originalTz = process.env.TZ;
    try {
      for (const group of fixture.modified_at_format) {
        process.env.TZ = group.tz;
        expect(-new Date().getTimezoneOffset() + 0).toBe(group.utc_offset_minutes);

        for (const stamp of group.stamps) {
          const ms = Math.floor(stamp.nanos / 1e6);
          const truncated = stamp.formatted.replace(
            /\.\d+/,
            ms === 0 ? "" : `.${String(ms).padStart(3, "0")}`,
          );
          expect(formatModifiedAt(new Date(stamp.unix_secs * 1000 + ms))).toBe(truncated);
        }

        expect(required(group.stamps[0]).formatted).not.toContain(".");
      }
    } finally {
      process.env.TZ = originalTz ?? "UTC";
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
              returned = entryJson(await store.read(required(c.op.path)));
              break;
            case "write":
              await store.write(required(c.op.path), b64(required(c.op.content)));
              break;
            case "delete":
              await store.delete(required(c.op.path));
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

describe("querying the markdown store", () => {
  for (const c of fixture.pure_cases) {
    test(c.name, () => {
      switch (c.op.fn) {
        case "truncate_chars":
          expect(truncateChars(b64(required(c.op.text)), required(c.op.limit))).toBe(c.returns);
          break;
        default:
          throw new Error(`unhandled pure op ${c.op.fn}`);
      }
    });
  }
});

async function mkdtempReal(): Promise<string> {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  return await realpath(await mkdtemp(join(tmpdir(), "markdown-store-")));
}

const entryJson = (e: MarkdownEntry) => ({
  path: e.path,
  content: Buffer.from(e.content, "utf8").toString("base64"),
  size: e.size,
  modified_at: e.modifiedAt,
});

const entriesJson = (list: MarkdownEntry[]) => list.map(entryJson);

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
    expectEntryMatch(required(actual[i]), c.returns[i] as ReturnedEntry, c);
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

  expect(expected.modified_at).toMatch(RFC3339_LOCAL);
  expect(actual.modified_at).toMatch(RFC3339_LOCAL);
  expect(Number.isNaN(Date.parse(actual.modified_at))).toBe(false);
}
