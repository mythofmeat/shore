import { Server } from "../src/swp/server.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { exportUnifiedDatabase, importUnifiedDatabase } from "../src/storage/archive.ts";
import { sessionKey } from "../src/llm/providers/agent_sessions.ts";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./support/tmp.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import { pack, databasePath, withStorage } from "../src/storage/store.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { ConversationEngine, type History } from "../src/engine/conversation.ts";

const message = (id: string) => ({ msg_id: id, role: "user" as const, content: id, images: [], content_blocks: [], timestamp: "2026-01-01T00:00:00Z" });

test("a tiny SDK append writes only the new entry, irrespective of the saved transcript", async () => {
  const data = await mkdtemp(testTmp("transcript-amplification-"));
  const store = nativeHistoryStore(join(data, "sessions.json"), sessionKey("ada", "", "main"));
  const key = { projectKey: "", sessionId: "session" };
  await store.append(key, [{ type: "user", uuid: "big", content: randomBytes(1024 * 1024).toString("base64") }]);
  withStorage(data, (db) => {
    db.run("CREATE TABLE audit_bytes(n INTEGER); CREATE TRIGGER audit_state_update AFTER UPDATE ON state_files BEGIN INSERT INTO audit_bytes VALUES(length(new.content)); END;");
    if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'state_lines'").get() !== null) {
      db.run("CREATE TRIGGER audit_line_insert AFTER INSERT ON state_lines BEGIN INSERT INTO audit_bytes VALUES(length(new.content)); END;");
    }
  });
  await store.append(key, [{ type: "assistant", uuid: "tiny", content: "ok" }]);
  const bytes = withStorage(data, db => (db.query("SELECT coalesce(sum(n), 0) AS n FROM audit_bytes").get() as { n: number }).n);
  expect(bytes).toBeLessThan(4096);
  expect((await store.load(key))?.map(entry => entry.uuid)).toEqual(["big", "tiny"]);
});

test("appending a message does not clone existing message payloads", async () => {
  const data = await mkdtemp(testTmp("active-amplification-"));
  const store = MessageStore.create(join(data, "ada", "threads", "main", "active.jsonl"));
  await store.append(message("old"));
  let reads = 0;
  Object.defineProperty(store.messages()[0], "content", { enumerable: true, get: () => { reads += 1; return "old"; } });
  await store.append(message("new"));
  expect(reads).toBe(0);
});

test("ordinary history broadcasts contain a bounded suffix instead of the whole conversation", async () => {
  const data = await mkdtemp(testTmp("snapshot-amplification-"));
  const frames: History[] = [];
  const engine = await ConversationEngine.load("ada", data, history => frames.push(history));
  for (let i = 0; i < 40; i += 1) await engine.appendMessage(message(String(i)));
  expect(frames.at(-1)?.messages.length).toBeLessThan(4);
});

test("history deltas reconstruct the same display through tool results and tail replacement", async () => {
  const data = await mkdtemp(testTmp("delta-reconstruction-"));
  let display: History["messages"] = [];
  const engine = await ConversationEngine.load("ada", data, history => {
    if (history.delta === undefined) display = history.messages;
    else {
      const after = history.delta.after;
      const keep = after === null ? 0 : display.findIndex(entry => entry.msg_id === after) + 1;
      if (after !== null) expect(keep).toBeGreaterThan(0);
      display = [...display.slice(0, keep), ...history.messages];
    }
  });
  const user = { ...message("user"), content_blocks: [{ type: "text" as const, text: "hello" }] };
  const tool = { ...message("tool"), role: "assistant" as const, content_blocks: [{ type: "tool_use" as const, id: "call", name: "dice_roll", input: {} }] };
  const result = { ...message("result"), content_blocks: [{ type: "tool_result" as const, tool_use_id: "call", content: "6" }] };
  const final = { ...message("final"), role: "assistant" as const, content_blocks: [{ type: "text" as const, text: "six" }] };
  await engine.appendMessage(user);
  await engine.appendMessage(tool);
  await engine.appendMessage(result);
  await engine.replaceAfterLastUserTurn([tool, result, final]);
  expect(display).toEqual(engine.historySnapshot({}).messages);
  await engine.appendMessage({ ...user, msg_id: "next" });
  expect(display).toEqual(engine.historySnapshot({}).messages);
});

test("SDK rows preserve idempotent updates and unkeyed entries after legacy migration", async () => {
  const data = await mkdtemp(testTmp("transcript-migration-"));
  const store = nativeHistoryStore(join(data, "sessions.json"), sessionKey("ada", "", "main"));
  const key = { projectKey: "", sessionId: "session" };
  await store.append(key, [{ type: "user", uuid: "first", content: "old" }]);
  withStorage(data, db => {
    const path = (db.query("SELECT path FROM state_files WHERE path LIKE 'sdk_transcripts/%'").get() as { path: string }).path;
    db.query("DELETE FROM state_files WHERE path = ?1").run(path);
    db.query("INSERT INTO state_files VALUES (?1, ?2, ?3)").run(path, "ada", pack(JSON.stringify([{ type: "user", uuid: "first", content: "old" }])));
  });

  await store.append(key, [{ type: "assistant", uuid: "second" }, { type: "tag" }]);
  await store.append(key, [{ type: "user", uuid: "first", content: "revised" }, { type: "tag" }]);
  expect(await store.load(key)).toEqual([
    { type: "user", uuid: "first", content: "revised" }, { type: "assistant", uuid: "second" }, { type: "tag" }, { type: "tag" },
  ]);
});

