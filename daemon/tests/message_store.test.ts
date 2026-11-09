import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { backupDirFor, resetBackupThrottle } from "../src/engine/backup.ts";
import { MessageStore, normalizeMessage, withoutOrphanToolResults } from "../src/engine/message_store.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import { appendDurableLine, listDurableFiles, readDurable } from "../src/storage/files.ts";
import { databasePath } from "../src/storage/store.ts";
import { rejectionOf } from "./support/outcome.ts";

const INTERRUPTED = "Tool execution was interrupted by a Shore daemon restart before it returned a result.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetBackupThrottle();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shore-message-store-"));
  cleanups.push(async () => await rm(dir, { recursive: true, force: true }));
  return join(dir, "ada", "threads", "main", "active.jsonl");
}

function seed(path: string, text: string): void {
  for (const line of text.match(/[^\n]*\n/g) ?? []) appendDurableLine(path, line);
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });
const use = (id: string): ContentBlock => ({ type: "tool_use", id, name: "activity", input: {} });
const result = (id: string, content = `result of ${id}`): ContentBlock => ({ type: "tool_result", tool_use_id: id, content });

function message(id: string, role: Role, blocks: ContentBlock[], extra: Partial<Message> = {}): Message {
  return normalizeMessage({ msg_id: id, role, content: id, images: [], content_blocks: blocks, timestamp: "2026-08-27T00:00:00Z", ...extra });
}

const lines = (messages: readonly Message[]): string => messages.map((m) => `${JSON.stringify(m)}\n`).join("");

async function storeWith(messages: readonly Message[]): Promise<{ store: MessageStore; path: string }> {
  const path = await storePath();
  seed(path, lines(messages));
  return { store: await MessageStore.load(path), path };
}

async function logged<T>(level: "error" | "warn", run: () => Promise<T>): Promise<{ value: T; said: string[] }> {
  const spy = spyOn(console, level).mockImplementation(() => {});
  try {
    const value = await run();
    return { value, said: spy.mock.calls.map((call) => String(call[0])) };
  } finally {
    spy.mockRestore();
  }
}

describe("dropping tool results nothing asked for", () => {
  test("a result whose call isn't in the message before it is dropped, and the rest of that message kept with its text rebuilt", () => {
    const asked = message("a1", "assistant", [use("t1")]);
    const answered = message("u1", "user", [result("t1", "first"), result("t9", "stray"), text("and a note")]);
    const [first, second] = withoutOrphanToolResults([asked, answered]);
    expect(first).toBe(asked);
    expect(second?.content_blocks).toEqual([result("t1", "first"), text("and a note")]);
    expect(second?.content).toContain("first");
    expect(second?.content).not.toContain("stray");
    expect(second?.version).not.toBe(answered.version);
  });

  test("a message whose results all answer calls is kept as it is, and one holding only stray results goes", () => {
    const asked = message("a1", "assistant", [use("t1"), use("t2")]);
    const answered = message("u1", "user", [result("t1"), result("t2")]);
    const kept = withoutOrphanToolResults([asked, answered, message("u2", "user", [result("t3")])]);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBe(answered);
  });
});

