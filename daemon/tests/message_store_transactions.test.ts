import { withStorage } from "../src/storage/store.ts";
import { readFile } from "./support/stored_files.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupBeforeWrite, resetBackupThrottle } from "../src/engine/backup.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import {
  MessageStore,
  normalizeMessage,
  type MessageStoreIo,
} from "../src/engine/message_store.ts";
import type { Message, MessageAlternative, Role } from "../src/engine/types.ts";

type FailureStage = "backup" | "write" | "rename";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetBackupThrottle();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

async function workspace(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shore-message-transaction-"));
  cleanups.push(async () => await rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "threads", "main", "active.jsonl") };
}

function message(id: string, role: Role, content: string, minute: number): Message {
  return normalizeMessage({
    msg_id: id,
    role,
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    timestamp: `2026-08-27T00:${String(minute).padStart(2, "0")}:00Z`,
  });
}

function alternative(content: string, minute: number): MessageAlternative {
  return {
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    timestamp: `2026-08-27T00:${String(minute).padStart(2, "0")}:00Z`,
  };
}

function answer(id: string, minute: number): Message {
  const alternatives = [
    alternative(`${id} original`, minute),
    alternative(`${id} alternate`, minute + 1),
  ];
  return normalizeMessage({
    ...message(id, "assistant", alternatives[0]?.content ?? "", minute),
    alt_index: 0,
    alt_count: alternatives.length,
    alternatives,
  });
}

const initialMessages = (): Message[] => [
  message("u1", "user", "first question", 1),
  answer("a1", 2),
  message("u2", "user", "second question", 4),
  answer("a2", 5),
];

const wire = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key: string, entry: unknown) =>
    key === "version" ? undefined : entry,
  );

function faultInjectingIo(): {
  io: MessageStoreIo;
  failAt(stage: FailureStage | undefined): void;
} {
  let failure: FailureStage | undefined;
  return {
    failAt: (stage) => {
      failure = stage;
    },
    io: {
      backup: async (path) => {
        if (failure === "backup") throw new Error("injected backup failure");
        await backupBeforeWrite(path);
      },
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      writeFile: async (path, contents) => {
        await writeFile(path, contents, "utf8");
        if (failure === "write") throw new Error("injected write failure");
      },
      rename: async (from, to) => {
        if (failure === "rename") throw new Error("injected rename failure");
        await rename(from, to);
      },
      remove: async (path) => {
        await rm(path, { force: true });
      },
      tempPath: (dir) => join(dir, `.${crypto.randomUUID()}.tmp`),
    },
  };
}

async function seededStore(path: string, io: MessageStoreIo): Promise<MessageStore> {
  const store = MessageStore.create(path, io);
  for (const seed of initialMessages()) await store.append(seed);
  return store;
}

interface MutationCase {
  name: string;
  run(store: MessageStore): Promise<unknown>;
}

const mutations: MutationCase[] = [
  { name: "clear", run: async (store) => await store.clear() },
  {
    name: "append",
    run: async (store) => await store.append(message("failed-append", "user", "lost", 10)),
  },
  {
    name: "insert by timestamp",
    run: async (store) =>
      await store.insertByTimestamp(message("failed-insert", "user", "lost", 3)),
  },
  { name: "edit", run: async (store) => await store.edit("u1", "failed edit") },
  {
    name: "truncate after the last user turn",
    run: async (store) => await store.truncateAfterLastUserTurn(),
  },
  {
    name: "replace after the last user turn",
    run: async (store) =>
      await store.replaceAfterLastUserTurn([
        message("failed-replacement", "assistant", "lost", 10),
      ]),
  },
  { name: "delete", run: async (store) => await store.delete("a1") },
  { name: "delete all", run: async (store) => await store.deleteAll(["a1", "u2"]) },
  { name: "set alternate metadata", run: async (store) => await store.setAlt("a1", 1, 3) },
  { name: "add alternate candidate", run: async (store) => await store.addAltCandidate("a1") },
  { name: "select alternate", run: async (store) => await store.selectAlt("a2", 1) },
];

describe("transactional message mutations", () => {
  for (const mutation of mutations) {
    for (const stage of ["backup", "write", "rename"] as const) {
      test(`${mutation.name} leaves no trace after a ${stage} failure`, async () => {
        const { dir, path } = await workspace();
        const injected = faultInjectingIo();
        const store = await seededStore(path, injected.io);
        const beforeMessages = structuredClone(store.messages());
        const beforeFile = await readFile(path, "utf8");

        injected.failAt(stage);
        expect(mutation.run(store)).rejects.toThrow(`injected ${stage} failure`);

        expect(wire(store.messages())).toEqual(wire(beforeMessages));
        expect(await readFile(path, "utf8")).toBe(beforeFile);
        expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

        injected.failAt(undefined);
        const recovery = message("recovery", "user", "saved afterward", 20);
        await store.append(recovery);

        const reloaded = await MessageStore.load(path);
        expect(wire(reloaded.messages())).toEqual(wire([...beforeMessages, recovery]));
      });
    }
  }
});

describe("concurrent message mutations", () => {
  test("wait for the preceding commit and preserve call order", async () => {
    const { path } = await workspace();
    let releaseFirst!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let shouldBlock = false;
    let writes = 0;
    let activeWrites = 0;
    let mostActiveWrites = 0;

    const io: MessageStoreIo = {
      backup: async (target) => {
        await backupBeforeWrite(target);
      },
      mkdir: async (target) => {
        await mkdir(target, { recursive: true });
      },
      writeFile: async (target, contents) => {
        writes += 1;
        activeWrites += 1;
        mostActiveWrites = Math.max(mostActiveWrites, activeWrites);
        try {
          if (shouldBlock) {
            shouldBlock = false;
            firstWriteStarted();
            await released;
          }
          await writeFile(target, contents, "utf8");
        } finally {
          activeWrites -= 1;
        }
      },
      rename,
      remove: async (target) => await rm(target, { force: true }),
      tempPath: (dir) => join(dir, `.${crypto.randomUUID()}.tmp`),
    };

    const store = MessageStore.create(path, io);
    await store.append(message("u1", "user", "seed", 1));
    shouldBlock = true;
    const first = store.append(message("u2", "user", "first", 2));
    await started;
    const second = store.append(message("u3", "user", "second", 3));

    expect(store.messages().map((item) => item.msg_id)).toEqual(["u1"]);
    expect(writes).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);

    expect(mostActiveWrites).toBe(1);
    expect(store.messages().map((item) => item.msg_id)).toEqual(["u1", "u2", "u3"]);
    const reloaded = await MessageStore.load(path);
    expect(reloaded.messages().map((item) => item.msg_id)).toEqual(["u1", "u2", "u3"]);
  });
});

test("a failed store commit does not advance the conversation revision", async () => {
  const { dir } = await workspace();
  const characterDir = join(dir, "ada");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const engine = await ConversationEngine.load("ada", dir);
  await engine.appendMessage(message("u1", "user", "saved", 1));
  const beforeMessages = structuredClone(engine.messages());
  const beforeRevision = engine.currentRevision();
  const beforeFile = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

  withStorage(dir, (db) => db.run("CREATE TRIGGER refuse_state BEFORE INSERT ON state_lines BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END"));

  expect(
    engine.appendMessage(message("failed-append", "user", "must not appear", 2)),
  ).rejects.toThrow();

  expect(engine.currentRevision()).toBe(beforeRevision);
  expect(wire(engine.messages())).toEqual(wire(beforeMessages));
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(beforeFile);
});
