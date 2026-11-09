import { describe, expect, test } from "bun:test";
import { createFolder, deleteFolder, moveFolder, moveThread, placedThreads, renameFolder, setFolderSort } from "../src/engine/thread_layout.ts";
import { MAX_THREAD_ID_LENGTH, archiveThread, assertThreadId, isValidThreadId, createThread, ensureHeartbeatThread, ensureThreads, heartbeatThread, markThreadRead, readThreadsIndex, setThreadCompaction, threadActivityNow, threadFilePaths, writeThreadsIndex, type ThreadsIndex } from "../src/engine/threads.ts";
import { readFileSync, readFile } from "./support/stored_files.ts";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { MAIN_THREAD, characterThreadsIndex } from "../src/config/dirs.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { type LoadedConfig } from "../src/config/loader.ts";
import { appendDurableLine, initializeDurableLines, readDurable, replaceDurableSuffix, updateDurableLine, writeDurable } from "../src/storage/files.ts";
import { mkdir, rm } from "node:fs/promises";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { FORK_MARKER_FILE, forkThread, recoverForks, selectForkContext } from "../src/engine/fork.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { type ContentBlock, type Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";
import { outcomeOf } from "./support/outcome.ts";

describe("thread file paths", () => {
  test("lose empty and dot parts, and one that names nothing is refused", () => {
    expect(threadFilePaths(["stories//lighthouse.md", "stories/./notes.md", "/workspace/./plan.md"])).toEqual(["stories/lighthouse.md", "stories/notes.md", "plan.md"]);
    expect(() => threadFilePaths(["."])).toThrow("a thread file path is empty");
  });
});

