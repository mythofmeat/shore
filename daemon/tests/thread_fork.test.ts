import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { FORK_MARKER_FILE, forkThread, recoverForks, selectForkContext } from "../src/engine/fork.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { createThread, ensureThreads, readThreadsIndex } from "../src/engine/threads.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";
import { outcomeOf } from "./support/outcome.ts";

const NOW = "2026-09-05T12:00:00.000Z";

let counter = 0;

async function dataDir(): Promise<string> {
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
  test("the child holds a copy the parent can no longer change", async () => {
    const root = await dataDir();
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
    const root = await dataDir();
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
    const root = await dataDir();
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
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "context" })),
    ).toThrow(/injected/);

    await recoverForks(root, "ada");
    expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    expect(await readMessages(path)).toHaveLength(1);
  });

  test("two forks racing for the same name leave exactly one thread", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);

    const outcomes = await Promise.allSettled([
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main", "spin"]);
  });
});
