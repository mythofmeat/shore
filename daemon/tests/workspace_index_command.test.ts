import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandError } from "../src/commands/errors";
import {
  workspaceIndex,
  type WorkspaceIndexContext,
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
  store.putEmbeddings("qwen3", [{ hash: "ha", vector: [1, 0] }]);
  store.setMetadata("last_indexed_at", "2026-08-15T01:44:00.000Z");
  store.close();
  return path;
}

function contextFor(
  overrides: Partial<WorkspaceIndexContext> = {},
): WorkspaceIndexContext {
  return {
    characterName: "qifei",
    indexPathFor: (c) => (c === "qifei" ? stocked("qifei") : undefined),
    progressFor: () => undefined,
    characters: () => ["qifei", "yuna"],
    now: () => 1_000_000,
    ...overrides,
  };
}

describe("workspace_index", () => {
  test("it counts what is embedded, pending and skipped, and why", async () => {
    const out = (await workspaceIndex(contextFor(), {})) as Record<string, any>;

    expect(out.character).toBe("qifei");
    expect(out.enabled).toBe(true);
    expect(out.files).toBe(4);
    expect(out.embedded).toBe(1);
    expect(out.pending).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.skip_reasons).toEqual({ "non-utf8": 1, oversize: 1 });
    expect(out.vectors).toBe(1);
    expect(out.models).toEqual(["qwen3"]);
    expect(out.last_indexed_at).toBe("2026-08-15T01:44:00.000Z");
    expect(out.bytes).toBeGreaterThan(0);
  });

  test("an unregistered background pass says so rather than pretending", async () => {
    const out = (await workspaceIndex(contextFor(), {})) as Record<string, any>;
    expect(out.background).toEqual({ registered: false });
  });

  test("a registered pass reports its progress and its backoff", async () => {
    const progress: WorkspaceIndexProgress = {
      character: "qifei",
      pending: 42,
      files: 100,
      failures: 3,
      retryAt: 1_030_000,
      lastError: "provider is down",
      sweptAt: 999_000,
    };
    const out = (await workspaceIndex(
      contextFor({ progressFor: () => progress }),
      {},
    )) as Record<string, any>;

    expect(out.pending).toBe(42);
    expect(out.background).toEqual({
      registered: true,
      swept: true,
      failures: 3,
      last_error: "provider is down",
      retry_in_secs: 30,
    });
  });

  test("a healthy registered pass carries no error and no retry", async () => {
    const out = (await workspaceIndex(
      contextFor({
        progressFor: () => ({
          character: "qifei",
          pending: 0,
          files: 4,
          failures: 0,
          retryAt: 0,
          lastError: undefined,
          sweptAt: 999_000,
        }),
      }),
      {},
    )) as Record<string, any>;

    expect(out.background).toEqual({ registered: true, swept: true, failures: 0 });
  });

  test("a character argument overrides the selected one", async () => {
    const seen: string[] = [];
    await workspaceIndex(
      contextFor({
        indexPathFor: (c) => {
          seen.push(c);
          return stocked(c);
        },
      }),
      { character: "yuna" },
    );
    expect(seen).toEqual(["yuna"]);
  });

  test("a character nobody has heard of is a bad request", async () => {
    await expect(workspaceIndex(contextFor(), { character: "nobody" })).rejects.toThrow(
      CommandError,
    );
    await expect(workspaceIndex(contextFor(), { character: "nobody" })).rejects.toThrow(
      "unknown character 'nobody'",
    );
  });

  test("no character selected at all is a bad request", async () => {
    await expect(
      workspaceIndex(contextFor({ characterName: undefined }), {}),
    ).rejects.toThrow("no character selected");
  });

  test("a character with no index path reports disabled rather than failing", async () => {
    const out = (await workspaceIndex(
      contextFor({ indexPathFor: () => undefined }),
      {},
    )) as Record<string, any>;
    expect(out).toEqual({ character: "qifei", enabled: false });
  });

  test("an index that has never been written reports zeroes, not an error", async () => {
    const out = (await workspaceIndex(
      contextFor({ indexPathFor: () => join(root, "fresh.db") }),
      {},
    )) as Record<string, any>;

    expect(out.files).toBe(0);
    expect(out.embedded).toBe(0);
    expect(out.vectors).toBe(0);
    expect(out.last_indexed_at).toBeNull();
  });
});
