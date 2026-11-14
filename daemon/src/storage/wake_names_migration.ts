import type { Database } from "bun:sqlite";

import { bookPathIn, readBook, SESSION_KEY_SEPARATOR, writeBook } from "../llm/providers/agent_sessions.ts";
import { shoreLog } from "../log.ts";
import { pack, withStorage } from "./store.ts";

const DONE = "shore/wake-calls-from-when-they-were-recorded-as-heartbeats";

const TABLES_WITH_A_CALL_TYPE = ["calls", "call_attempts", "capture_calls", "capture_transcripts", "capture_http_calls"];

function ranOldWakes(sessionKey: string): boolean {
  const parts = sessionKey.split(SESSION_KEY_SEPARATOR);
  return parts.length === 4 && parts[3] === "heartbeat";
}

export function renameHeartbeatCallTypes(db: Database): number {
  return TABLES_WITH_A_CALL_TYPE.reduce((total, table) => total + db.query(
    `UPDATE ${table} SET call_type = 'wake' || substr(call_type, 10) WHERE call_type IN ('heartbeat', 'heartbeat_tool_loop')`,
  ).run().changes, 0);
}

export function renameRecordedHeartbeatCalls(data: string): void {
  try {
    if (withStorage(data, (db) => db.query("SELECT 1 FROM state_files WHERE path = ?1").get(DONE)) !== null) return;
    const sessions = bookPathIn(data);
    writeBook(sessions, Object.fromEntries(Object.entries(readBook(sessions)).filter(([key]) => !ranOldWakes(key))));
    const renamed = withStorage(data, (db) => db.transaction(() => {
      const changed = renameHeartbeatCallTypes(db);
      db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(DONE, pack("done"));
      return changed;
    })());
    if (renamed > 0) {
      shoreLog.info(`shore: ${String(renamed)} recorded wake calls had the call type heartbeat and now have wake; this happens once`);
    }
  } catch (error) {
    shoreLog.warn(`shore: could not rename the call type of recorded wake calls, so they stay heartbeat until a later start succeeds: ${String(error)}`);
  }
}

const EVENTS_DONE = "shore/wake-events-and-transcripts-from-when-they-were-filed-under-heartbeat";

export function refileRecordedHeartbeatEvents(data: string): void {
  try {
    const refiled = withStorage(data, (db) => {
      if (db.query("SELECT 1 FROM state_files WHERE path = ?1").get(EVENTS_DONE) !== null) return 0;
      return db.transaction(() => {
        const changed = db.query("UPDATE events SET kind = 'wake' WHERE kind = 'heartbeat'").run().changes +
          db.query("UPDATE capture_transcripts SET source = 'wake' WHERE source = 'heartbeat'").run().changes;
        db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(EVENTS_DONE, pack("done"));
        return changed;
      })();
    });
    if (refiled > 0) {
      shoreLog.info(`shore: ${String(refiled)} stored wake events and transcript entries were filed under heartbeat and are now under wake; this happens once`);
    }
  } catch (error) {
    shoreLog.warn(`shore: could not refile stored wake events and transcript entries, so the traces of earlier wakes stay hidden until a later start succeeds: ${String(error)}`);
  }
}
