import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import {
  FORK_MARKER_FILE,
  ForkBusy,
  forkThread,
  recoverForks,
  selectForkContext,
} from "../src/engine/fork.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import {
  ThreadError,
  createThread,
  ensureThreads,
  readThreadsIndex,
  threadTurnCounts,
} from "../src/engine/threads.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { versionOf } from "../src/engine/versions.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

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
  test("no turn count copies the whole active context", () => {
    const messages = [user("u1", "one"), assistant("a1", "two"), user("u2", "three")];
    expect(selectForkContext(messages, undefined)).toHaveLength(3);
  });

  test("a turn count starts at the nth-from-last real user turn", () => {
    const messages = [
      user("u1", "one"),
      assistant("a1", "reply one"),
      user("u2", "two"),
      assistant("a2", "reply two"),
      user("u3", "three"),
      assistant("a3", "reply three"),
    ];
    expect(selectForkContext(messages, 1).map((m) => m.msg_id)).toEqual(["u3", "a3"]);
    expect(selectForkContext(messages, 2).map((m) => m.msg_id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
  });

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

  test("a leading tool result with no call in the copy is dropped, never carried orphaned", () => {
    const messages = [
      toolResult("r0", "call-0"),
      user("u1", "next"),
      assistant("a2", "reply"),
    ];
    expect(selectForkContext(messages, undefined).map((m) => m.msg_id)).toEqual(["u1", "a2"]);
  });

  test("a cut before an earlier turn keeps that turn's whole tool exchange", () => {
    const messages = [
      user("u1", "one"),
      toolUse("a1", "call-1"),
      toolResult("r1", "call-1"),
      user("u2", "two"),
      toolUse("a2", "call-2"),
      toolResult("r2", "call-2"),
      assistant("a3", "done"),
    ];
    expect(selectForkContext(messages, 1).map((m) => m.msg_id)).toEqual([
      "u2",
      "a2",
      "r2",
      "a3",
    ]);
  });

  test("asking for more turns than exist copies what there is", () => {
    const messages = [user("u1", "one"), assistant("a1", "reply")];
    expect(selectForkContext(messages, 9)).toHaveLength(2);
  });

  test("autonomous-only context is copied whole rather than silently discarded", () => {
    const messages = [
      assistant("a1", "unprompted one", { origin: "autonomous" }),
      assistant("a2", "unprompted two", { origin: "autonomous" }),
    ];
    expect(selectForkContext(messages, 1).map((m) => m.msg_id)).toEqual(["a1", "a2"]);
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

  test("the copy shares the source's message versions, so the two are the same events", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first"), assistant("a1", "reply")]);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const parent = await readMessages(path);
    const child = await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"));
    expect(parent.map(versionOf)).toEqual(child.map(versionOf));
    expect(parent.every((m) => versionOf(m) !== undefined)).toBe(true);
  });

  test("legacy messages with no version get one, shared with the copy", async () => {
    const root = await dataDir();
    await ensureThreads(root, "ada", NOW);
    const path = join(root, "ada", "threads", "main", "active.jsonl");
    await writeFile(path, `${JSON.stringify(user("u1", "legacy"))}\n`);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const parent = await readMessages(path);
    const child = await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"));
    const version = versionOf(required(parent[0]));
    expect(version).toBeDefined();
    expect(versionOf(required(child[0]))).toBe(required(version));
  });

  test("an edit on either branch gives that occurrence its own version", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);
    await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const childPath = join(root, "ada", "threads", "spin", "active.jsonl");
    const child = await MessageStore.load(childPath);
    await child.edit("u1", "diverged");

    const before = versionOf(required((await readMessages(path))[0]));
    const after = versionOf(required((await readMessages(childPath))[0]));
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("identical text typed twice stays two separate events", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "same words"), user("u2", "same words")]);
    const messages = await readMessages(path);
    expect(versionOf(required(messages[0]))).not.toBe(versionOf(required(messages[1])));
  });

  test("the child inherits compaction and the model pin but starts a fresh session", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    await createThread(root, "ada", "eval", NOW, {
      compaction: true,
      chat_model: "anthropic:opus",
    });
    await writeFile(
      join(root, "ada", "threads", "eval", "active.jsonl"),
      `${JSON.stringify(user("u9", "eval turn"))}\n`,
    );
    await writeFile(join(root, "ada", "threads", "eval", "compaction-checkpoint.json"), "{}\n");

    const result = await forkThread(root, "ada", "eval", "eval-b", { now: () => NOW });
    expect(result.child.compaction).toBe(true);
    expect(result.child.chat_model).toBe("anthropic:opus");
    expect(existsSync(join(root, "ada", "threads", "eval-b", "compaction-checkpoint.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, "ada", "threads", "eval-b", "segments"))).toBe(false);
  });

  test("images travel as references into the character's shared store, never as bytes", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [
      message({
        msg_id: "u1",
        role: "user",
        content: "look at this",
        images: [
          { path: "/data/ada/images/attachments/red.png", caption: "red", data: "BASE64BLOB" },
        ],
      }),
    ]);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const childPath = join(root, "ada", "threads", "spin", "active.jsonl");
    expect(await readFile(childPath, "utf8")).not.toContain("BASE64BLOB");
    const child = await readMessages(childPath);
    expect(required(child[0]).images).toEqual([
      { path: "/data/ada/images/attachments/red.png", caption: "red" },
    ]);
    expect(existsSync(join(root, "ada", "threads", "spin", "images"))).toBe(false);
    expect(required((await readMessages(path))[0]).images).toHaveLength(1);
  });

  test("alternatives, their timestamps and their provider metadata all travel", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [
      user("u1", "ask"),
      message({
        msg_id: "a1",
        role: "assistant",
        content: "second try",
        model: "anthropic:opus",
        provider_key: "anthropic",
        alt_index: 1,
        alt_count: 2,
        alternatives: [
          {
            content: "first try",
            images: [],
            content_blocks: [{ type: "text", text: "first try" }],
            timestamp: "2026-09-04T00:00:00.000Z",
            model: "anthropic:sonnet",
            provider_key: "anthropic",
          },
          {
            content: "second try",
            images: [],
            content_blocks: [{ type: "text", text: "second try" }],
            timestamp: NOW,
            model: "anthropic:opus",
            provider_key: "anthropic",
          },
        ],
      }),
    ]);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const copied = required(
      (await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"))).at(-1),
    );
    expect(copied.alt_index).toBe(1);
    expect(copied.alternatives).toMatchObject([
      { content: "first try", timestamp: "2026-09-04T00:00:00.000Z", model: "anthropic:sonnet" },
      { content: "second try", timestamp: NOW, model: "anthropic:opus" },
    ]);
    expect(copied.model).toBe("anthropic:opus");
    expect(copied.timestamp).toBe(NOW);
  });

  test("a multi-round tool exchange travels whole, with every result attached", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [
      user("u1", "do the thing"),
      toolUse("a1", "call-1"),
      toolResult("r1", "call-1"),
      toolUse("a2", "call-2"),
      toolResult("r2", "call-2"),
      assistant("a3", "done"),
    ]);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW, turns: 1 });

    const copied = await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"));
    expect(copied.map((m) => m.msg_id)).toEqual(["u1", "a1", "r1", "a2", "r2", "a3"]);
  });

  test("each thread counts its own transcript", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [
      user("u1", "one"),
      assistant("a1", "reply"),
      user("u2", "two"),
      assistant("a2", "reply"),
    ]);

    await forkThread(root, "ada", "main", "spin", { now: () => NOW, turns: 1 });
    expect(await threadTurnCounts(root, "ada", ["main", "spin"])).toEqual(
      new Map([
        ["main", 2],
        ["spin", 1],
      ]),
    );
  });

  test("creating the child leaves home alone and records where it came from", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    const result = await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    expect(result.index.home).toBe("main");
    expect(result.child.forked_from).toMatchObject({
      source: "main",
      fork_id: result.fork.fork_id,
      messages: 1,
      turns: 1,
    });
    const published = (await readThreadsIndex(root, "ada"))?.threads.find((t) => t.id === "spin");
    expect(published?.forked_from?.source).toBe("main");
    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(false);
  });

  test("provenance survives in the character's durable record", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first"), assistant("a1", "reply")]);
    const result = await forkThread(root, "ada", "main", "spin", { now: () => NOW });

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      expect(store.forkOf("ada", result.fork.fork_id)).toMatchObject({
        child: "spin",
        source: "main",
        message_count: 2,
      });
    } finally {
      store.close();
    }
  });

  test("a fork of a fork resolves its whole ancestry without the parents' directories", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    await forkThread(root, "ada", "spin", "spin-2", { now: () => NOW });
    await rm(join(root, "ada", "threads", "spin"), { recursive: true, force: true });

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      expect(store.forkAncestry("ada", "spin-2").map((f) => `${f.source}->${f.child}`)).toEqual([
        "spin->spin-2",
        "main->spin",
      ]);
    } finally {
      store.close();
    }
  });

  test("an existing destination, a bad id and a self-fork are all refused", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    await createThread(root, "ada", "taken", NOW);

    for (const [source, child, kind] of [
      ["main", "taken", "exists"],
      ["main", "../escape", "invalid_id"],
      ["main", "main", "exists"],
      ["ghost", "spin", "not_found"],
    ] as const) {
      try {
        await forkThread(root, "ada", source, child, { now: () => NOW });
        throw new Error(`expected a rejection for ${source} -> ${child}`);
      } catch (e) {
        expect((e as ThreadError).kind).toBe(kind);
      }
    }
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual([
      "main",
      "taken",
    ]);
  });

  test("a directory that already holds data is never overwritten", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    const squatter = join(root, "ada", "threads", "spin");
    await mkdir(squatter, { recursive: true });
    await writeFile(join(squatter, "active.jsonl"), "keep me\n");

    expect(forkThread(root, "ada", "main", "spin", { now: () => NOW })).rejects.toThrow(
      /already holds data/,
    );
    expect(await readFile(join(squatter, "active.jsonl"), "utf8")).toBe("keep me\n");
  });

  test("a compaction mid-flight anywhere in the character answers busy", async () => {
    for (const busyKey of ["ada", "ada/other"]) {
      const root = await dataDir();
      await seed(root, "ada", "main", [user("u1", "first")]);
      await createThread(root, "ada", "other", NOW);
      const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
      store.beginCompaction(
        busyKey,
        { file: HISTORY_DB_FILE, message_count: 1, compacted_at: NOW },
        [user("u0", "archived")],
        "before",
        "after",
      );
      store.close();

      await forkThread(root, "ada", "main", "spin", { now: () => NOW }).then(
        () => {
          throw new Error(`expected busy while ${busyKey} was compacting`);
        },
        (e: unknown) => {
          expect(e).toBeInstanceOf(ForkBusy);
        },
      );
      expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    }
  });
});

describe("recovering an interrupted fork", () => {
  test("a failure before the registry publishes leaves no child and no provenance", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "provenance" }),
    ).rejects.toThrow(/injected/);

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

  test("a failure between publishing and clearing the marker keeps the child", async () => {
    const root = await dataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "publish" }),
    ).rejects.toThrow(/injected/);

    expect(await recoverForks(root, "ada")).toEqual(["spin"]);
    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(false);
    expect(await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"))).toHaveLength(1);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main", "spin"]);
  });

  test("a crash before the context is written leaves the source untouched", async () => {
    const root = await dataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "context" }),
    ).rejects.toThrow(/injected/);

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
