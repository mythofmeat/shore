import { readdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { unpack } from "../src/storage/store.ts";
import { readFileSync, readFile } from "./support/stored_files.ts";
import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { expandShared } from "./support/shared_subtrees.ts";
import { mkdtemp, mkdir,  writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  applyDeferredEdits,
  changedPromptFiles,
  ensureActivePromptSnapshot,
  ensureCharacterWorkspace,
  loadActivePromptFile,
  loadCanonicalMemoryIndex,
  loadMemoryIndex,
  noteMemoryIndexDeferred,
  pendingDeferredEditPaths,
  queueDeferredEdit,
  refreshActivePromptSnapshot,
} from "../src/memory/deferred_edits";

interface Case {
  name: string;
  op: { fn: string; path?: string; name?: string };
  before: Record<string, string>;
  after: Record<string, string>;
  returns: unknown;
  err: string | null;
}

const fixture = expandShared(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "memory_captures/deferred_edits.json"),
      "utf8",
    ),
  ),
) as { constants: Record<string, unknown>; cases: Case[] };

const CHAR = fixture.constants.character as string;
const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(cur: string): Promise<void> {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      if (entry.name.startsWith("shore.db")) continue;
      const p = join(cur, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[relative(dir, p).replaceAll("\\", "/")] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  if (await Bun.file(join(dir, "shore.db")).exists()) {
    const db = new Database(join(dir, "shore.db"), { readonly: true });
    try {
      for (const row of db.query("SELECT path, content FROM state_files").all() as { path: string; content: Uint8Array }[]) {
        if (!row.path.endsWith("/.snapshot")) out[row.path] = unpack(row.content);
      }
    } finally { db.close(); }
  }
  return out;
}

function normalizeQueue(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return line;
      }
      if (typeof entry.timestamp === "string") entry.timestamp = "<stamped>";
      return JSON.stringify(entry);
    })
    .join("\n");
}

describe("applying a deferred edit", () => {
  test("the fixture pins the constants this module hardcodes", () => {
    expect(fixture.constants.protected_paths).toEqual([
      "SOUL.md",
      "USER.md",
      "AGENTS.md",
      "TOOLS.md",
    ]);
    expect(fixture.constants.legacy_snapshots).toEqual([
      "RECENT_MEMORY.md",
      "HEARTBEAT.md",
    ]);
    expect(fixture.constants.queue_file).toBe("deferred_edits.jsonl");
    expect(fixture.constants.active_prompt_dir).toBe("active_prompt");
  });

  for (const c of fixture.cases) {
    test(c.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "deferred-edits-"));
      try {
        const dataDir = join(root, "data");
        const configDir = join(root, "config");
        await mkdir(dataDir, { recursive: true });
        await mkdir(configDir, { recursive: true });

        for (const [rel, content] of Object.entries(c.before)) {
          const p = join(root, rel);
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, b64(content), "utf8");
        }

        let returned: unknown = null;
        switch (c.op.fn) {
          case "queue_deferred_edit":
            await queueDeferredEdit(dataDir, required(c.op.path));
            break;
          case "note_memory_index_deferred":
            await noteMemoryIndexDeferred(dataDir);
            break;
          case "pending_deferred_edit_paths":
            returned = await pendingDeferredEditPaths(dataDir);
            break;
          case "changed_prompt_files":
            returned = await changedPromptFiles(dataDir, configDir, CHAR);
            break;
          case "apply_deferred_edits":
            await applyDeferredEdits(dataDir, configDir, CHAR);
            break;
          case "ensure_active_prompt_snapshot":
            await ensureActivePromptSnapshot(dataDir, configDir, CHAR);
            break;
          case "refresh_active_prompt_snapshot":
            await refreshActivePromptSnapshot(dataDir, configDir, CHAR);
            break;
          case "ensure_character_workspace":
            await ensureCharacterWorkspace(dataDir, configDir, CHAR);
            break;
          case "load_memory_index":
            returned = (await loadMemoryIndex(dataDir, configDir, CHAR)) ?? null;
            break;
          case "load_active_prompt_file":
            returned = (await loadActivePromptFile(dataDir, required(c.op.name))) ?? null;
            break;
          case "load_canonical_memory_index":
            returned = (await loadCanonicalMemoryIndex(configDir, CHAR)) ?? null;
            break;
          default:
            throw new Error(`unhandled op ${c.op.fn}`);
        }

        expect(c.err).toBeNull();
        expect(returned).toEqual(c.returns as never);

        if (c.op.fn === "queue_deferred_edit" || c.op.fn === "note_memory_index_deferred") {
          const queued = (await snapshot(root))["data/deferred_edits.jsonl"];
          if (queued !== undefined) {
            const lines = queued.split("\n").filter((l) => l.trim() !== "");
            const last = JSON.parse(required(lines[lines.length - 1])) as {
              timestamp?: unknown;
            };
            expect(typeof last.timestamp).toBe("string");
            expect(Number.isNaN(Date.parse(last.timestamp as string))).toBe(false);
          }
        }

        const actual = await snapshot(root);
        const expected = Object.fromEntries(
          Object.entries(c.after).map(([k, v]) => [k, b64(v)]),
        );

        expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());

        for (const [rel, want] of Object.entries(expected)) {
          const got = required(actual[rel]);
          if (rel.endsWith("deferred_edits.jsonl")) {
            expect(normalizeQueue(got)).toBe(normalizeQueue(want));
          } else {
            expect(got).toBe(want);
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
