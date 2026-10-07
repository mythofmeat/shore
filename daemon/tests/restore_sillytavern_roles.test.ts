import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { restoreRoles, sillyTavernRoles } from "../scripts/restore_sillytavern_roles.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";

const HIDDEN_USER = "m_import_sillytavern_98b47eb90d63ced7b11c4e89";
const HIDDEN_CHARACTER = "m_import_sillytavern_294240be4ff2a2d52f7ca2f3";
const HIDDEN_NESTED = "m_import_sillytavern_71c1d928f9660ce9dbca4c0b";
const NOT_IN_CHATS = "m_import_sillytavern_000000000000000000000000";

function message(msgId: string, role: Message["role"], text: string, blocks?: ContentBlock[]): Message {
  return {
    msg_id: msgId,
    role,
    content: text,
    images: [],
    content_blocks: blocks ?? [{ type: "text", text }],
    timestamp: "2025-03-01T21:15:00+11:00",
  };
}

function fresh(): string {
  const dir = testTmp(`st-roles-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function chats(dir: string): string {
  const root = join(dir, "chats");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "2025-03-01.jsonl"), [
    JSON.stringify({ chat_metadata: {}, user_name: "Ren", character_name: "Ada" }),
    JSON.stringify({ name: "Ren", is_user: true, is_system: true, mes: "the kettle's on, come sit" }),
    "",
    JSON.stringify({ name: "Ada", is_user: false, is_system: true, mes: "i saved you the window seat" }),
    JSON.stringify({ name: "Ada", is_user: false, is_system: false, mes: "tea's ready" }),
  ].join("\n"));
  writeFileSync(join(root, "nested", "2025-03-02.jsonl"), `${JSON.stringify({ name: "Ren", is_user: true, is_system: true, mes: "see you tomorrow" })}\r\n`);
  writeFileSync(join(root, ".2025-03-03.jsonl"), `${JSON.stringify({ name: "Ren", is_user: true, is_system: true, mes: "ignored" })}\n`);
  return root;
}

function archive(dbPath: string, messages: Message[]): void {
  const store = HistoryStore.open(dbPath);
  store.putSegment("ada", 0, { file: HISTORY_DB_FILE, message_count: messages.length, compacted_at: "2025-03-02T00:00:00Z" }, messages);
  store.close();
}

function row(db: Database, msgId: string): { role: string; display_kind: number; is_user_turn: number } {
  return db.query("SELECT role, display_kind, is_user_turn FROM history_messages WHERE msg_id = ?1").get(msgId) as {
    role: string; display_kind: number; is_user_turn: number;
  };
}

function revision(db: Database): number {
  return (db.query("SELECT revision FROM history_archive_revision WHERE character = 'ada'").get() as { revision: number }).revision;
}

describe("restore_sillytavern_roles", () => {
  test("recomputes the importer's ids from the original chats", () => {
    expect(sillyTavernRoles(chats(fresh()))).toEqual(new Map([
      [HIDDEN_USER, "user"],
      [HIDDEN_CHARACTER, "assistant"],
      [HIDDEN_NESTED, "user"],
    ]));
  });

  test("gives hidden messages back their speaker and leaves other system rows alone", () => {
    const dir = fresh();
    const dbPath = join(dir, HISTORY_DB_FILE);
    archive(dbPath, [
      message(HIDDEN_USER, "system", "the kettle's on, come sit"),
      message(HIDDEN_CHARACTER, "system", "i saved you the window seat"),
      message(HIDDEN_NESTED, "system", "see you tomorrow"),
      message(NOT_IN_CHATS, "system", "no source line"),
      message("m_native_notice", "system", "conversation resumed"),
      message("m_reference_user", "user", "reference"),
      message("m_reference_reply", "assistant", "reference"),
    ]);
    const roles = sillyTavernRoles(chats(dir));
    const db = new Database(dbPath, { readwrite: true });
    const before = revision(db);
    const summary = { matched: 3, user: 2, assistant: 1, unmatched: 1, characters: ["ada"] };

    expect(restoreRoles(db, roles, false)).toEqual(summary);
    expect(row(db, HIDDEN_USER).role).toBe("system");
    expect(revision(db)).toBe(before);

    expect(restoreRoles(db, roles, true)).toEqual(summary);
    expect(row(db, HIDDEN_USER)).toEqual({ ...row(db, "m_reference_user"), role: "user" });
    expect(row(db, HIDDEN_NESTED)).toEqual(row(db, "m_reference_user"));
    expect(row(db, HIDDEN_CHARACTER)).toEqual(row(db, "m_reference_reply"));
    expect(row(db, NOT_IN_CHATS).role).toBe("system");
    expect(row(db, "m_native_notice").role).toBe("system");
    expect(revision(db)).toBe(before + 1);

    expect(restoreRoles(db, roles, true)).toEqual({ matched: 0, user: 0, assistant: 0, unmatched: 1, characters: [] });
    expect(revision(db)).toBe(before + 1);
    db.close();
  });

  test("refuses a row that follows a tool message", () => {
    const dir = fresh();
    const dbPath = join(dir, HISTORY_DB_FILE);
    archive(dbPath, [
      message("m_call", "assistant", "", [{ type: "tool_use", id: "t1", name: "bash", input: {} }]),
      message("m_result", "user", "", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
      message(HIDDEN_USER, "system", "the kettle's on, come sit"),
    ]);
    const db = new Database(dbPath, { readwrite: true });

    expect(() => restoreRoles(db, sillyTavernRoles(chats(dir)), true)).toThrow("follows a tool message");
    expect(row(db, HIDDEN_USER).role).toBe("system");
    db.close();
  });
});
