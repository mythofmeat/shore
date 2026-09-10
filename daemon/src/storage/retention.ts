import { CallStore } from "../call_store.ts";
import { shoreLog } from "../log.ts";
import type { SnapshotGate } from "../snapshot_gate.ts";
import { databasePath, openStorage, pack, unpack } from "./store.ts";

export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 3_600_000;
const SWEEP_INTERVAL_MS = 24 * 3_600_000;

export interface RetentionStats {
  captures: number;
  heartbeats: number;
  subagentTraces: number;
  unreadableTraces: number;
}

export function pruneDiagnostics(data: string, nowMs = Date.now()): RetentionStats {
  const cutoff = new Date(nowMs - DIAGNOSTIC_RETENTION_MS);
  const cutoffIso = cutoff.toISOString();
  openStorage(data).close();
  const store = CallStore.open(databasePath(data));
  const db = store.database;
  try {
    return db.transaction(() => {
      const stats: RetentionStats = {
        captures: store.expireBefore(cutoff),
        heartbeats: db.query("DELETE FROM events WHERE kind = 'heartbeat' AND julianday(timestamp) < julianday(?1)").run(cutoffIso).changes,
        subagentTraces: 0,
        unreadableTraces: 0,
      };
      let cursor = 0;
      for (;;) {
        const rows = db.query(`SELECT id FROM events WHERE kind = 'subagent'
          AND id > ?1 AND julianday(timestamp) < julianday(?2) ORDER BY id LIMIT 128`)
          .all(cursor, cutoffIso) as { id: number }[];
        if (rows.length === 0) break;
        for (const { id } of rows) {
          cursor = id;
          const row = db.query("SELECT content FROM events WHERE id = ?1").get(id) as { content: Uint8Array };
          let trace: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(unpack(row.content));
            if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid trace");
            trace = value as Record<string, unknown>;
            if (typeof trace["subagent"] !== "string" || typeof trace["parent_tool_use_id"] !== "string" || !Array.isArray(trace["messages"])) {
              throw new Error("Invalid trace");
            }
          } catch {
            stats.unreadableTraces += 1;
            continue;
          }
          db.query("UPDATE events SET kind = 'subagent_result', content = ?1 WHERE id = ?2")
            .run(pack(JSON.stringify({ ...trace, messages: [], messages_expired: true })), id);
          stats.subagentTraces += 1;
        }
      }
      return stats;
    })();
  } finally { store.close(); }
}

export function startDiagnosticRetention(data: string, gate: SnapshotGate, intervalMs = SWEEP_INTERVAL_MS): { stop(): void } {
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await gate.withActivity(async () => {
        if (stopped) return;
        const stats = pruneDiagnostics(data);
        if (stats.captures + stats.heartbeats + stats.subagentTraces > 0) {
          shoreLog.info(`shore: diagnostic retention removed ${stats.captures} captures and ${stats.heartbeats} heartbeat events; retained results for ${stats.subagentTraces} expired subagent traces`);
        }
        if (stats.unreadableTraces > 0) shoreLog.warn(`shore: diagnostic retention preserved ${stats.unreadableTraces} unreadable subagent traces`);
      });
    } catch (error) {
      shoreLog.warn(`shore: diagnostic retention failed: ${String(error)}`);
    } finally { running = false; }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
