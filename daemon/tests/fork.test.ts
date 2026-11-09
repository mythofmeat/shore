import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAIN_THREAD, archiveKey, characterDataDir } from "../src/config/dirs.ts";
import { FORK_MARKER_FILE, forkThread, recoverForks } from "../src/engine/fork.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { createThread, ensureThreads, readThreadsIndex, writeThreadsIndex } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { durableExists, threadFile } from "../src/storage/files.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { handlesUnder } from "./support/handles.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-09-05T12:00:00.000Z";
let counter = 0;

function message(id: string, role: Message["role"], text: string): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: NOW };
}

async function emptyDataDir(): Promise<string> {
  counter += 1;
  const root = testTmp(`fork-test-${String(counter)}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

async function character(threads?: Record<string, readonly string[]>): Promise<string> {
  const root = await emptyDataDir();
  await ensureThreads(root, "ada", NOW);
  for (const [thread, texts] of Object.entries(threads ?? { main: ["first"] })) {
    if (thread !== MAIN_THREAD) await createThread(root, "ada", thread, NOW);
    const store = await MessageStore.load(threadFile(root, "ada", thread, "active.jsonl"));
    for (const [i, text] of texts.entries()) await store.append(message(`${thread}-${String(i)}`, i % 2 === 0 ? "user" : "assistant", text));
  }
  return root;
}

const threadIds = async (root: string): Promise<string[] | undefined> => (await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id);

function forksOf(root: string): string[] {
  const history = HistoryStore.open(join(root, HISTORY_DB_FILE));
  try {
    return history.threadForks("ada").map((fork) => fork.child);
  } finally {
    history.close();
  }
}

function snapshot(root: string, soul: string): void {
  const dir = characterDataDir(root, "ada");
  writeCharacterState(dir, "active_prompt/SOUL.md", soul);
  writeCharacterState(dir, "active_prompt/.snapshot", "1");
}

describe("forking a thread", () => {
  test("--turns must be a positive whole number of turns", async () => {
    const root = await character({ main: ["q1", "a1", "q2", "a2"] });
    for (const turns of [0, -1, 1.5, Number.NaN]) {
      expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, turns }))).toThrow("--turns must be a positive whole number of turns");
    }
    const one = await forkThread(root, "ada", "main", "spin", { now: () => NOW, turns: 1 });
    expect([one.fork.turn_count, one.fork.message_count]).toEqual([1, 2]);
    expect(Object.hasOwn(one.child, "chat_model")).toBe(false);
  });

  test("a fork needs the character's threads and its source, and a name no thread has", async () => {
    expect(await outcomeOf(forkThread(await emptyDataDir(), "ada", "main", "spin", { now: () => NOW }))).toThrow("no threads for ada");
    const root = await character();
    expect(await outcomeOf(forkThread(root, "ada", "gone", "spin", { now: () => NOW }))).toThrow('no thread "gone" for ada');
    expect(await outcomeOf(forkThread(root, "ada", "main", "main", { now: () => NOW }))).toThrow('thread "main" already exists for ada');
    expect(await threadIds(root)).toEqual(["main"]);
  });

  test("an empty folder in the child's place is used, but one holding anything is refused and kept", async () => {
    const root = await character();
    await mkdir(join(root, "ada", "threads", "spin"), { recursive: true });
    await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    const busy = join(root, "ada", "threads", "busy");
    await mkdir(busy, { recursive: true });
    await writeFile(join(busy, "notes.txt"), "mine");
    expect(await outcomeOf(forkThread(root, "ada", "main", "busy", { now: () => NOW }))).toThrow(/already holds data/);
    expect(await readFile(join(busy, "notes.txt"), "utf8")).toBe("mine");
    expect(await threadIds(root)).toEqual(["main", "spin"]);
  });

  test("a compaction in flight in any of the character's threads holds a fork back", async () => {
    const root = await character({ main: ["first"], side: ["other"] });
    const history = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      history.beginCompaction(archiveKey("ada", "side"), { file: HISTORY_DB_FILE, message_count: 1, compacted_at: NOW }, [message("side-0", "user", "other")], "before\n", "after\n");
    } finally {
      history.close();
    }
    expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW }))).toThrow("cannot fork ada/main right now: a compaction is mid-flight in this character");
    expect(await threadIds(root)).toEqual(["main", "side"]);
  });

  test("the child takes the source's prompt snapshot, chat model and compaction setting, and records where it came from", async () => {
    const root = await character({ main: ["q", "a"] });
    snapshot(root, "the soul the source saw");
    const index = await readThreadsIndex(root, "ada");
    if (index === undefined) throw new Error("no threads");
    await writeThreadsIndex(root, "ada", { ...index, threads: index.threads.map((thread) => ({ ...thread, chat_model: "anthropic:claude-x" })) });
    const result = await forkThread(root, "ada", "main", "spin", { now: () => NOW, newForkId: () => "fk_test" });
    expect(await loadActivePromptFile(characterDataDir(root, "ada"), "SOUL.md", "spin")).toBe("the soul the source saw");
    expect(result.child).toStrictEqual({
      id: "spin",
      created_at: NOW,
      compaction: true,
      chat_model: "anthropic:claude-x",
      forked_from: { fork_id: "fk_test", source: "main", created_at: NOW, messages: 2, turns: 1 },
    });
    expect(forksOf(root)).toEqual(["spin"]);
    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(false);
  });

  test("forks of different threads of one character run one at a time, so each lands in the index", async () => {
    const root = await character({ main: ["first"], side: ["other"] });
    await Promise.all([
      forkThread(root, "ada", "main", "from-main", { now: () => NOW }),
      forkThread(root, "ada", "side", "from-side", { now: () => NOW }),
    ]);
    expect(await threadIds(root)).toEqual(["main", "side", "from-main", "from-side"]);
  });

  test("forking and recovering leave no database handle open", async () => {
    const root = await character();
    await forkThread(root, "ada", "main", "warm", { now: () => NOW });
    await recoverForks(root, "ada");
    const open = handlesUnder(root);
    await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    expect(handlesUnder(root)).toBe(open);
    expect(await outcomeOf(forkThread(root, "ada", "main", "cut", { now: () => NOW, failAfter: "provenance" }))).toThrow(/injected/);
    const before = handlesUnder(root);
    await recoverForks(root, "ada");
    expect(handlesUnder(root)).toBe(before);
  });
});

describe("recovering an interrupted fork", () => {
  test("a fork that failed after publishing is completed: its marker goes and the thread stays", async () => {
    const root = await character({ main: ["q", "a"] });
    expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "publish" }))).toThrow(/injected/);
    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(true);
    expect(await recoverForks(root, "ada")).toEqual(["spin"]);
    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(false);
    expect(await threadIds(root)).toEqual(["main", "spin"]);
    expect((await MessageStore.load(threadFile(root, "ada", "spin", "active.jsonl"))).messages()).toHaveLength(2);
    expect(await recoverForks(root, "ada")).toEqual([]);
  });

  test("rolling back an unfinished fork removes its prompt snapshot, stored messages and provenance, and leaves the source alone", async () => {
    const root = await character({ main: ["q", "a"] });
    snapshot(root, "soul");
    expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "provenance" }))).toThrow(/injected/);
    const dir = characterDataDir(root, "ada");
    expect(await loadActivePromptFile(dir, "SOUL.md", "spin")).toBe("soul");
    expect(forksOf(root)).toEqual(["spin"]);
    expect(await recoverForks(root, "ada")).toEqual(["spin"]);
    expect(await loadActivePromptFile(dir, "SOUL.md", "spin")).toBeUndefined();
    expect(durableExists(threadFile(root, "ada", "spin", "active.jsonl"))).toBe(false);
    expect(forksOf(root)).toEqual([]);
    expect(await loadActivePromptFile(dir, "SOUL.md", "main")).toBe("soul");
    expect((await MessageStore.load(threadFile(root, "ada", "main", "active.jsonl"))).messages()).toHaveLength(2);
  });
});
