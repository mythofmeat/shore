
import { writeDurable } from "../src/storage/files.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { appendUserTurn, type TurnAutonomy, type TurnContext } from "../src/handler/turn.ts";

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
