import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { clear, segments } from "../src/commands/segments.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { runCompaction } from "../src/memory/compaction/run.ts";
import type { SegmentsListing } from "../src/protocol/SegmentsListing.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-12T10:00:00.000Z";

function said(id: string, role: Message["role"], text: string): Message {
  return { msg_id: id, role, content: text, images: [], alternatives: [], content_blocks: [{ type: "text", text }], timestamp: NOW };
}

function fiveToolCalls(id: string): Message[] {
  return [
    said(`${id}-ask`, "user", "find the five letters"),
    ...[1, 2, 3, 4, 5].flatMap((call) => [
      { ...said(`${id}-call${String(call)}`, "assistant", ""), content_blocks: [{ type: "text" as const, text: `looking in drawer ${String(call)}` }, { type: "tool_use" as const, id: `${id}-t${String(call)}`, name: "read", input: {} }] },
      { ...said(`${id}-result${String(call)}`, "user", ""), content_blocks: [{ type: "tool_result" as const, tool_use_id: `${id}-t${String(call)}`, content: "a letter" }] },
    ]),
    said(`${id}-reply`, "assistant", "all five are here"),
  ];
}

const lines = (messages: readonly Message[]): string => messages.map((message) => `${JSON.stringify(message)}\n`).join("");

async function dataWith(messages: readonly Message[]): Promise<string> {
  const data = join(await mkdtemp(testTmp("shore-turn-counts-")), "data");
  await mkdir(join(data, "ada", "threads", "main"), { recursive: true });
  writeDurable(threadFile(data, "ada", "main", "active.jsonl"), lines(messages));
  return data;
}

async function listed(data: string): Promise<number[]> {
  const listing = await segments(data, "ada", "main", {}) as SegmentsListing;
  return listing.segments.map((segment) => segment.turn_count);
}

describe("a turn with five tool calls counts as one turn", () => {
  test("in what clearing the context reports and in the segment it leaves", async () => {
    const data = await dataWith([...fiveToolCalls("a"), said("b-ask", "user", "thanks"), said("b-reply", "assistant", "any time")]);
    const engine = await ConversationEngine.load("ada", data, undefined, "main");
    const result = await clear(engine, { dataDir: data }, {});
    expect([result.segment.index, result.segment.turn_count]).toEqual([0, 2]);
    expect(await listed(data)).toEqual([2]);
  });

  test("in the notice of an archive that writes no memory, and in the segment it leaves", async () => {
    const data = await dataWith([...fiveToolCalls("a"), said("b-ask", "user", "thanks"), said("b-reply", "assistant", "any time")]);
    const root = join(data, "..");
    const app = defaultAppConfig();
    app.compaction.write_memory = false;
    app.compaction.keep_recent_turns = 1;
    const config: LoadedConfig = {
      app, models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: join(root, "config"), data, cache: join(root, "cache"), runtime: join(root, "runtime") },
    };
    const notices: string[] = [];
    const generate = () => Promise.reject(new Error("an archive that writes no memory asks no model"));
    await runCompaction("ada", { config, generate, notify: (_title, body) => notices.push(body) }, "turn");
    expect(notices).toEqual(["Conversation rotated into history (1 turn, no memory write)"]);
    expect(await listed(data)).toEqual([1]);
  });
});

describe("a database from before segments counted turns", () => {
  test("opens with its segments and forks, and takes new ones", async () => {
    const path = join(await mkdtemp(testTmp("shore-turn-counts-db-")), HISTORY_DB_FILE);
    const earlier = new Database(path);
    earlier.run(`CREATE TABLE history_segments (
      character TEXT NOT NULL, idx INTEGER NOT NULL, file TEXT NOT NULL, message_count INTEGER NOT NULL,
      compacted_at TEXT NOT NULL, compaction_id TEXT, committed INTEGER NOT NULL DEFAULT 1,
      memory_before TEXT, memory_after TEXT, excluded INTEGER NOT NULL DEFAULT 0, label TEXT, note TEXT,
      PRIMARY KEY (character, idx))`);
    earlier.run(`CREATE TABLE history_thread_forks (
      character TEXT NOT NULL, fork_id TEXT NOT NULL, child TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT NOT NULL, message_count INTEGER NOT NULL, turn_count INTEGER NOT NULL,
      PRIMARY KEY (character, fork_id))`);
    earlier.run("INSERT INTO history_segments (character, idx, file, message_count, compacted_at, label) VALUES ('ada', 0, 'shore.db', 412, ?1, 'old')", [NOW]);
    earlier.run("INSERT INTO history_thread_forks VALUES ('ada', 'fk_old', 'side', 'main', ?1, 12, 1)", [NOW]);
    earlier.close();

    const store = HistoryStore.open(path);
    try {
      store.putSegment("ada", 1, { file: HISTORY_DB_FILE, compacted_at: NOW }, fiveToolCalls("a"));
      store.recordThreadFork("ada", { fork_id: "fk_new", child: "spin", source: "main", created_at: NOW, turn_count: 3 });
      expect(store.entries("ada").map((entry) => [entry.idx, entry.label, entry.turn_count])).toEqual([[0, "old", 0], [1, undefined, 1]]);
      expect(store.threadForks("ada")).toEqual([
        { fork_id: "fk_new", child: "spin", source: "main", created_at: NOW, turn_count: 3 },
        { fork_id: "fk_old", child: "side", source: "main", created_at: NOW, turn_count: 1 },
      ]);
    } finally {
      store.close();
    }
  });
});
