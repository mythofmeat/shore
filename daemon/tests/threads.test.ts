import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAIN_THREAD, archiveKey } from "../src/config/dirs.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import {
  MAX_THREAD_ID_LENGTH,
  ThreadError,
  archiveThread,
  createThread,
  defaultThreadsIndex,
  ensureThreads,
  homeThread,
  homeThreadOf,
  isValidThreadId,
  migrateCharacterToThreads,
  readThreadsIndex,
  setHomeThread,
  setThreadLabel,
  touchThread,
  writeThreadsIndex,
} from "../src/engine/threads.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-09-03T12:00:00.000Z";

let counter = 0;

async function dataDir(): Promise<string> {
  counter += 1;
  const dir = testTmp(`threads-${String(counter)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function messageLine(text: string): string {
  return JSON.stringify({
    msg_id: `m_${text}`,
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: NOW,
  });
}

async function seedLegacyCharacter(root: string, character: string): Promise<string> {
  const dir = join(root, character);
  await mkdir(join(dir, "segments"), { recursive: true });
  await writeFile(join(dir, "active.jsonl"), `${messageLine("hello")}\n`);
  await writeFile(join(dir, "compaction.json"), '{"segments":[],"total_compacted_messages":0}\n');
  await writeFile(join(dir, "segments", "seg-0.jsonl"), `${messageLine("archived")}\n`);
  await writeFile(join(dir, "preferences.json"), "{}\n");
  return dir;
}

describe("thread ids", () => {
  test("accepts ordinary ids and rejects path-shaped ones", () => {
    expect(isValidThreadId("main")).toBe(true);
    expect(isValidThreadId("agent-sdk-eval")).toBe(true);
    expect(isValidThreadId("v1.2_scratch")).toBe(true);

    expect(isValidThreadId("")).toBe(false);
    expect(isValidThreadId(".")).toBe(false);
    expect(isValidThreadId("..")).toBe(false);
    expect(isValidThreadId("../escape")).toBe(false);
    expect(isValidThreadId("a/b")).toBe(false);
    expect(isValidThreadId("-leading")).toBe(false);
    expect(isValidThreadId("_leading")).toBe(false);
    expect(isValidThreadId("with space")).toBe(false);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH))).toBe(true);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH + 1))).toBe(false);
  });
});

describe("archive key", () => {
  test("the main thread keeps the bare character name", () => {
    expect(archiveKey("qifei", MAIN_THREAD)).toBe("qifei");
    expect(archiveKey("qifei", "scratch")).toBe("qifei/scratch");
  });
});

describe("migration", () => {
  test("moves the conversation under threads/main and writes the index", async () => {
    const root = await dataDir();
    const dir = await seedLegacyCharacter(root, "aria");

    expect(await migrateCharacterToThreads(root, "aria", NOW)).toBe(true);

    expect(existsSync(join(dir, "threads", "main", "active.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "threads", "main", "segments", "seg-0.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "threads", "main", "compaction.json"))).toBe(true);
    expect(existsSync(join(dir, "active.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "segments"))).toBe(false);
    expect(existsSync(join(dir, "preferences.json"))).toBe(true);

    expect(await readThreadsIndex(root, "aria")).toEqual(defaultThreadsIndex(NOW));
  });

  test("is a no-op once the index exists", async () => {
    const root = await dataDir();
    await seedLegacyCharacter(root, "aria");
    await migrateCharacterToThreads(root, "aria", NOW);

    await writeFile(join(root, "aria", "active.jsonl"), `${messageLine("stray")}\n`);
    expect(await migrateCharacterToThreads(root, "aria", "2026-09-04T00:00:00.000Z")).toBe(false);

    expect(existsSync(join(root, "aria", "active.jsonl"))).toBe(true);
    expect((await readThreadsIndex(root, "aria"))?.threads[0]?.created_at).toBe(NOW);
  });

  test("keeps what a half-finished run already moved", async () => {
    const root = await dataDir();
    const dir = await seedLegacyCharacter(root, "aria");
    await mkdir(join(dir, "threads", MAIN_THREAD), { recursive: true });
    await writeFile(join(dir, "threads", MAIN_THREAD, "active.jsonl"), `${messageLine("moved")}\n`);

    expect(await migrateCharacterToThreads(root, "aria", NOW)).toBe(true);

    const active = await readFile(join(dir, "threads", MAIN_THREAD, "active.jsonl"), "utf8");
    expect(active).toBe(`${messageLine("moved")}\n`);
    expect(existsSync(join(dir, "active.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "threads", MAIN_THREAD, "segments"))).toBe(true);
  });

  test("a move that fails leaves no index claiming the character is migrated", async () => {
    const root = await dataDir();
    const dir = await seedLegacyCharacter(root, "aria");
    const to = join(dir, "threads", MAIN_THREAD);
    await mkdir(to, { recursive: true });
    await chmod(to, 0o500);

    try {
      expect(migrateCharacterToThreads(root, "aria", NOW)).rejects.toThrow();
      expect(existsSync(join(dir, "threads.json"))).toBe(false);
    } finally {
      await chmod(to, 0o700);
    }
  });

  test("ensureThreads migrates a legacy character before reading the index", async () => {
    const root = await dataDir();
    const dir = await seedLegacyCharacter(root, "aria");

    expect(await ensureThreads(root, "aria", NOW)).toEqual(defaultThreadsIndex(NOW));
    expect(existsSync(join(dir, "threads", MAIN_THREAD, "active.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "active.jsonl"))).toBe(false);
  });

  test("ensureThreads repairs an index it cannot read", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    await rm(join(root, "aria", "threads", MAIN_THREAD), { recursive: true, force: true });
    await writeFile(join(root, "aria", "threads.json"), "{ not json");

    const later = "2026-09-05T00:00:00.000Z";
    expect(await ensureThreads(root, "aria", later)).toEqual(defaultThreadsIndex(later));
    expect(existsSync(join(root, "aria", "threads", MAIN_THREAD))).toBe(true);
    expect(await readThreadsIndex(root, "aria")).toEqual(defaultThreadsIndex(later));
  });

  test("a dry run repairs nothing either", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    await rm(join(root, "aria", "threads", MAIN_THREAD), { recursive: true, force: true });
    await writeFile(join(root, "aria", "threads.json"), "{ not json");

    const later = "2026-09-05T00:00:00.000Z";
    expect(await ensureThreads(root, "aria", later, true)).toEqual(defaultThreadsIndex(later));
    expect(existsSync(join(root, "aria", "threads", MAIN_THREAD))).toBe(false);
    expect(await readFile(join(root, "aria", "threads.json"), "utf8")).toBe("{ not json");
  });

  test("a dry run reports without touching anything", async () => {
    const root = await dataDir();
    const dir = await seedLegacyCharacter(root, "aria");

    expect(await migrateCharacterToThreads(root, "aria", NOW, true)).toBe(false);

    expect(existsSync(join(dir, "active.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "threads"))).toBe(false);
    expect(await readThreadsIndex(root, "aria")).toBeUndefined();
  });

  test("ensureThreads creates the index for a character with no data yet", async () => {
    const root = await dataDir();
    const index = await ensureThreads(root, "nova", NOW);

    expect(index).toEqual(defaultThreadsIndex(NOW));
    expect(existsSync(join(root, "nova", "threads", "main"))).toBe(true);
  });
});

describe("home thread", () => {
  test("falls back to main when the index is missing or points nowhere", async () => {
    const root = await dataDir();
    expect(await homeThreadOf(root, "ghost")).toBe(MAIN_THREAD);

    await ensureThreads(root, "aria", NOW);
    await writeThreadsIndex(root, "aria", {
      version: 1,
      home: "vanished",
      threads: [{ id: MAIN_THREAD, created_at: NOW, compaction: true }],
    });
    expect(await homeThreadOf(root, "aria")).toBe(MAIN_THREAD);
  });

  test("a corrupt index reads as absent rather than throwing", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    await writeFile(join(root, "aria", "threads.json"), "{ not json");

    expect(await readThreadsIndex(root, "aria")).toBeUndefined();
    expect(homeThread(undefined)).toBe(MAIN_THREAD);
  });

  test("json that is not an index reads as absent", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    const path = join(root, "aria", "threads.json");

    for (const shape of [
      "null",
      '"main"',
      "[]",
      '{"hello":1}',
      '{"version":1,"home":"main"}',
      '{"version":1,"home":"main","threads":{}}',
      '{"version":1,"home":"main","threads":[{"created_at":"x"}]}',
      '{"version":1,"home":42,"threads":[]}',
    ]) {
      await writeFile(path, shape);
      expect(await readThreadsIndex(root, "aria")).toBeUndefined();
    }
  });

  test("an index from a future version is not read as this one", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    await writeFile(
      join(root, "aria", "threads.json"),
      JSON.stringify({ ...defaultThreadsIndex(NOW), version: 2 }),
    );

    expect(await readThreadsIndex(root, "aria")).toBeUndefined();
    expect(await homeThreadOf(root, "aria")).toBe(MAIN_THREAD);
  });
});

describe("thread lifecycle", () => {
  test("creates a thread with compaction off by default", async () => {
    const root = await dataDir();
    const index = await createThread(root, "aria", "scratch", NOW, { label: "Scratch" });

    expect(index.threads.map((t) => t.id)).toEqual([MAIN_THREAD, "scratch"]);
    expect(index.threads[1]).toEqual({
      id: "scratch",
      created_at: NOW,
      compaction: false,
      label: "Scratch",
    });
    expect(existsSync(join(root, "aria", "threads", "scratch"))).toBe(true);
  });

  test("refuses a duplicate id and an invalid one", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW);

    expect(createThread(root, "aria", "scratch", NOW)).rejects.toThrow(ThreadError);
    expect(createThread(root, "aria", "../escape", NOW)).rejects.toThrow(ThreadError);
    expect(existsSync(join(root, "aria", "threads", "..", "escape"))).toBe(false);
  });

  test("moves home only to a thread that exists", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW);

    expect(await homeThreadOf(root, "aria")).toBe(MAIN_THREAD);
    await setHomeThread(root, "aria", "scratch", NOW);
    expect(await homeThreadOf(root, "aria")).toBe("scratch");

    expect(setHomeThread(root, "aria", "nowhere", NOW)).rejects.toThrow(ThreadError);
  });

  test("sets and clears a label, and records last activity", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW, { label: "Scratch" });

    const cleared = await setThreadLabel(root, "aria", "scratch", undefined, NOW);
    expect(cleared.threads[1]).not.toHaveProperty("label");

    const relabelled = await setThreadLabel(root, "aria", "scratch", "Eval", NOW);
    expect(relabelled.threads[1]?.label).toBe("Eval");

    const later = "2026-09-04T09:00:00.000Z";
    await touchThread(root, "aria", "scratch", later);
    expect((await readThreadsIndex(root, "aria"))?.threads[1]?.last_active).toBe(later);
  });
});

describe("archiving a thread", () => {
  test("moves its messages into the character archive under its own key", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW);
    const threadDir = join(root, "aria", "threads", "scratch");
    await writeFile(join(threadDir, "active.jsonl"), `${messageLine("one")}\n${messageLine("two")}\n`);

    const index = await archiveThread(root, "aria", "scratch");

    expect(index.threads.map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(existsSync(threadDir)).toBe(false);

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      expect(store.entries("aria/scratch").length).toBe(1);
      expect(store.readSegment("aria/scratch", 0).length).toBe(2);
      expect(store.entries("aria").length).toBe(0);
    } finally {
      store.close();
    }
  });

  test("drops an empty thread without writing a segment", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW);

    const index = await archiveThread(root, "aria", "scratch");
    expect(index.threads.map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(existsSync(join(root, HISTORY_DB_FILE))).toBe(false);
  });

  test("refuses the home thread and an unknown one", async () => {
    const root = await dataDir();
    await createThread(root, "aria", "scratch", NOW);

    expect(archiveThread(root, "aria", MAIN_THREAD)).rejects.toThrow(ThreadError);
    expect(archiveThread(root, "aria", "nowhere")).rejects.toThrow(ThreadError);
    expect(existsSync(join(root, "aria", "threads", MAIN_THREAD))).toBe(true);

    await setHomeThread(root, "aria", "scratch", NOW);
    const index = await archiveThread(root, "aria", MAIN_THREAD);
    expect(index.threads.map((t) => t.id)).toEqual(["scratch"]);
  });
});

describe("the threads index on disk", () => {
  test("round-trips as formatted json", async () => {
    const root = await dataDir();
    await ensureThreads(root, "aria", NOW);
    const raw = await readFile(join(root, "aria", "threads.json"), "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(defaultThreadsIndex(NOW));
  });
});
