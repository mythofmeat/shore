import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookPathIn, forgetThreadSessions, readBook, sessionKey, writeBook, SESSION_BOOK_VERSION, type SessionRecord } from "../src/llm/providers/agent_sessions.ts";
import { pruneSdkSessions } from "../src/llm/providers/agent_session_retention.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import { DIAGNOSTIC_RETENTION_MS } from "../src/storage/retention.ts";
import { pack, withStorage } from "../src/storage/store.ts";

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

test("an unreadable session book prevents transcript deletion", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(f.prune(start)).toBe(0);
  withStorage(f.data, db => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack("{}")));
  expect(() => f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toThrow("Invalid SDK session references");
  expect(existsSync(f.local(id))).toBe(true);
});
