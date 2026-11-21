import type { Database } from "bun:sqlite";

import { shoreLog } from "../log.ts";
import { pack, unpack, withStorage } from "./store.ts";

const DONE = "shore/thread-files-became-pins";

function pinnedRecord({ files, ...rest }: Record<string, unknown>, dropped: string[]): Record<string, unknown> {
  const kept = Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
  dropped.push(...kept.filter((file) => file.startsWith("!")));
  const pins = kept.filter((file) => !file.startsWith("!"));
  return pins.length === 0 ? rest : { ...rest, pins };
}

function pinnedIndex(content: string, dropped: string[]): string {
  const index = JSON.parse(content) as { threads: Record<string, unknown>[] };
  return `${JSON.stringify({ ...index, threads: index.threads.map((record) => pinnedRecord(record, dropped)) }, null, 2)}\n`;
}

export function moveThreadFilesToPins(db: Database): string[] {
  const dropped: string[] = [];
  for (const row of db.query("SELECT path, content FROM state_files WHERE path GLOB '*/threads.json'").all() as { path: string; content: Uint8Array }[]) {
    try {
      db.query("UPDATE state_files SET content = ?1 WHERE path = ?2").run(pack(pinnedIndex(unpack(row.content), dropped)), row.path);
    } catch (error) {
      shoreLog.warn(`shore: ${row.path} isn't a thread list Shore can read, so its thread files weren't moved to pins: ${String(error)}`);
    }
  }
  db.query("UPDATE state_files SET path = replace(path, '/active_prompt/thread_files/', '/active_prompt/thread_pins/') WHERE path GLOB '*/active_prompt/thread_files/*'").run();
  return dropped;
}

export function moveStoredThreadFilesToPins(data: string): void {
  try {
    const dropped = withStorage(data, (db) => {
      if (db.query("SELECT 1 FROM state_files WHERE path = ?1").get(DONE) !== null) return [];
      return db.transaction(() => {
        const moved = moveThreadFilesToPins(db);
        db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(DONE, pack("done"));
        return moved;
      })();
    });
    if (dropped.length > 0) {
      shoreLog.warn(`shore: these thread files were left out of their threads' pins, because a pin that starts with ! is a command: ${dropped.join(", ")}`);
    }
  } catch (error) {
    shoreLog.warn(`shore: could not move thread files to pins, so threads show none until a later start succeeds: ${String(error)}`);
  }
}
