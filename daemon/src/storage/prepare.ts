import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import type { ShoreDirs } from "../config/dirs.ts";
import { readBook, bookPathIn } from "../llm/providers/agent_sessions.ts";
import { HeartbeatLog } from "../autonomy/heartbeat_log.ts";
import { readSubagentTraces } from "../tools/subagent_trace.ts";
import { readState, writeCharacterState } from "./store.ts";
import { readDurable } from "./files.ts";
import { migrateCharacterMedia } from "./media.ts";

export async function preparePersistentStorage(dirs: Pick<ShoreDirs, "data">): Promise<void> {
  if (existsSync(bookPathIn(dirs.data))) readBook(bookPathIn(dirs.data));
  importSidecars(dirs.data, "matrix", "");
  for (const entry of readdirSync(dirs.data, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["media", "matrix", "plugins"].includes(entry.name) || entry.name.startsWith(".")) continue;
    const character = entry.name;
    const root = join(dirs.data, character);
    migrateCharacterMedia(dirs.data, character);
    for (const file of ["autonomy_state.json", "deferred_edits.jsonl"]) {
      if (existsSync(join(root, file))) readState(dirs.data, `${character}/${file}`, character);
    }
    const prompt = join(root, "active_prompt");
    if (existsSync(prompt)) {
      importSidecars(dirs.data, `${character}/active_prompt`, character);
      writeCharacterState(root, "active_prompt/.snapshot", "1");
    }
    importSidecars(dirs.data, `${character}/matrix`, character);
    if (existsSync(join(root, "subagents.jsonl"))) await readSubagentTraces(root, { count: 1 });
    if (existsSync(join(root, "heartbeat.jsonl"))) await HeartbeatLog.load(join(root, "heartbeat.jsonl"));
    importBackups(dirs.data, `${character}/backups`, character);
    const threads = join(root, "threads");
    if (existsSync(threads)) {
      for (const thread of readdirSync(threads, { withFileTypes: true })) {
        if (!thread.isDirectory()) continue;
        importBackups(dirs.data, `${character}/threads/${thread.name}/backups`, character);
        for (const file of ["active.jsonl", "compaction-checkpoint.json"]) {
          const path = join(threads, thread.name, file);
          if (existsSync(path)) readDurable(path);
        }
      }
    }
  }
}

function importSidecars(data: string, directory: string, character: string): void {
  const root = join(data, directory);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) readState(data, `${directory}/${entry.name}`, character);
  }
  if (readdirSync(root).length === 0) rmdirSync(root);
}

function importBackups(data: string, directory: string, character: string): void {
  const root = join(data, directory);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) readState(data, `${directory}/${entry.name}`, character);
  }
  if (readdirSync(root).length === 0) rmdirSync(root);
}
