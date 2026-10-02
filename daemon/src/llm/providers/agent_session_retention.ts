import type { Database } from "bun:sqlite";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shoreLog } from "../../log.ts";
import { pack, unpack, withStorage } from "../../storage/store.ts";
import type { SessionBook, SessionRecord } from "./agent_sessions.ts";

const RETIRED_PREFIX = "sdk_retired/";

function sessionReferences(book: SessionBook): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [key, record] of Object.entries(book)) {
    if (typeof record.sessionId !== "string" || !Array.isArray(record.entries)) throw new Error("Invalid SDK session references; preserving transcripts");
    const character = key.split("\u0000")[0] ?? "";
    refs.set(record.sessionId, character);
    for (const entry of record.entries) {
      if (entry.sessionId !== undefined && typeof entry.sessionId !== "string") throw new Error("Invalid SDK parent session; preserving transcripts");
      if (entry.sessionId !== undefined) refs.set(entry.sessionId, character);
    }
  }
  return refs;
}

export function retireSession(db: Database, sessionId: string, character: string, nowMs: number): void {
  db.query("INSERT OR IGNORE INTO state_files(path, character, content) VALUES (?1, ?2, ?3)")
    .run(RETIRED_PREFIX + Buffer.from(sessionId).toString("base64url"), character,
      pack(JSON.stringify({ sessionId, retiredAt: nowMs })));
}

export function reconcileSessions(db: Database, before: SessionBook, after: SessionBook, nowMs: number): void {
  const active = sessionReferences(after);
  for (const [id, character] of sessionReferences(before)) {
    if (!active.has(id)) retireSession(db, id, character, nowMs);
  }
  for (const id of active.keys()) {
    db.query("DELETE FROM state_files WHERE path = ?1").run(RETIRED_PREFIX + Buffer.from(id).toString("base64url"));
  }
}

function removeLocalSession(sessionId: string, configDir: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return;
  const projects = join(configDir, "projects");
  let dirs;
  try { dirs = readdirSync(projects, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    rmSync(join(projects, dir.name, `${sessionId}.jsonl`), { force: true });
    rmSync(join(projects, dir.name, sessionId), { recursive: true, force: true });
  }
}

export function pruneSdkSessions(data: string, cutoffMs: number, nowMs: number, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): number {
  return withStorage(data, db => {
    const book: SessionBook = {};
    const records = db.query("SELECT path, content FROM state_files WHERE path GLOB 'sdk_sessions/*'").all() as { path: string; content: Uint8Array }[];
    for (const row of records) {
      const key = Buffer.from(row.path.split("/").at(-1) ?? "", "base64url").toString();
      book[key + "\u0000" + row.path] = JSON.parse(unpack(row.content)) as SessionRecord;
    }
    const active = sessionReferences(book);
    for (const id of active.keys()) db.query("DELETE FROM state_files WHERE path = ?1").run(RETIRED_PREFIX + Buffer.from(id).toString("base64url"));
    const transcripts = db.query("SELECT path, character FROM state_files WHERE path GLOB 'sdk_transcripts/*'").all() as { path: string; character: string }[];
    const paths = new Map<string, string[]>();
    for (const row of transcripts) {
      const encodedId = row.path.split("/")[3];
      if (encodedId === undefined) continue;
      const id = Buffer.from(encodedId, "base64url").toString();
      const group = paths.get(id) ?? [];
      group.push(row.path);
      paths.set(id, group);
      if (!active.has(id)) retireSession(db, id, row.character, nowMs);
    }
    let removed = 0;
    const retired = db.query("SELECT path, content FROM state_files WHERE path GLOB 'sdk_retired/*'").all() as { path: string; content: Uint8Array }[];
    for (const row of retired) {
      try {
        const record = JSON.parse(unpack(row.content)) as { sessionId: string; retiredAt: number };
        if (typeof record.sessionId !== "string" || !Number.isFinite(record.retiredAt) || active.has(record.sessionId) || record.retiredAt >= cutoffMs) continue;
        removeLocalSession(record.sessionId, configDir);
        db.transaction(() => {
          for (const path of paths.get(record.sessionId) ?? []) db.query("DELETE FROM state_files WHERE path = ?1").run(path);
          db.query("DELETE FROM state_files WHERE path = ?1").run(row.path);
        })();
        removed += 1;
      } catch (error) {
        shoreLog.warn(`shore: could not expire SDK session ${row.path}: ${String(error)}`);
      }
    }
    return removed;
  });
}
