import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  workspaceIndexSection,
  type WorkspaceIndexSource,
} from "../src/commands/workspace_index";
import type { WorkspaceIndexProgress } from "../src/memory/workspace_index_service";
import { WorkspaceIndexStore } from "../src/memory/workspace_store";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wsic-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stocked(name: string): string {
  const path = join(root, `${name}.db`);
  const store = WorkspaceIndexStore.open(path);
  store.putFiles([
    {
      display_path: "a.md",
      size: 10,
      modified_at_secs: 1000,
      document_hash: "ha",
      embed_chars: 4000,
      embedded: true,
      reason: undefined,
    },
    {
      display_path: "b.md",
      size: 20,
      modified_at_secs: 1000,
      document_hash: "hb",
      embed_chars: 4000,
      embedded: false,
      reason: undefined,
    },
    {
      display_path: "c.png",
      size: 30,
      modified_at_secs: 1000,
      document_hash: "",
      embed_chars: 4000,
      embedded: false,
      reason: "non-utf8",
    },
    {
      display_path: "d.bin",
      size: 40,
      modified_at_secs: 1000,
      document_hash: "",
      embed_chars: 4000,
      embedded: false,
      reason: "oversize",
    },
  ]);
  store.putEmbeddings("qwen3", [{ hash: "ha", vectors: [[1, 0]] }]);
  store.setMetadata("last_indexed_at", "2026-08-15T01:44:00.000Z");
  store.close();
  return path;
}

function sourceFor(overrides: Partial<WorkspaceIndexSource> = {}): WorkspaceIndexSource {
  return {
    indexPathFor: (c: string) => (c === "heidi" ? stocked("heidi") : undefined),
    progressFor: () => undefined,
    now: () => 1_000_000,
    ...overrides,
  };
}

const section = async (
  source: WorkspaceIndexSource | undefined = sourceFor(),
  character = "heidi",
): Promise<IndexSection | null> =>
  await workspaceIndexSection(source, character);

interface IndexSection {
  background?: {
    active?: boolean;
    embedder_error?: string;
    failures?: number;
    last_error?: string;
    registered?: boolean;
    retry_in_secs?: number;
    swept?: boolean;
  };
  bytes?: number;
  embedded?: number;
  error?: string;
  files?: number;
  last_indexed_at?: string | null;
  models?: string[];
  path?: string;
  pending?: number;
  skip_reasons?: Record<string, number>;
  skipped?: number;
  unusable?: string;
  vectors?: number;
}

