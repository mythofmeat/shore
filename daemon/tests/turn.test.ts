import { writeDurable } from "../src/storage/files.ts";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultAppConfig } from "../src/config/app.ts";
import { archiveKey } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { writeThreadsIndex } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { appendUserTurn, ensureAndBackfillAutonomy, type TurnAutonomy, type TurnContext } from "../src/handler/turn.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile } from "../src/storage/files.ts";
import { closeStorageConnections } from "../src/storage/store.ts";
import { handlesUnder } from "./support/handles.ts";

const MINTED_ID = "m_00000000-0000-4000-8000-000000000000";
const MINTED_TS = "2026-01-01T00:00:00-05:00";

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "shore-turn-"));
}

interface Recorder {
  ctx: TurnContext;
  events: ServerMessage[];
  direct: ServerMessage[];
  backfills: { character: string; timestamps: Date[] }[];
}

function recorder(overrides: Partial<TurnAutonomy> = {}): Recorder {
  const events: ServerMessage[] = [];
  const direct: ServerMessage[] = [];
  const backfills: { character: string; timestamps: Date[] }[] = [];

  const autonomy: TurnAutonomy = {
    ensureState: () => true,
    needsActivityBackfill: () => true,
    backfillActivity: (character, timestamps) =>
      backfills.push({ character, timestamps: [...timestamps] }),
    onUserMessage: () => {},
    shouldCompactNow: () => false,
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    ...overrides,
  };

  return {
    ctx: {
      emitEvent: (m) => events.push(m),
      sendDirect: (m) => direct.push(m),
      autonomy,
      now: () => MINTED_TS,
      newMessageId: () => MINTED_ID,
    },
    events,
    direct,
    backfills,
  };
}

