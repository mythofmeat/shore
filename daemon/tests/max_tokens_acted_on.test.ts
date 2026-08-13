import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hitTokenCeiling } from "../src/llm/finish_reason.ts";
import { recordingStream } from "../src/ledger/record.ts";
import { Ledger } from "../src/ledger/store.ts";
import type { CallContext, SidecarRequest, StreamEvent } from "../src/llm/types.ts";

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

function freshLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "shore-maxtok-")), "ledger.db");
}

function ctxFor(ledger: string): CallContext {
  return { ledger, character: "Rhia", call_type: "message", thinking_enabled: false };
}

const REQ: SidecarRequest = {
  sdk: "anthropic",
  model: "claude-opus-5",
  api_key: "sk-test",
  messages: [],
  system: [],
} as unknown as SidecarRequest;

async function drain(events: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _event of events) {
    // consume
  }
}

async function* died(text: string): AsyncIterable<StreamEvent> {
  yield { type: "start", model: "claude-opus-5" };
  yield { type: "text", text };
  yield {
    type: "error",
    message: "stream closed",
    usage: EMPTY_USAGE,
    timing: { total_ms: 12, time_to_first_token_ms: 5 },
  };
}

async function* cancelledAfter(text: string): AsyncIterable<StreamEvent> {
  yield { type: "start", model: "claude-opus-5" };
  yield { type: "text", text };
}

function rowsOf(path: string): Array<Record<string, unknown>> {
  const ledger = Ledger.open(path);
  try {
    return ledger.database
      .query("SELECT finish_reason, output_tokens, output_tokens_estimated FROM calls ORDER BY id")
      .all() as Array<Record<string, unknown>>;
  } finally {
    ledger.close();
  }
}

describe("hitTokenCeiling", () => {
  test("covers both spellings providers use, and nothing else", () => {
    expect(hitTokenCeiling("max_tokens")).toBe(true);
    expect(hitTokenCeiling("length")).toBe(true);
    expect(hitTokenCeiling("end_turn")).toBe(false);
    expect(hitTokenCeiling("tool_use")).toBe(false);
    expect(hitTokenCeiling("stop")).toBe(false);
  });
});

describe("a stream that dies before the usage frame", () => {
  test("records the output it saw instead of zero, and marks it an estimate", async () => {
    const path = freshLedgerPath();
    await drain(recordingStream(ctxFor(path), REQ, died("x".repeat(400))));

    const rows = rowsOf(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["finish_reason"]).toBe("error");
    expect(rows[0]?.["output_tokens"]).toBe(125);
    expect(rows[0]?.["output_tokens_estimated"]).toBe(1);
  });

  test("a cancel partway through is recorded the same way", async () => {
    const path = freshLedgerPath();
    await drain(recordingStream(ctxFor(path), REQ, cancelledAfter("y".repeat(40))));

    const rows = rowsOf(path);
    expect(rows[0]?.["finish_reason"]).toBe("cancelled");
    expect(rows[0]?.["output_tokens"]).toBe(13);
    expect(rows[0]?.["output_tokens_estimated"]).toBe(1);
  });

  test("a stream that produced nothing is still recorded as zero, not estimated", async () => {
    const path = freshLedgerPath();
    await drain(recordingStream(ctxFor(path), REQ, cancelledAfter("")));

    const rows = rowsOf(path);
    expect(rows[0]?.["output_tokens"]).toBe(0);
    expect(rows[0]?.["output_tokens_estimated"]).toBe(0);
  });

  test("a normal completion is untouched — billed usage still wins", async () => {
    const path = freshLedgerPath();
    async function* ok(): AsyncIterable<StreamEvent> {
      yield { type: "start", model: "claude-opus-5" };
      yield { type: "text", text: "hello" };
      yield {
        type: "done",
        content: "hello",
        finish_reason: "end_turn",
        usage: { ...EMPTY_USAGE, output_tokens: 3 },
        timing: { total_ms: 9, time_to_first_token_ms: 2 },
      };
    }
    await drain(recordingStream(ctxFor(path), REQ, ok()));

    const rows = rowsOf(path);
    expect(rows[0]?.["output_tokens"]).toBe(3);
    expect(rows[0]?.["output_tokens_estimated"]).toBe(0);
  });
});