describe("the status index section", () => {
  test("it counts what is embedded, pending and skipped, and why", async () => {
    const out = await section();

    expect(out?.files).toBe(4);
    expect(out?.embedded).toBe(1);
    expect(out?.pending).toBe(1);
    expect(out?.skipped).toBe(2);
    expect(out?.skip_reasons).toEqual({ "non-utf8": 1, oversize: 1 });
    expect(out?.vectors).toBe(1);
    expect(out?.models).toEqual(["qwen3"]);
    expect(out?.last_indexed_at).toBe("2026-08-15T01:44:00.000Z");
    expect(out?.bytes).toBeGreaterThan(0);
  });

  test("an unregistered background pass says so rather than pretending", async () => {
    expect((await section())?.background).toEqual({ registered: false });
  });

  test("a registered pass reports its progress and its backoff", async () => {
    const progress: WorkspaceIndexProgress = {
      character: "heidi",
      pending: 42,
      files: 100,
      failures: 3,
      retryAt: 1_030_000,
      lastError: "provider is down",
      sweptAt: 999_000,
      embedderError: undefined,
    };
    const out = await section(sourceFor({ progressFor: () => progress }));

    expect(out?.pending).toBe(42);
    expect(out?.background).toEqual({
      registered: true,
      swept: true,
      failures: 3,
      last_error: "provider is down",
      retry_in_secs: 30,
    });
  });

  test("before the first pass the backlog comes off disk, not from a zeroed counter", async () => {
    const out = await section(
      sourceFor({
        progressFor: () => ({
          character: "heidi",
          pending: 0,
          files: 0,
          failures: 0,
          retryAt: 0,
          lastError: undefined,
          sweptAt: undefined,
          embedderError: undefined,
        }),
      }),
    );

    expect(out?.pending).toBe(1);
  });

  test("a pass with no embedder carries the reason it will never run", async () => {
    const out = await section(
      sourceFor({
        progressFor: () => ({
          character: "heidi",
          pending: 0,
          files: 0,
          failures: 0,
          retryAt: 0,
          lastError: undefined,
          sweptAt: undefined,
          embedderError: "no embedding model configured; semantic search disabled",
        }),
      }),
    );

    expect(out?.background).toEqual({
      registered: true,
      swept: false,
      embedder_error: "no embedding model configured; semantic search disabled",
      failures: 0,
    });
  });

  test("a healthy registered pass carries no error and no retry", async () => {
    const out = await section(
      sourceFor({
        progressFor: () => ({
          character: "heidi",
          pending: 0,
          files: 4,
          failures: 0,
          retryAt: 0,
          embedderError: undefined,
          lastError: undefined,
          sweptAt: 999_000,
        }),
      }),
    );

    expect(out?.background).toEqual({ registered: true, swept: true, failures: 0 });
  });

  test("a character with no index path has no section at all", async () => {
    expect(await section(sourceFor({ indexPathFor: () => undefined }))).toBeNull();
  });

  test("an unwired daemon has no section rather than an empty one", async () => {
    expect(await workspaceIndexSection(undefined, "heidi")).toBeNull();
  });

  test("an index that has never been written reports zeroes, not an error", async () => {
    const out = await section(sourceFor({ indexPathFor: () => join(root, "fresh.db") }));

    expect(out?.files).toBe(0);
    expect(out?.embedded).toBe(0);
    expect(out?.vectors).toBe(0);
    expect(out?.last_indexed_at).toBeNull();
  });
});

describe("an index path that cannot hold a database", () => {
  test("a foreign file at the path is reported, not overwritten", async () => {
    const path = join(root, "notadb.db");
    await writeFile(path, "IMPORTANT USER DATA, NOT A DATABASE");

    const out = await section(sourceFor({ indexPathFor: () => path }));

    expect(out?.unusable).toContain("not a SQLite database");
    expect(await readFile(path, "utf8")).toBe("IMPORTANT USER DATA, NOT A DATABASE");
  });

  test("a directory at the path is reported, not removed", async () => {
    const path = join(root, "adir.db");
    await mkdir(path);

    const out = await section(sourceFor({ indexPathFor: () => path }));

    expect(out?.unusable).toContain("not a SQLite database");
  });

  test("a path that cannot be created is reported", async () => {
    const locked = join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      const out = await section(sourceFor({ indexPathFor: () => join(locked, "idx.db") }));

      expect(out?.unusable).toContain("cannot hold a database");
      expect(out?.bytes).toBe(0);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("writes to a fallback store do not survive a reopen", async () => {
    const path = join(root, "writes.db");
    await writeFile(path, "ALSO NOT A DATABASE");

    const first = WorkspaceIndexStore.open(path);
    first.putFiles([
      {
        display_path: "a.md",
        size: 1,
        modified_at_secs: 1,
        document_hash: "h",
        embed_chars: 1,
        embedded: false,
        reason: undefined,
      },
    ]);
    expect(first.stats().files).toBe(1);
    first.close();

    const second = WorkspaceIndexStore.open(path);
    expect(second.stats().files).toBe(0);
    expect(second.unusableReason).toBeDefined();
    second.close();
  });

  test("a healthy empty index is not reported as unusable", async () => {
    const out = await section(sourceFor({ indexPathFor: () => join(root, "fresh.db") }));

    expect(out?.unusable).toBeUndefined();
    expect(out?.files).toBe(0);
  });
});