async function seedCharacter(root: string, history: unknown[]): Promise<string> {
  const dataDir = join(root, "data");
  const charDir = join(dataDir, "ada");
  await mkdir(join(charDir, "threads", "main"), { recursive: true });
  if (history.length > 0) {
    writeDurable(join(charDir, "threads", "main", "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }
  return dataDir;
}

describe("appendUserTurn", () => {

  test("acceptance is confirmed only once the user turn is on disk, and never for a regen or an empty body", async () => {
    const root = await tempRoot();
    try {
      const dataDir = await seedCharacter(root, []);
      const rec = recorder();
      const saved: number[] = [];
      const ctx: TurnContext = { ...rec.ctx, accepted: async () => { saved.push((await ConversationEngine.load("ada", dataDir)).messages().length); } };
      const engine = await ConversationEngine.load("ada", dataDir);
      await appendUserTurn(ctx, engine, dataDir, "ada", { text: "", images: [], image_data: [] }, false, "empty");
      await appendUserTurn(ctx, engine, dataDir, "ada", { text: "hello", images: [], image_data: [] }, false, "send-1");
      await appendUserTurn(ctx, engine, dataDir, "ada", { text: "", images: [], image_data: [] }, true, "regen-1");
      expect(saved).toEqual([1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureAndBackfillAutonomy", () => {
  const NOW = new Date("2026-11-24T12:00:00Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_MS = 90 * DAY_MS;
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

  const said = (id: string, role: Message["role"], timestamp: string, more: Partial<Message> = {}): Message => ({
    msg_id: id, role, content: id, images: [], content_blocks: [{ type: "text", text: id }], timestamp, ...more,
  });
  const toolResults = (id: string, timestamp: string): Message =>
    said(id, "user", timestamp, { content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] });
  const wakeOpener = (id: string, timestamp: string): Message => said(id, "user", timestamp, { origin: "autonomous" });

  function loadedConfig(root: string, dataDir: string): LoadedConfig {
    return {
      app: defaultAppConfig(),
      models: emptyCatalog(),
      providers: ProviderRegistry.empty(),
      dirs: { config: join(root, "config"), data: dataDir, runtime: join(root, "runtime"), cache: join(root, "cache") },
      rawTable: undefined,
    };
  }

  async function storedCharacter(root: string, threads: Record<string, { active: Message[]; archived: Message[] }>): Promise<string> {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    initializeDatabase(dataDir);
    await writeThreadsIndex(dataDir, "ada", {
      version: 1,
      home: "main",
      threads: Object.keys(threads).map((id) => ({ id, created_at: ago(200 * DAY_MS), compaction: true })),
    });
    const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
    try {
      for (const [id, { active, archived }] of Object.entries(threads)) {
        writeDurable(threadFile(dataDir, "ada", id, "active.jsonl"), active.map((m) => `${JSON.stringify(m)}\n`).join(""));
        if (archived.length > 0) history.putSegment(archiveKey("ada", id), 0, { file: HISTORY_DB_FILE, compacted_at: ago(DAY_MS) }, archived);
      }
    } finally {
      history.close();
    }
    return dataDir;
  }

  const times = (backfills: Recorder["backfills"]): [string, number[]][] =>
    backfills.map(({ character, timestamps }) => [character, timestamps.map((at) => NOW.getTime() - at.getTime()).sort((a, b) => b - a)]);

  test("the user's own messages from the last 90 days count once each, live and archived, from every thread, without reading an archived message or leaving anything open", async () => {
    const root = await tempRoot();
    try {
      const dataDir = await storedCharacter(root, {
        main: {
          active: [said("u-live", "user", ago(DAY_MS)), said("a-live", "assistant", ago(DAY_MS)), toolResults("t-live", ago(2 * DAY_MS)), wakeOpener("w-live", ago(3 * DAY_MS)), said("u-garbled", "user", "not a time")],
          archived: [said("u-edge", "user", ago(WINDOW_MS)), said("u-old", "user", ago(WINDOW_MS + 1)), said("u-month", "user", ago(30 * DAY_MS)), said("a-month", "assistant", ago(30 * DAY_MS)), toolResults("t-month", ago(30 * DAY_MS)), wakeOpener("w-month", ago(30 * DAY_MS))],
        },
        side: {
          active: [said("u-side", "user", ago(5 * DAY_MS))],
          archived: [said("u-side-old", "user", ago(40 * DAY_MS))],
        },
      });
      const bodies = new Database(join(dataDir, HISTORY_DB_FILE));
      bodies.run("DELETE FROM history_blobs");
      bodies.close();
      const rec = recorder();
      const engine = await ConversationEngine.load("ada", dataDir);
      const config = loadedConfig(root, dataDir);

      await ensureAndBackfillAutonomy(rec.ctx, engine, "ada", config, NOW);
      closeStorageConnections();
      const settled = handlesUnder(dataDir);
      await ensureAndBackfillAutonomy(rec.ctx, engine, "ada", config, NOW);
      closeStorageConnections();
      const after = handlesUnder(dataDir);
      engine.close();

      expect(after).toBe(settled);
      const expected: [string, number[]] = ["ada", [WINDOW_MS, 40 * DAY_MS, 30 * DAY_MS, 5 * DAY_MS, DAY_MS]];
      expect(times(rec.backfills)).toEqual([expected, expected]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a character already backfilled is still set up, and its history is not read again", async () => {
    const root = await tempRoot();
    try {
      const dataDir = await storedCharacter(root, { main: { active: [said("u-live", "user", ago(DAY_MS))], archived: [] } });
      const ensured: string[] = [];
      const rec = recorder({ ensureState: (character) => { ensured.push(character); return false; }, needsActivityBackfill: () => false });
      const engine = await ConversationEngine.load("ada", dataDir);
      await ensureAndBackfillAutonomy(rec.ctx, engine, "ada", loadedConfig(root, dataDir), NOW);
      engine.close();
      expect({ ensured, backfills: rec.backfills }).toEqual({ ensured: ["ada"], backfills: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a thread whose archive can't be opened is passed over, and the threads after it still count", async () => {
    const root = await tempRoot();
    try {
      const dataDir = await storedCharacter(root, {
        main: { active: [], archived: [] },
        broken: { active: [said("u-broken", "user", ago(DAY_MS))], archived: [] },
        side: { active: [said("u-side", "user", ago(5 * DAY_MS))], archived: [] },
      });
      const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
      history.beginCompaction(archiveKey("ada", "broken"), { file: HISTORY_DB_FILE, compacted_at: ago(DAY_MS) }, [said("u-compacting", "user", ago(2 * DAY_MS))], "before\n", "after\n");
      history.close();
      const rec = recorder();
      const engine = await ConversationEngine.load("ada", dataDir);
      await ensureAndBackfillAutonomy(rec.ctx, engine, "ada", loadedConfig(root, dataDir), NOW);
      engine.close();
      expect(times(rec.backfills)).toEqual([["ada", [5 * DAY_MS]]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
