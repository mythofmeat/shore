import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookPathIn, forgetThreadSessions, readBook, sessionKey, writeBook, writeSession, SESSION_BOOK_VERSION, type SessionRecord } from "../src/llm/providers/agent_sessions.ts";
import { pruneSdkSessions } from "../src/llm/providers/agent_session_retention.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import { DIAGNOSTIC_RETENTION_MS } from "../src/storage/retention.ts";
import { pack, readState, withStorage, writeState } from "../src/storage/store.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { writeDurable } from "../src/storage/files.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const start = Date.parse("2026-09-10T12:00:00Z");
const record = (sessionId: string, parent?: string): SessionRecord => ({
  version: SESSION_BOOK_VERSION, sessionId, entries: parent === undefined ? [] : [{ hash: "hash", uuid: "anchor", sessionId: parent }],
});

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "shore-sdk-retention-"));
  roots.push(data);
  const config = join(data, "claude");
  const project = join(config, "projects", "-tmp");
  mkdirSync(project, { recursive: true });
  const book = bookPathIn(data);
  const key = sessionKey("ada", "", "main");
  const local = (id: string) => join(project, `${id}.jsonl`);
  const mirror = nativeHistoryStore(book, key);
  const add = async (id: string) => {
    writeFileSync(local(id), "diagnostic transcript");
    mkdirSync(join(project, id, "subagents"), { recursive: true });
    writeFileSync(join(project, id, "subagents", "agent.jsonl"), "subagent diagnostics");
    await mirror.append({ projectKey: "-tmp", sessionId: id }, [{ type: "user", uuid: randomUUID(), timestamp: "2000-01-01T00:00:00Z" }]);
    await mirror.append({ projectKey: "-tmp", sessionId: id, subpath: "subagents/agent" }, [{ type: "assistant", uuid: randomUUID() }]);
  };
  const prune = (now: number) => pruneSdkSessions(data, now - DIAGNOSTIC_RETENTION_MS, now, config);
  return { data, config, project, book, key, local, mirror, add, prune };
}

test("retirement starts a full 30-day grace period and removes both copies and subagent files", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  writeBook(f.book, { [f.key]: record(id) }, start);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 2)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DIAGNOSTIC_RETENTION_MS * 2);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 3)).toBe(0);
  expect(existsSync(f.local(id))).toBe(true);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 3 + 1)).toBe(1);
  expect(existsSync(f.local(id))).toBe(false);
  expect(existsSync(join(f.project, id))).toBe(false);
  expect(await f.mirror.load({ projectKey: "-tmp", sessionId: id })).toBeNull();
  expect(await f.mirror.load({ projectKey: "-tmp", sessionId: id, subpath: "subagents/agent" })).toBeNull();
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 4)).toBe(0);
});

test("fork ancestors and other threads remain live; reactivation resets the grace period", async () => {
  const f = fixture();
  const parent = randomUUID(), child = randomUUID(), other = randomUUID();
  for (const id of [parent, child, other]) await f.add(id);
  const otherKey = sessionKey("ada", "", "other");
  writeBook(f.book, { [f.key]: record(parent), [otherKey]: record(other) }, start);
  writeBook(f.book, { [f.key]: record(child, parent), [otherKey]: record(other) }, start);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 2)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DIAGNOSTIC_RETENTION_MS * 2);
  writeBook(f.book, { ...readBook(f.book), [f.key]: record(child, parent) }, start + DIAGNOSTIC_RETENTION_MS * 2 + 1);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 4)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DIAGNOSTIC_RETENTION_MS * 4);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 5 + 1)).toBe(2);
  expect(existsSync(f.local(other))).toBe(true);
});

test("unreferenced mirrors get a grace period; unrelated SDK files and symlink targets remain untouched", async () => {
  const f = fixture();
  const orphan = randomUUID(), unrelated = randomUUID();
  await f.add(orphan);
  writeFileSync(f.local(unrelated), "another application's session");
  const outside = join(f.data, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, `${orphan}.jsonl`), "outside target");
  symlinkSync(outside, join(f.config, "projects", "linked-project"));
  writeState(f.data, "ada/memory.md", "memory", "ada");
  expect(f.prune(start)).toBe(0);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toBe(1);
  expect(existsSync(f.local(unrelated))).toBe(true);
  expect(existsSync(join(outside, `${orphan}.jsonl`))).toBe(true);
  expect(readState(f.data, "ada/memory.md", "ada")).toBe("memory");
});

test("an unreadable session book prevents transcript deletion", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(f.prune(start)).toBe(0);
  withStorage(f.data, db => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack("{}")));
  expect(() => f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toThrow("Invalid SDK session references");
  expect(existsSync(f.local(id))).toBe(true);
});

test("a turn finishing after compaction cannot reactivate its retired session", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  const before = record(id);
  writeBook(f.book, { [f.key]: before }, start);
  forgetThreadSessions(f.data, "ada", "main", start);
  writeSession(f.book, f.key, { ...before, pendingAssistantUuids: ["late reply"] }, { record: before });
  expect(readBook(f.book)[f.key]).toBeUndefined();
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toBe(1);
});

test("local deletion failures preserve the database copy and retry on the next sweep", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  f.prune(start);
  rmSync(f.local(id));
  mkdirSync(f.local(id));
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toBe(0);
  expect(await f.mirror.load({ projectKey: "-tmp", sessionId: id })).not.toBeNull();
  rmSync(f.local(id), { recursive: true });
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS + 2)).toBe(1);
});

test.each([0, 1])("clearing or compacting retires sessions immediately (retained messages: %s)", async keep => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  writeBook(f.book, { [f.key]: record(id) }, start);
  const dir = join(f.data, "ada", "threads", "main");
  const content = ["user", "assistant"].map((role, i) => JSON.stringify({ msg_id: `m${i}`, role, content: "text", images: [], content_blocks: [], timestamp: new Date(start).toISOString() })).join("\n") + "\n";
  writeDurable(join(dir, "active.jsonl"), content);
  await archiveAndRetain(dir, keep, content, () => new Date(start).toISOString(), randomUUID, undefined,
    { dbPath: join(f.data, "shore.db"), archiveKey: "ada" });
  expect(readBook(f.book)[f.key]).toBeUndefined();
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS)).toBe(0);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toBe(1);
});
