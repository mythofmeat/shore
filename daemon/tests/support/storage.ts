import { basename, dirname, join } from "node:path";
import { writeDurable } from "../../src/storage/files.ts";
import { insertEvent, withStorage } from "../../src/storage/store.ts";

export function writePromptSnapshotFile(path: string, content: string): void {
  writeDurable(path, content);
  writeDurable(join(dirname(path), ".snapshot"), "1");
}

export function seedHeartbeatEvents(characterDir: string, lines: string): void {
  withStorage(dirname(characterDir), db => db.transaction(() => {
    for (const content of lines.split("\n").filter(line => line !== "")) {
      insertEvent(db, { character: basename(characterDir), kind: "heartbeat", timestamp: "", content });
    }
  })());
}
