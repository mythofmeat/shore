import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import { conversationTokens } from "../src/ledger/conversation_spend.ts";
import type { CallRow } from "../src/ledger/store.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { testTmp } from "./support/tmp.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const ROW: CallRow = {
  output_tokens_estimated: 0,
  thinking_dropped: 0,
  cache_state_reason: null,
  ts: "2026-04-05T10:00:00.000Z",
  character: "aria",
  provider: "anthropic",
  api_key_name: "default",
  model: "claude-opus-5",
  call_type: "message",
  tool_surface: null,
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 80,
  cache_write_tokens: 20,
  cache_ttl: null,
  reasoning_effort: null,
  total_ms: 1500,
  ttft_ms: 200,
  finish_reason: "end_turn",
  thinking_enabled: 1,
  cache_state: "warm",
  cache_anomaly: null,
  input_cost: 0,
  output_cost: 0,
  cache_read_cost: 0,
  cache_write_cost: 0,
  cost_source: "pricing_catalog",
  total_cost: 0,
};

const COLUMNS = Object.keys(ROW);

function ledgerWith(rows: CallRow[]): string {
  const fixture = freshLedger();
  cleanups.push(fixture.cleanup);
  const db = openLedger(fixture.path);
  for (const row of rows) {
    db.query(
      `INSERT INTO calls (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `$${c}`).join(", ")})`,
    ).run(Object.fromEntries(COLUMNS.map((c) => [`$${c}`, (row as never)[c]])));
  }
  db.close();
  return fixture.path;
}

function message(timestamp: string): Message {
  return {
    msg_id: `m_${timestamp}`,
    role: "user",
    content: "hello",
    images: [],
    content_blocks: [{ type: "text", text: "hello" }],
    timestamp,
  };
}

async function engineWith(timestamps: string[]): Promise<ConversationEngine> {
  const root = mkdtempSync(testTmp("shore-conversation-spend-"));
  const charDir = join(root, "aria");
  mkdirSync(charDir, { recursive: true });
  writeFileSync(
    join(charDir, "active.jsonl"),
    timestamps.map((t) => JSON.stringify(message(t))).join("\n") + (timestamps.length ? "\n" : ""),
  );
  return await ConversationEngine.load("aria", root);
}

describe("conversation spend", () => {
  test("counts only the calls made since the oldest surviving message", async () => {
    const path = ledgerWith([
      { ...ROW, ts: "2026-04-05T09:00:00.000Z", input_tokens: 999_999 },
      { ...ROW, ts: "2026-04-05T10:00:00.000Z" },
      { ...ROW, ts: "2026-04-05T11:00:00.000Z" },
    ]);
    const engine = await engineWith(["2026-04-05T10:00:00.000Z"]);

    expect(conversationTokens(path, "aria", engine.startedAt())).toEqual({
      input: 200,
      output: 100,
      cache_read: 160,
      cache_write: 40,
    });
  });

  test("an archived-away conversation stops counting what it archived", async () => {
    const path = ledgerWith([
      { ...ROW, ts: "2026-04-05T09:00:00.000Z" },
      { ...ROW, ts: "2026-04-05T11:00:00.000Z" },
    ]);
    const before = await engineWith(["2026-04-05T09:00:00.000Z", "2026-04-05T11:00:00.000Z"]);
    const after = await engineWith(["2026-04-05T11:00:00.000Z"]);

    expect(conversationTokens(path, "aria", before.startedAt()).input).toBe(200);
    expect(conversationTokens(path, "aria", after.startedAt()).input).toBe(100);
  });

  test("one character's spend is not another's", async () => {
    const path = ledgerWith([
      { ...ROW, ts: "2026-04-05T10:00:00.000Z", character: "aria" },
      { ...ROW, ts: "2026-04-05T10:30:00.000Z", character: "qifei", input_tokens: 7000 },
    ]);

    expect(conversationTokens(path, "aria", "2026-04-05T00:00:00.000Z").input).toBe(100);
    expect(conversationTokens(path, "qifei", "2026-04-05T00:00:00.000Z").input).toBe(7000);
  });

  test("an empty conversation has spent nothing yet", async () => {
    const path = ledgerWith([{ ...ROW, ts: "2026-04-05T10:00:00.000Z" }]);
    const engine = await engineWith([]);

    expect(engine.startedAt()).toBeUndefined();
    expect(conversationTokens(path, "aria", engine.startedAt())).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  test("a missing ledger reports zero rather than throwing", async () => {
    expect(conversationTokens(undefined, "aria", "2026-04-05T10:00:00.000Z").input).toBe(0);
  });

  test("a conversation stamped with a zone offset lines up with the ledger's utc", async () => {
    const engine = await engineWith(["2026-04-05T20:00:00.000000000+10:00"]);
    expect(engine.startedAt()).toBe("2026-04-05T10:00:00.000Z");

    const path = ledgerWith([
      { ...ROW, ts: "2026-04-05T09:59:00.000Z", input_tokens: 999_999 },
      { ...ROW, ts: "2026-04-05T10:01:00.000Z" },
    ]);
    expect(conversationTokens(path, "aria", engine.startedAt()).input).toBe(100);
  });
});
