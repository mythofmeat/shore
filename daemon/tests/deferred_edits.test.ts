import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  changedPromptFiles,
  ensureActivePromptSnapshot,
  forkPromptState,
  loadActivePromptFile,
  pendingDeferredEditPaths,
  queueDeferredEdit,
} from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { readCharacterState, writeCharacterState } from "../src/storage/store.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { testTmp } from "./support/tmp.ts";

async function character(): Promise<{ dir: string; workspace: string }> {
  const root = testTmp(`deferred-edits-${crypto.randomUUID()}`);
  const data = join(root, "data");
  await mkdir(join(data, "ada"), { recursive: true });
  initializeDatabase(data);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "notes"), { recursive: true });
  return { dir: join(data, "ada"), workspace };
}

describe("the edits waiting for a prompt reload", () => {
  test("are each queued path once, sorted, per thread, with lines that aren't a queued path passed over", async () => {
    const { dir } = await character();
    await queueDeferredEdit(dir, "notes/MAP.md", "story");
    await queueDeferredEdit(dir, "SOUL.md", "story");
    await queueDeferredEdit(dir, "notes/MAP.md", "story");
    expect(await pendingDeferredEditPaths(dir, "story")).toEqual(["SOUL.md", "notes/MAP.md"]);
    expect(await pendingDeferredEditPaths(dir)).toEqual([]);

    writeCharacterState(dir, "deferred_edits.jsonl", ['{"path":"USER.md"}', "", "not json", "null", "5", '{"path":3}', '{"other":"x"}', '{"path":"USER.md"}'].join("\n"));
    expect(await pendingDeferredEditPaths(dir)).toEqual(["USER.md"]);
  });
});

describe("the prompt files that changed since the snapshot", () => {
  test("are none before a conversation has a snapshot, and then the listed files that differ from it, under any name", async () => {
    const { dir, workspace } = await character();
    const listed = new CharacterWorkspace(workspace, undefined, ["SOUL.md", "notes/MAP.md"]);
    await writeFile(join(workspace, "SOUL.md"), "Ada.");
    await writeFile(join(workspace, "notes", "MAP.md"), "- places");
    await writeFile(join(workspace, "notes", "other.md"), "not listed");
    expect(await changedPromptFiles(dir, listed)).toEqual([]);

    await ensureActivePromptSnapshot(dir, listed);
    expect(await changedPromptFiles(dir, listed)).toEqual([]);
    await writeFile(join(workspace, "notes", "MAP.md"), "- more places");
    await writeFile(join(workspace, "notes", "other.md"), "changed, but not listed");
    expect(await changedPromptFiles(dir, listed)).toEqual(["notes/MAP.md"]);
  });
});

describe("a forked thread's prompt state", () => {
  test("is the source's prompt files under any name, its snapshot mark and its queue, without the source's pins or the child's own leftovers", async () => {
    const { dir } = await character();
    writeCharacterState(dir, "active_prompt/SOUL.md", "soul");
    writeCharacterState(dir, "active_prompt/notes/MAP.md", "map");
    writeCharacterState(dir, "active_prompt/thread_pins/plan.md", "the source's pin");
    writeCharacterState(dir, "active_prompt/.snapshot", "1");
    await queueDeferredEdit(dir, "notes/MAP.md");
    writeCharacterState(dir, "threads/spin/active_prompt/old.md", "left from before");
    writeCharacterState(dir, "threads/spin/deferred_edits.jsonl", '{"path":"old.md"}\n');

    await forkPromptState(dir, "main", "spin");

    expect(await loadActivePromptFile(dir, "SOUL.md", "spin")).toBe("soul");
    expect(await loadActivePromptFile(dir, "notes/MAP.md", "spin")).toBe("map");
    expect(await loadActivePromptFile(dir, "old.md", "spin")).toBeUndefined();
    expect(readCharacterState(dir, "threads/spin/active_prompt/thread_pins/plan.md")).toBeUndefined();
    expect(readCharacterState(dir, "threads/spin/active_prompt/.snapshot")).toBe("1");
    expect(await pendingDeferredEditPaths(dir, "spin")).toEqual(["notes/MAP.md"]);
  });

  test("from a source with no snapshot and no queue is empty, whatever the child had before", async () => {
    const { dir } = await character();
    writeCharacterState(dir, "threads/spin/active_prompt/old.md", "left from before");
    writeCharacterState(dir, "threads/spin/active_prompt/.snapshot", "1");
    writeCharacterState(dir, "threads/spin/deferred_edits.jsonl", '{"path":"old.md"}\n');

    await forkPromptState(dir, "main", "spin");

    expect(await loadActivePromptFile(dir, "old.md", "spin")).toBeUndefined();
    expect(readCharacterState(dir, "threads/spin/active_prompt/.snapshot")).toBeUndefined();
    expect(await pendingDeferredEditPaths(dir, "spin")).toEqual([]);
  });
});