describe("thread ids", () => {
  test("accepts ordinary ids and rejects path-shaped ones", () => {
    expect(isValidThreadId("main")).toBe(true);
    expect(isValidThreadId("a")).toBe(true);
    expect(() => assertThreadId("../escape")).toThrow("invalid thread id");
    expect(() => assertThreadId("side")).not.toThrow();
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

function config(configDir: string, dataDir: string, root: string): LoadedConfig {
  return {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: {
      config: configDir,
      data: dataDir,
      runtime: join(root, "runtime"),
      cache: join(root, "cache"),
    },
    rawTable: undefined,
  };
}

async function registryWith(...characters: string[]): Promise<{
  registry: CharacterRegistry;
  dataDir: string;
  configDir: string;
  loaded: LoadedConfig;
}> {
  const root = mkdtempSync(join(tmpdir(), "shore-registry-threads-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  for (const name of characters) {
    const dir = join(configDir, "characters", name, "workspace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SOUL.md"), `${name} soul`);
  }
  const loaded = config(configDir, dataDir, root);
  const registry = await CharacterRegistry.create(configDir, dataDir, loaded);
  return { registry, dataDir, configDir, loaded };
}

describe("concurrent thread-index mutations", () => {
  test("two threads created at once both survive on disk and in the registry", async () => {
    const { registry, dataDir } = await registryWith("aria");

    await Promise.all([
      registry.createThread("aria", "alpha"),
      registry.createThread("aria", "beta"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string }> };

    expect(onDisk.threads.map((t) => t.id).sort()).toEqual([MAIN_THREAD, "alpha", "beta"].sort());
    expect(registry.listThreads("aria").map((t) => t.id).sort()).toEqual(
      [MAIN_THREAD, "alpha", "beta"].sort(),
    );
  });

  test("a create racing an archive leaves the index consistent", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "doomed");

    await Promise.all([
      registry.createThread("aria", "fresh"),
      registry.archiveThread("aria", "doomed"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string }> };

    expect(onDisk.threads.map((t) => t.id).sort()).toEqual([MAIN_THREAD, "fresh"].sort());
    expect(registry.listThreads("aria").map((t) => t.id).sort()).toEqual(
      [MAIN_THREAD, "fresh"].sort(),
    );
  });
});

const NOW = "2026-09-05T12:00:00.000Z";

let counter = 0;

async function freshDataDir(): Promise<string> {
  counter += 1;
  const dir = testTmp(`fork-${String(counter)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function message(partial: Partial<Message> & Pick<Message, "msg_id" | "role">): Message {
  const blocks = partial.content_blocks ?? [{ type: "text", text: partial.content ?? "" }];
  return {
    content: partial.content ?? "",
    images: [],
    timestamp: NOW,
    ...partial,
    content_blocks: blocks,
  };
}

function user(id: string, text: string): Message {
  return message({ msg_id: id, role: "user", content: text });
}

function assistant(id: string, text: string, extra: Partial<Message> = {}): Message {
  return message({ msg_id: id, role: "assistant", content: text, ...extra });
}

function toolUse(id: string, useId: string): Message {
  const blocks: ContentBlock[] = [{ type: "tool_use", id: useId, name: "read", input: {} }];
  return message({ msg_id: id, role: "assistant", content_blocks: blocks });
}

function toolResult(id: string, useId: string): Message {
  const blocks: ContentBlock[] = [
    { type: "tool_result", tool_use_id: useId, content: "ok" },
  ];
  return message({ msg_id: id, role: "user", content_blocks: blocks });
}

async function seed(root: string, character: string, thread: string, messages: Message[]) {
  await ensureThreads(root, character, NOW);
  if (thread !== "main") await createThread(root, character, thread, NOW);
  const path = join(root, character, "threads", thread, "active.jsonl");
  const store = await MessageStore.load(path);
  for (const msg of messages) await store.append(msg);
  return path;
}

async function readMessages(path: string): Promise<Message[]> {
  const store = await MessageStore.load(path);
  return [...store.messages()];
}

describe("choosing what a fork copies", () => {

  test("a tool exchange travels whole, results attached to the call that made them", () => {
    const messages = [
      user("u1", "one"),
      assistant("a1", "reply one"),
      user("u2", "two"),
      toolUse("a2", "call-1"),
      toolResult("r2", "call-1"),
      assistant("a3", "reply two"),
    ];
    const selected = selectForkContext(messages, 1);
    expect(selected.map((m) => m.msg_id)).toEqual(["u2", "a2", "r2", "a3"]);
  });
});

describe("forking a thread", () => {
  test("a path-shaped thread id is refused before anything is written", async () => {
    const root = await freshDataDir();
    await seed(root, "ada", "main", [user("u1", "first"), assistant("a1", "reply")]);
    expect(await outcomeOf(forkThread(root, "ada", "main", "../escape", { now: () => NOW }))).toThrow("invalid thread id");
    expect(await outcomeOf(createThread(root, "ada", "../escape", NOW))).toThrow("invalid thread id");
    expect(existsSync(join(root, "ada", "escape"))).toBe(false);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  test("the child holds a copy the parent can no longer change", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [
      user("u1", "first"),
      assistant("a1", "reply"),
    ]);

    const result = await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    expect(result.fork.message_count).toBe(2);
    expect(result.fork.turn_count).toBe(1);

    const parent = await MessageStore.load(path);
    await parent.edit("u1", "rewritten");
    await parent.append(user("u2", "later"));

    const child = await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"));
    expect(child.map((m) => m.content)).toEqual(["first", "reply"]);
  });

  test("a directory that already holds data is never overwritten", async () => {
    const root = await freshDataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    const squatter = join(root, "ada", "threads", "spin");
    await mkdir(squatter, { recursive: true });
    writeDurable(join(squatter, "active.jsonl"), "keep me\n");

    expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW }))).toThrow(
      /already holds data/,
    );
    expect(await readFile(join(squatter, "active.jsonl"), "utf8")).toBe("keep me\n");
  });
});

describe("recovering an interrupted fork", () => {
  test("a failure before the registry publishes leaves no child and no provenance", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "provenance" })),
    ).toThrow(/injected/);

    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(true);
    expect(await recoverForks(root, "ada")).toEqual(["spin"]);
    expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main"]);

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      expect(store.threadForks("ada")).toEqual([]);
    } finally {
      store.close();
    }
    expect(await readMessages(path)).toHaveLength(1);
  });

  test("a crash before the context is written leaves the source untouched", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "context" })),
    ).toThrow(/injected/);

    await recoverForks(root, "ada");
    expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    expect(await readMessages(path)).toHaveLength(1);
  });

  test("two forks racing for the same name leave exactly one thread", async () => {
    const root = await freshDataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);

    const outcomes = await Promise.allSettled([
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main", "spin"]);
  });
});

describe("thread activity", () => {
  const line = (fields: Partial<Message>): string => `${JSON.stringify({ msg_id: crypto.randomUUID(), images: [], alternatives: [], ...fields })}\n`;
  const asked = (timestamp: string, text = "hello"): string => line({ role: "user", timestamp, content_blocks: [{ type: "text", text }] });
  const reply = (timestamp: string, text = "hi"): string => line({ role: "assistant", timestamp, content_blocks: [{ type: "text", text }] });

  async function scanned(run: (data: string, file: string) => Promise<void>): Promise<void> {
    const data = join(mkdtempSync(testTmp("shore-thread-activity-")), "data");
    await mkdir(join(data, "ada", "threads", "side"), { recursive: true });
    await run(data, join(data, "ada", "threads", "side", "active.jsonl"));
  }

  test("every kind of write to a thread shows in its counts on the next read", async () => {
    await scanned(async (data, file) => {
      const activity = () => threadActivityNow(data, "ada", "side");
      expect(activity().turns).toBe(0);

      writeDurable(file, asked("2026-10-01T10:00:00.000Z") + reply("2026-10-01T10:01:00.000Z"));
      expect(activity()).toMatchObject({ turns: 1, last_active: "2026-10-01T10:01:00.000Z", last_user: "2026-10-01T10:00:00.000Z" });

      initializeDurableLines(file, () => readDurable(file));
      appendDurableLine(file, asked("2026-10-01T11:00:00.000Z"));
      expect(activity()).toMatchObject({ turns: 2, last_active: "2026-10-01T11:00:00.000Z", last_user: "2026-10-01T11:00:00.000Z" });

      markThreadRead(data, "ada", "side", Date.parse("2026-10-01T11:00:00.000Z"));
      appendDurableLine(file, reply("2026-10-01T11:01:00.000Z"));
      appendDurableLine(file, reply("2026-10-01T11:02:00.000Z"));
      expect(activity()).toMatchObject({ turns: 2, last_active: "2026-10-01T11:02:00.000Z", unread: 2 });

      markThreadRead(data, "ada", "side", Date.parse("2026-10-01T11:01:00.000Z"));
      expect(activity().unread).toBe(1);

      replaceDurableSuffix(file, 4, [reply("2026-10-01T11:03:00.000Z", "a different reply that is longer than the last one")]);
      expect(activity()).toMatchObject({ turns: 2, last_active: "2026-10-01T11:03:00.000Z", unread: 1 });

      updateDurableLine(file, 0, asked("2026-10-01T09:00:00.000Z", "an edit changes the first line and its length"));
      expect(activity()).toMatchObject({ turns: 2, last_active: "2026-10-01T11:03:00.000Z" });

      writeDurable(file, asked("2026-10-02T10:00:00.000Z"));
      expect(activity()).toMatchObject({ turns: 1, last_active: "2026-10-02T10:00:00.000Z", unread: 0 });

      writeDurable(file, "");
      expect(activity().turns).toBe(0);
    });
  });
});

describe("thread compaction setting", () => {
  test("a thread's choice can change after it was made, and the heartbeat thread can't be made to compact", async () => {
    const data = join(mkdtempSync(testTmp("shore-thread-compaction-")), "data");
    const now = "2026-11-03T00:00:00.000Z";
    await createThread(data, "ada", "side", now);
    const compacts = async (id: string): Promise<boolean | undefined> => (await readThreadsIndex(data, "ada"))?.threads.find((thread) => thread.id === id)?.compaction;
    expect(await compacts("side")).toBe(false);
    await setThreadCompaction(data, "ada", "side", true, now);
    expect(await compacts("side")).toBe(true);
    await setThreadCompaction(data, "ada", "side", false, now);
    expect(await compacts("side")).toBe(false);

    const { index } = await ensureHeartbeatThread(data, "ada", now);
    const heartbeat = heartbeatThread(index) ?? "";
    expect(await outcomeOf(setThreadCompaction(data, "ada", heartbeat, true, now))).toThrow("never compacts");
    expect(await compacts(heartbeat)).toBe(false);
  });
});

describe("thread order and folders", () => {
  const now = "2026-11-03T00:00:00.000Z";

  function indexOf(...ids: string[]): ThreadsIndex {
    return {
      version: 1,
      home: "main",
      heartbeat: "beats",
      threads: ["main", "beats", ...ids].map((id, at) => ({ id, created_at: `2026-11-0${String(at + 1)}T00:00:00.000Z`, compaction: false })),
    };
  }
  const noActivity = (): undefined => undefined;
  const shown = (index: ThreadsIndex, activity: (id: string) => string | undefined = noActivity): string[] =>
    placedThreads(index, activity).map(({ record, folder }) => folder === undefined ? record.id : `${folder}/${record.id}`);

  test("with nothing moved the list stays by activity, home and heartbeat on top", () => {
    const active: Record<string, string> = { a: "2026-11-20T00:00:00.000Z", c: "2026-11-21T00:00:00.000Z" };
    expect(shown(indexOf("a", "b", "c"), (id) => active[id])).toEqual(["main", "beats", "c", "a", "b"]);
  });

  test("the first move keeps the order on screen, then the list stays put when threads get new messages", () => {
    const moved = moveThread(indexOf("a", "b", "c"), "ada", "a", { before: "b" }, noActivity);
    expect(shown(moved)).toEqual(["main", "beats", "c", "a", "b"]);
    expect(shown(moved, (id) => id === "b" ? "2026-12-01T00:00:00.000Z" : undefined)).toEqual(["main", "beats", "c", "a", "b"]);
  });

  test("a new thread lands at the top of the list, outside any folder, whoever made it", () => {
    const foldered = moveThread(createFolder(moveThread(indexOf("a", "b"), "ada", "b", { before: "a" }, noActivity), "Stories"), "ada", "a", { folder: "Stories" }, noActivity);
    const fresh: ThreadsIndex = { ...foldered, threads: [...foldered.threads, { id: "new", created_at: "2026-12-01T00:00:00.000Z", compaction: false, created_by: "character" }] };
    expect(shown(fresh)).toEqual(["main", "beats", "new", "b", "Stories/a"]);
  });

  test("home and the heartbeat thread stay at the top and can't move or go in a folder", () => {
    const foldered = createFolder(indexOf("a"), "Stories");
    expect(() => moveThread(foldered, "ada", "main", { before: "a" }, noActivity)).toThrow("stay at the top");
    expect(() => moveThread(foldered, "ada", "beats", { folder: "Stories" }, noActivity)).toThrow("stay at the top");
    expect(() => moveThread(foldered, "ada", "a", { folder: "Nowhere" }, noActivity)).toThrow("no thread folder");
  });

  test("a thread that becomes home leaves its folder's list on screen, and comes back if it stops being home", () => {
    const foldered = moveThread(createFolder(indexOf("a"), "Stories"), "ada", "a", { folder: "Stories" }, noActivity);
    expect(shown({ ...foldered, home: "a" })).toEqual(["a", "beats", "main"]);
    expect(shown(foldered)).toEqual(["main", "beats", "Stories/a"]);
  });

  test("a folder can sort by activity, keeps its hand order for when that's turned off, and folders can be reordered", () => {
    let index = createFolder(createFolder(indexOf("a", "b"), "One"), "Two");
    index = moveThread(moveThread(index, "ada", "a", { folder: "One" }, noActivity), "ada", "b", { folder: "One" }, noActivity);
    const active = (id: string): string | undefined => id === "b" ? "2026-12-01T00:00:00.000Z" : undefined;
    expect(shown(index, active)).toEqual(["main", "beats", "One/a", "One/b"]);
    const sorted = setFolderSort(index, "ada", "One", true);
    expect(shown(sorted, active)).toEqual(["main", "beats", "One/b", "One/a"]);
    expect(shown(setFolderSort(sorted, "ada", "One", false), active)).toEqual(["main", "beats", "One/a", "One/b"]);
    expect(moveFolder(index, "ada", "Two", "One").folders?.map((folder) => folder.name)).toEqual(["Two", "One"]);
    expect(moveFolder(index, "ada", "One", undefined).folders?.map((folder) => folder.name)).toEqual(["Two", "One"]);
  });

  test("folder names are unique and tidy, and deleting a folder puts its threads back without archiving any", () => {
    const index = moveThread(createFolder(indexOf("a", "b"), " Stories "), "ada", "a", { folder: "Stories" }, noActivity);
    expect(index.folders?.[0]?.name).toBe("Stories");
    expect(() => createFolder(index, "stories")).toThrow("already");
    expect(() => createFolder(index, "  ")).toThrow("needs a name");
    expect(() => renameFolder(index, "ada", "Stories", "x".repeat(65))).toThrow("at most");
    const renamed = renameFolder(index, "ada", "Stories", "Tales");
    expect(shown(renamed)).toEqual(["main", "beats", "b", "Tales/a"]);
    expect(shown(deleteFolder(renamed, "ada", "Tales"))).toEqual(["main", "beats", "b", "a"]);
    expect(deleteFolder(renamed, "ada", "Tales").threads.map((thread) => thread.id)).toEqual(["main", "beats", "a", "b"]);
  });

  test("archiving a thread takes it out of its folder for good, and the empty folder stays until deleted", async () => {
    const data = join(mkdtempSync(testTmp("shore-thread-folders-")), "data");
    await createThread(data, "ada", "side", now);
    const start = await readThreadsIndex(data, "ada");
    if (start === undefined) throw new Error("no index");
    await writeThreadsIndex(data, "ada", moveThread(createFolder(start, "Stories"), "ada", "side", { folder: "Stories" }, noActivity));
    const archived = await archiveThread(data, "ada", "side");
    expect(archived.folders).toEqual([{ name: "Stories", threads: [] }]);
    const remade = await createThread(data, "ada", "side", now);
    expect(shown(remade)).toEqual(["main", "side"]);
  });
});
