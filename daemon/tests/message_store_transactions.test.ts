import { fileScope } from "../src/storage/files.ts";
import { withStorage } from "../src/storage/store.ts";
import { readFile } from "./support/stored_files.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetBackupThrottle } from "../src/engine/backup.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import {
  MessageStore,
  normalizeMessage,
} from "../src/engine/message_store.ts";
import type { Message, MessageAlternative, Role } from "../src/engine/types.ts";
import { outcomeOf } from "./support/outcome.ts";


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

async function seededStore(path: string): Promise<MessageStore> {
  const store = MessageStore.create(path);
  for (const seed of initialMessages()) await store.append(seed);
  return store;
}

interface MutationCase {
  name: string;
  run(store: MessageStore): Promise<unknown>;
}

const mutations: MutationCase[] = [
  {
    name: "append",
    run: async (store) => await store.append(message("failed-append", "user", "lost", 10)),
  },
  { name: "edit", run: async (store) => await store.edit("u1", "failed edit") },
  {
    name: "replace after the last user turn",
    run: async (store) =>
      await store.replaceAfterLastUserTurn([
        message("failed-replacement", "assistant", "lost", 10),
      ]),
  },
  { name: "delete all", run: async (store) => await store.deleteAll(["a1", "u2"]) },
  { name: "select alternate", run: async (store) => await store.selectAlt("a2", 1) },
];

describe("transactional message mutations", () => {
  for (const mutation of mutations) {
    test(`${mutation.name} preserves memory and storage after a database failure`, async () => {
      const { path } = await workspace();
      const store = await seededStore(path);
      const beforeMessages = structuredClone(store.messages());
      const beforeFile = await readFile(path, "utf8");
      const { data, key } = fileScope(path);
      withStorage(data, db => {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          const record = operation === "DELETE" ? "OLD" : "NEW";
          db.run(`CREATE TRIGGER refuse_${operation} BEFORE ${operation} ON state_lines
            WHEN ${record}.path = '${key}' BEGIN SELECT RAISE(ABORT, 'injected database failure'); END`);
        }
      });
      expect(await outcomeOf(mutation.run(store))).toThrow("injected database failure");
      expect(wire(store.messages())).toEqual(wire(beforeMessages));
      expect(await readFile(path, "utf8")).toBe(beforeFile);
      withStorage(data, db => {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) db.run(`DROP TRIGGER refuse_${operation}`);
      });
      const recovery = message("recovery", "user", "saved afterward", 20);
      await store.append(recovery);
      const reloaded = await MessageStore.load(path);
      expect(wire(reloaded.messages())).toEqual(wire([...beforeMessages, recovery]));
    });
  }
});

test("concurrent message mutations preserve call order across reload", async () => {
  const { path } = await workspace();
  const store = MessageStore.create(path);
  await store.append(message("u1", "user", "seed", 1));
  await Promise.all([
    store.append(message("u2", "user", "first", 2)),
    store.append(message("u3", "user", "second", 3)),
    store.edit("u2", "edited"),
  ]);
  const reloaded = await MessageStore.load(path);
  expect(reloaded.messages().map(item => item.msg_id)).toEqual(["u1", "u2", "u3"]);
  expect(reloaded.messages()[1]?.content).toBe("edited");
  expect(reloaded.messages()).toEqual(store.messages());
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
    await outcomeOf(engine.appendMessage(message("failed-append", "user", "must not appear", 2))),
  ).toThrow();

  expect(engine.currentRevision()).toBe(beforeRevision);
  expect(wire(engine.messages())).toEqual(wire(beforeMessages));
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(beforeFile);
});
