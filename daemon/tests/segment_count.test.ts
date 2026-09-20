import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { segmentCount } from "../src/memory/compaction/archive.ts";
import { conversationRef } from "../src/engine/segments.ts";
import { MAIN_THREAD } from "../src/config/dirs.ts";
import { testTmp } from "./support/tmp.ts";

let counter = 0;

async function dataDir(): Promise<string> {
  counter += 1;
  const dir = testTmp(`segment-count-${String(counter)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function characterDir(dataRoot: string, character: string): Promise<string> {
  const dir = join(dataRoot, character);
  await mkdir(join(dir, "threads", "main"), { recursive: true });
  return dir;
}

function message(text: string): Message {
  return {
    msg_id: `m_${text}`,
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: "2026-08-14T00:00:00.000Z",
  };
}

function seedDatabase(dataRoot: string, character: string, count: number): void {
  const store = HistoryStore.open(join(dataRoot, HISTORY_DB_FILE));
  try {
    for (let idx = 0; idx < count; idx += 1) {
      store.putSegment(
        character,
        idx,
        {
          file: HISTORY_DB_FILE,
          message_count: 1,
          compacted_at: "2026-08-14T00:00:00.000Z",
        },
        [message(`s${String(idx)}`)],
      );
    }
  } finally {
    store.close();
  }
}

describe("segmentCount", () => {
  test("counts database segments", async () => {
    const root = await dataDir();
    await characterDir(root, "ada");
    seedDatabase(root, "ada", 3);

    expect(await segmentCount(conversationRef(root, "ada", MAIN_THREAD, false))).toBe(3);
  });

  test("ignores segments belonging to another character", async () => {
    const root = await dataDir();
    await characterDir(root, "ada");
    seedDatabase(root, "grace", 4);

    expect(await segmentCount(conversationRef(root, "ada", MAIN_THREAD, false))).toBe(0);
  });

  test("returns zero for a character with no history at all", async () => {
    const root = await dataDir();
    await characterDir(root, "ada");

    expect(await segmentCount(conversationRef(root, "ada", MAIN_THREAD, false))).toBe(0);
  });
});
