import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import {
  HindsightRetainService,
  hindsightDocument,
} from "../src/memory/hindsight_retain_service.ts";
import { testTmp } from "./support/tmp.ts";

function message(
  id: string,
  role: Message["role"],
  text: string,
  timestamp: string,
): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp,
  };
}

function queuedHistory(prefix: string): { path: string; messages: Message[] } {
  const root = testTmp(`${prefix}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, HISTORY_DB_FILE);
  const messages = [
    message("u1", "user", "hello", "2026-08-20T10:00:00+10:00"),
    message("a1", "assistant", "hi there", "2026-08-21T11:00:00+10:00"),
  ];
  const store = HistoryStore.open(path);
  const segment = store.beginCompaction(
    "ada",
    {
      file: HISTORY_DB_FILE,
      message_count: messages.length,
      compacted_at: "2026-08-21T12:00:00+10:00",
      retain: true,
    },
    messages,
    "before",
    "after",
  );
  store.finishCompaction("ada", segment);
  store.close();
  return { path, messages };
}

function register(service: HindsightRetainService, path: string): void {
  service.register({
    character: "ada",
    historyPath: path,
    server: "hindsight",
    userName: "Ren",
    possessivePronoun: "her",
    timeoutMs: 1_000,
  });
}

describe("hindsight archive documents", () => {
  test("matches the backfill format and ignores system and non-text blocks", () => {
    const messages = [
      message("s1", "system", "not retained", "2026-08-19T00:00:00Z"),
      message("u1", "user", "hello", "2026-08-20T10:00:00+10:00"),
      {
        ...message("a1", "assistant", "", "2026-08-21T11:00:00+10:00"),
        content_blocks: [
          { type: "text" as const, text: "one" },
          { type: "tool_use" as const, id: "t1", name: "read", input: {} },
          { type: "text" as const, text: "two" },
        ],
      },
    ];

    expect(hindsightDocument("ada", 7, messages, "Ren", "her")).toEqual({
      content:
        "Ren (2026-08-20T10:00:00+10:00): hello\n\n" +
        "ada (2026-08-21T11:00:00+10:00): one  two",
      context:
        "A private conversation between Ren and ada, her partner. Constant teasing, insults, " +
        "mock-outrage and running jokes are how they show affection -- an insult is a joke, " +
        "not a description, and a nickname is not a fact about anyone. Record what each of " +
        "them states about their own life, plans and feelings, attributing it to whichever of " +
        "them said it. Never convert banter, hypotheticals, or things they imagine or roleplay " +
        "into biography. This session took place from 2026-08-20 to 2026-08-21.",
      documentId: "shore:ada:seg7",
    });
  });
});

describe("hindsight retain service", () => {
  test("submits a queued segment without waiting for extraction and cleans it up when excluded", async () => {
    const { path } = queuedHistory("hindsight-submit");
    const calls: { name: string; args: unknown }[] = [];
    const service = new HindsightRetainService({
      call: async (name, args) => {
        calls.push({ name, args });
        return name.endsWith("__retain") ? { operation_id: "op-1" } : { success: true };
      },
    });
    register(service, path);

    await service.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "mcp__hindsight__retain",
      args: {
        content:
          "Ren (2026-08-20T10:00:00+10:00): hello\n\n" +
          "ada (2026-08-21T11:00:00+10:00): hi there",
        document_id: "shore:ada:seg0",
      },
    });
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("retain call missing");
    expect((firstCall.args as { context: string }).context).toContain("her partner");

    let store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toMatchObject({
      status: "submitted",
      remote_operation_id: "op-1",
    });
    expect(store.setExcluded("ada", 0, true)).toBe(true);
    expect(store.nextMemoryRetainJob("ada", 0)).toMatchObject({
      status: "delete_pending",
      remote_operation_id: "op-1",
    });
    store.close();

    await service.runOnce();
    expect(calls.slice(1)).toEqual([
      {
        name: "mcp__hindsight__cancel_operation",
        args: { operation_id: "op-1" },
      },
      {
        name: "mcp__hindsight__delete_document",
        args: { document_id: "shore:ada:seg0" },
      },
    ]);
    store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    store.close();
    await service.shutdown();
  });

  test("persists submission failures and respects exponential retry time", async () => {
    const { path } = queuedHistory("hindsight-retry");
    let now = 10_000;
    let attempts = 0;
    const service = new HindsightRetainService(
      {
        call: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return { success: true };
        },
      },
      { now: () => now },
    );
    register(service, path);

    await service.runOnce();
    let store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", 10_999)).toBeUndefined();
    expect(store.nextMemoryRetainJob("ada", 11_000)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "offline",
    });
    store.close();

    now = 10_999;
    await service.runOnce();
    expect(attempts).toBe(1);
    now = 11_000;
    await service.runOnce();
    expect(attempts).toBe(2);
    store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    store.close();
    await service.shutdown();
  });

  test("polls accepted operations and retries failed extraction", async () => {
    const { path } = queuedHistory("hindsight-operation-retry");
    let now = 0;
    let submissions = 0;
    const calls: string[] = [];
    const service = new HindsightRetainService(
      {
        call: async (name) => {
          calls.push(name);
          if (name.endsWith("__retain")) {
            submissions += 1;
            return submissions === 1 ? { operation_id: "op-failed" } : { success: true };
          }
          return { status: "failed", error: "extractor stopped" };
        },
      },
      { now: () => now, pollIntervalMs: 100 },
    );
    register(service, path);

    await service.runOnce();
    now = 100;
    await service.runOnce();
    let store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", 2_099)).toBeUndefined();
    expect(store.nextMemoryRetainJob("ada", 2_100)).toMatchObject({
      status: "pending",
      last_error: "extractor stopped",
    });
    store.close();

    now = 2_100;
    await service.runOnce();
    expect(submissions).toBe(2);
    expect(calls).toEqual([
      "mcp__hindsight__retain",
      "mcp__hindsight__get_operation",
      "mcp__hindsight__retain",
    ]);
    store = HistoryStore.open(path);
    expect(store.nextMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    store.close();
    await service.shutdown();
  });

  test("an excluded segment is never read or retained", async () => {
    const { path } = queuedHistory("hindsight-excluded");
    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true)).toBe(true);
    store.close();
    let calls = 0;
    const service = new HindsightRetainService({
      call: async () => {
        calls += 1;
        return {};
      },
    });
    register(service, path);
    await service.runOnce();
    expect(calls).toBe(0);
    await service.shutdown();
  });
});
