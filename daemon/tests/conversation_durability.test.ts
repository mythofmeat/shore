import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKUP_THROTTLE_MS,
  MAX_BACKUPS,
  backupBeforeWrite,
  backupDirFor,
  resetBackupThrottle,
} from "../src/engine/backup.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { Message } from "../src/engine/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetBackupThrottle();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shore-durability-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function line(id: string, text: string): string {
  return JSON.stringify({
    msg_id: id,
    role: "user",
    content: text,
    content_blocks: [{ type: "text", text }],
    images: [],
    alternatives: [],
    timestamp: "2026-08-12T00:00:00Z",
  });
}

function message(id: string, text: string): Message {
  return JSON.parse(line(id, text)) as Message;
}

describe("one malformed line no longer costs the whole conversation", () => {
  test("the readable turns load and the unreadable one is quarantined", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(
      path,
      [line("m1", "kept"), "{ truncated", line("m3", "also kept")].join("\n") + "\n",
      "utf8",
    );

    const store = await MessageStore.load(path);

    expect(store.messages().map((m) => m.msg_id)).toEqual(["m1", "m3"]);
    expect(store.quarantinedLines).toBe(1);

    const kept = await readdir(backupDirFor(path));
    const quarantine = kept.find((name) => name.includes("quarantine"));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(backupDirFor(path), quarantine!), "utf8")).toBe("{ truncated\n");
  });

  test("a clean conversation quarantines nothing and writes no quarantine file", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(path, `${line("m1", "fine")}\n`, "utf8");

    const store = await MessageStore.load(path);
    expect(store.quarantinedLines).toBe(0);
    expect(readdir(backupDirFor(path))).rejects.toThrow();
  });
});

describe("backupBeforeWrite", () => {
  test("copies the live file before it is rewritten", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(path, "original\n", "utf8");

    const made = await backupBeforeWrite(path, () => 1_000_000);
    expect(made).toBeDefined();
    expect(await readFile(made!, "utf8")).toBe("original\n");
  });

  test("throttles, so a busy conversation does not thrash the disk", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(path, "original\n", "utf8");

    let at = 1_000_000;
    expect(await backupBeforeWrite(path, () => at)).toBeDefined();
    at += BACKUP_THROTTLE_MS - 1;
    expect(await backupBeforeWrite(path, () => at)).toBeUndefined();
    at += 2;
    expect(await backupBeforeWrite(path, () => at)).toBeDefined();
  });

  test("retains a bounded number of copies", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(path, "original\n", "utf8");

    let at = 1_000_000;
    for (let i = 0; i < MAX_BACKUPS + 5; i += 1) {
      await backupBeforeWrite(path, () => at);
      at += BACKUP_THROTTLE_MS + 1;
    }
    expect((await readdir(backupDirFor(path))).length).toBe(MAX_BACKUPS);
  });

  test("an empty or missing file is not worth a copy", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");

    expect(await backupBeforeWrite(path, () => 1)).toBeUndefined();
    await writeFile(path, "", "utf8");
    expect(await backupBeforeWrite(path, () => 20_000)).toBeUndefined();
  });
});

describe("the store takes a copy before it rewrites the file", () => {
  test("the prior contents survive an append", async () => {
    const dir = await workspace();
    const path = join(dir, "active.jsonl");
    await writeFile(path, `${line("m1", "before")}\n`, "utf8");

    const store = await MessageStore.load(path);
    await store.append(message("m2", "after"));

    const backups = await readdir(backupDirFor(path));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(backupDirFor(path), backups[0]!), "utf8")).toContain("before");
    expect(await readFile(path, "utf8")).toContain("after");
  });
});