test("archive export and import retain row-backed active messages and SDK transcripts", async () => {
  const data = await mkdtemp(testTmp("row-export-"));
  const target = await mkdtemp(testTmp("row-import-"));
  const engine = await ConversationEngine.load("ada", data);
  await engine.appendMessage(message("saved"));
  const owner = sessionKey("ada", "", "main");
  const key = { projectKey: "", sessionId: "session" };
  await nativeHistoryStore(join(data, "sessions.json"), owner).append(key, [{ type: "user", uuid: "saved" }]);
  const archive = join(data, "export.db");
  exportUnifiedDatabase(databasePath(data), "ada", archive);
  importUnifiedDatabase(databasePath(target), archive, "ada");
  expect((await ConversationEngine.load("ada", target)).messages().map(entry => entry.msg_id)).toEqual(["saved"]);
  expect(await nativeHistoryStore(join(target, "sessions.json"), owner).load(key)).toEqual([{ type: "user", uuid: "saved" }]);
});

test("delta-capable clients receive suffixes while legacy clients receive full snapshots", async () => {
  const data = await mkdtemp(testTmp("delta-clients-"));
  const server = new Server({ addr: "127.0.0.1:0", serverName: "test", authenticate: () => true });
  const engine = await ConversationEngine.load("ada", data, history => server.broadcast({ type: "history", ...history } as ServerMessage));
  await engine.appendMessage(message("one"));
  await engine.appendMessage(message("two"));
  server.setHandshakeProvider({
    hello: async () => ({ characters: [{ name: "ada" }] }),
    history: async () => ({ messages: engine.historySnapshot({}).messages as unknown as import("../src/protocol/Message.ts").Message[], config: {}, activeStart: 0, selectedCharacter: "ada", selectedThread: "main", revision: engine.currentRevision() }),
  });
  const modern = await server.attachLocal({ clientType: "test", clientName: "modern", character: "ada", thread: "main", capabilities: ["history-deltas"] });
  const legacy = await server.attachLocal({ clientType: "test", clientName: "legacy", character: "ada", thread: "main" });
  try {
    const modernEvents = modern.events();
    const legacyEvents = legacy.events();
    await modernEvents.next();
    await legacyEvents.next();
    await engine.appendMessage(message("three"));
    const delta = (await modernEvents.next()).value;
    const full = (await legacyEvents.next()).value;
    expect(delta?.type === "history" && (delta.delta !== undefined && delta.delta !== null) && delta.messages.length === 2).toBe(true);
    expect(full?.type === "history" && (full.delta === undefined || full.delta === null) && full.messages.length === 3).toBe(true);
  } finally {
    await modern.detach();
    await legacy.detach();
    server.stop();
  }
});

test("history media is sent once per connection and resupplied with a synchronization snapshot", async () => {
  const { HistoryMediaDelivery } = await import("../src/swp/history_media.ts");
  const delivery = new HistoryMediaDelivery();
  const snapshot: ServerMessage = {
    type: "history", messages: [{ ...message("picture"), images: [{ path: "stable-id", data: "aW1hZ2U=" }] }], config: {}, revision: 1,
  };
  const first = delivery.prepare(snapshot);
  const delta = delivery.prepare({ ...snapshot, revision: 2, delta: { base_revision: 1, after: null } });
  const reset = delivery.prepare(snapshot);
  expect(first.type === "history" && first.messages[0]?.images[0]?.data).toBe("aW1hZ2U=");
  expect(delta.type === "history" && delta.messages[0]?.images[0]?.data).toBeUndefined();
  expect(reset.type === "history" && reset.messages[0]?.images[0]?.data).toBe("aW1hZ2U=");
});

test("repairing row-backed history quarantines corruption before editing message positions", async () => {
  const { writeDurable } = await import("../src/storage/files.ts");
  const data = await mkdtemp(testTmp("row-repair-"));
  const path = join(data, "ada", "threads", "main", "active.jsonl");
  const original = MessageStore.create(path);
  await original.append(message("saved"));
  writeDurable(path, `\n${JSON.stringify(message("saved"))}\nnot-json\n`);
  const repaired = await MessageStore.load(path);
  expect(repaired.quarantinedLines).toBe(1);
  await repaired.edit("saved", "corrected");
  const reloaded = await MessageStore.load(path);
  expect(reloaded.messages().map(entry => entry.content)).toEqual(["corrected"]);
});