describe("recovering a tool loop a restart cut short", () => {
  test("only the newest reply's unanswered calls get an interrupted result, even when an earlier round used the same ids", async () => {
    const { store, path } = await storeWith([
      message("q", "user", [text("go")]),
      message("a1", "assistant", [use("call_0")]),
      message("r1", "user", [result("call_0")]),
      message("a2", "assistant", [use("call_0"), use("call_1")]),
      message("r2", "user", [result("call_1")]),
    ]);
    expect(await store.recoverInterruptedToolLoop("m_recovered", "2026-08-27T00:05:00Z")).toBe(1);
    const recovered = store.messages().at(-1);
    expect(recovered?.msg_id).toBe("m_recovered");
    expect(recovered?.content_blocks).toEqual([{ type: "tool_result", tool_use_id: "call_0", content: INTERRUPTED, is_error: true }]);
    expect(recovered?.content).toContain(INTERRUPTED);
    expect((await MessageStore.load(path)).messages().at(-1)?.msg_id).toBe("m_recovered");
  });

  test("nothing is added, and the file is left alone, when the newest reply's calls are answered, it called no tools, or there is no reply yet", async () => {
    for (const history of [
      [message("q", "user", [text("go")]), message("a", "assistant", [use("t1")]), message("r", "user", [result("t1")])],
      [message("q", "user", [text("go")]), message("a", "assistant", [text("hi")])],
      [message("q", "user", [text("go")])],
    ]) {
      const { store, path } = await storeWith(history);
      expect(await store.recoverInterruptedToolLoop("m", "2026-08-27T00:05:00Z")).toBe(0);
      expect(store.messages()).toHaveLength(history.length);
      expect(listDurableFiles(backupDirFor(path))).toEqual([]);
    }
  });

  test("changes started together each land", async () => {
    const { store, path } = await storeWith(["a", "b", "c"].map((id) => message(id, "user", [text(id)])));
    await Promise.all([store.deleteAll(["a"]), store.deleteAll(["b"])]);
    expect(store.messages().map((m) => m.msg_id)).toEqual(["c"]);
    expect((await MessageStore.load(path)).messages().map((m) => m.msg_id)).toEqual(["c"]);
  });
});

describe("loading a conversation file", () => {
  test("unreadable lines are set aside and reported, blank lines skipped, and the next write rewrites the file whole", async () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => message(id, "user", [text(id)]));
    const path = await storePath();
    seed(path, `${lines([a as Message])}\nnot json\n${lines([b as Message])}`);
    const { value: store, said } = await logged("error", () => MessageStore.load(path));
    expect(store.quarantinedLines).toBe(1);
    expect(store.messages().map((m) => m.msg_id)).toEqual(["a", "b"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^shore: 1 unreadable line\(s\) in .*active\.jsonl were quarantined to .*active\.jsonl\.quarantine\.[^;]+; 2 message\(s\) loaded$/);
    const quarantine = /quarantined to (.*);/.exec(said[0] ?? "")?.[1] ?? "";
    expect(readDurable(quarantine)).toBe("not json\n");
    await store.append(c as Message);
    expect(readDurable(path).split("\n").map((line) => (line === "" ? "" : (JSON.parse(line) as Message).msg_id))).toEqual(["a", "b", "c", ""]);
  });

  test("a sound file says nothing and sets nothing aside", async () => {
    const path = await storePath();
    seed(path, lines([message("a", "user", [text("a")])]));
    const errors = await logged("error", () => MessageStore.load(path));
    const warnings = await logged("warn", () => MessageStore.load(path));
    expect([errors.said, warnings.said]).toEqual([[], []]);
    expect(errors.value.quarantinedLines).toBe(0);
    expect(errors.value.alternativeDefects).toEqual([]);
    expect(listDurableFiles(backupDirFor(path))).toEqual([]);
  });

  test("a reply whose alternatives are damaged is reported and its defects kept", async () => {
    const path = await storePath();
    const alternatives = [
      { content: "", content_blocks: [], images: [], timestamp: "2026-08-27T00:00:00Z" },
      { content: "fine", content_blocks: [text("fine")], images: [], timestamp: "2026-08-27T00:01:00Z" },
    ];
    seed(path, lines([message("q", "user", [text("go")]), message("a", "assistant", [text("fine")], { alternatives, alt_index: 1, alt_count: 2 })]));
    const { value: store, said } = await logged("warn", () => MessageStore.load(path));
    expect(store.alternativeDefects).toEqual([{ msg_id: "a", alt_index: 0, kind: "empty" }]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("empty");
  });

  test("a missing file is an empty conversation, but a store that can't be read is an error", async () => {
    const path = await storePath();
    expect((await MessageStore.load(path)).messages()).toEqual([]);
    const unreadable = await storePath();
    await mkdir(databasePath(dirname(dirname(dirname(dirname(unreadable))))), { recursive: true });
    const failure = await rejectionOf(MessageStore.load(unreadable));
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
  });
});
