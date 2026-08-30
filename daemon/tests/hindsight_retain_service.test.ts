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

function queuedHistory(
  prefix: string,
  options: { excluded?: boolean; retain?: boolean } = {},
): { path: string; messages: Message[] } {
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
      retain: options.retain ?? true,
      ...(options.excluded === true ? { excluded: true } : {}),
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

function pending(path: string): boolean {
  const store = HistoryStore.open(path);
  const job = store.nextMemoryRetainJob("ada");
  store.close();
  return job !== undefined;
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
  test("sends a committed segment once and does not send it again", async () => {
    const { path } = queuedHistory("hindsight-send");
    const calls: { name: string; args: unknown }[] = [];
    const service = new HindsightRetainService({
      call: async (name, args) => {
        calls.push({ name, args });
        return { status: "accepted", operation_id: "op-1" };
      },
    });
    register(service, path);

    await service.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("mcp__hindsight__retain");
    expect(calls[0]?.args).toMatchObject({ document_id: "shore:ada:seg0" });
    expect(pending(path)).toBe(false);

    service.noteWork("ada");
    await service.runOnce();
    expect(calls).toHaveLength(1);
    await service.shutdown();
  });

  test("a retain that answers with an in-band error stays queued and backs off", async () => {
    const { path } = queuedHistory("hindsight-inband-error");
    let now = 0;
    let attempts = 0;
    const service = new HindsightRetainService(
      {
        call: async () => {
          attempts += 1;
          return { status: "error", message: "extraction provider unavailable" };
        },
      },
      { now: () => now },
    );
    register(service, path);

    await service.runOnce();
    expect(pending(path)).toBe(true);

    now = 999;
    await service.runOnce();
    expect(attempts).toBe(1);
    now = 1_000;
    await service.runOnce();
    expect(attempts).toBe(2);
    expect(pending(path)).toBe(true);
    await service.shutdown();
  });

  test("a transport failure is retried until it succeeds", async () => {
    const { path } = queuedHistory("hindsight-transport");
    let now = 0;
    let attempts = 0;
    const service = new HindsightRetainService(
      {
        call: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("offline");
          return { status: "accepted", operation_id: "op-1" };
        },
      },
      { now: () => now },
    );
    register(service, path);

    for (const at of [0, 1_000, 3_000]) {
      now = at;
      await service.runOnce();
    }
    expect(attempts).toBe(3);
    expect(pending(path)).toBe(false);
    await service.shutdown();
  });

  test("retry exhaustion is durable across restarts and becomes terminal", async () => {
    const { path } = queuedHistory("hindsight-exhausted");
    const seeded = HistoryStore.open(path);
    seeded.putSegment("ada", 1, {
      file: HISTORY_DB_FILE,
      message_count: 1,
      compacted_at: "2026-08-22T12:00:00+10:00",
      retain: true,
    }, [message("u2", "user", "later segment", "2026-08-22T10:00:00+10:00")]);
    seeded.close();
    let now = 0;
    let rejectedAttempts = 0;
    let acceptedAttempts = 0;
    const registry = {
      call: async () => {
        if (rejectedAttempts < 3) {
          rejectedAttempts += 1;
          return { status: "error", message: "document rejected" };
        }
        acceptedAttempts += 1;
        return { status: "accepted", operation_id: "op-2" };
      },
    };
    let service = new HindsightRetainService(registry, {
      now: () => now,
      maxAttempts: 3,
    });
    register(service, path);
    await service.runOnce();
    await service.shutdown();

    service = new HindsightRetainService(registry, {
      now: () => now,
      maxAttempts: 3,
    });
    register(service, path);
    await service.runOnce();
    now = 1_999;
    await service.runOnce();
    expect(rejectedAttempts).toBe(2);
    now = 2_000;
    await service.runOnce();

    let store = HistoryStore.open(path);
    expect(store.entries("ada")[0]).toMatchObject({
      memory_status: "failed",
      memory_attempts: 3,
      memory_error: "hindsight retain: document rejected",
    });
    expect(store.nextMemoryRetainJob("ada")).toMatchObject({ segment: 1, action: "retain" });
    store.close();

    await service.runOnce();
    store = HistoryStore.open(path);
    expect(store.entries("ada")[1]).toMatchObject({ memory_status: "stored" });
    expect(store.nextMemoryRetainJob("ada")).toBeUndefined();
    store.close();

    now = 1_000_000;
    await service.runOnce();
    expect({ rejectedAttempts, acceptedAttempts }).toEqual({
      rejectedAttempts: 3,
      acceptedAttempts: 1,
    });
    await service.shutdown();
  });

  test("a segment excluded before it is committed is never read or sent", async () => {
    const { path } = queuedHistory("hindsight-excluded", { excluded: true });
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

  test("excluding a sent segment deletes its document, once", async () => {
    const { path } = queuedHistory("hindsight-exclude-after");
    const calls: string[] = [];
    const service = new HindsightRetainService({
      call: async (name) => {
        calls.push(name);
        return { status: "accepted", operation_id: "op-1" };
      },
    });
    register(service, path);
    await service.runOnce();

    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();

    service.noteWork("ada");
    await service.runOnce();
    expect(calls).toEqual(["mcp__hindsight__retain", "mcp__hindsight__delete_document"]);
    expect(pending(path)).toBe(false);

    service.noteWork("ada");
    await service.runOnce();
    expect(calls).toHaveLength(2);
    await service.shutdown();
  });

  test("excluding a segment that was never sent queues no delete", async () => {
    const { path } = queuedHistory("hindsight-exclude-unsent");
    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
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

  test("excluding a segment backfill imported deletes its document", async () => {
    const { path } = queuedHistory("hindsight-adopt-backfill", { retain: false });
    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();
    const calls: string[] = [];
    const service = new HindsightRetainService({
      call: async (name) => {
        calls.push(name);
        return { status: "deleted" };
      },
    });
    register(service, path);
    await service.runOnce();
    expect(calls).toEqual(["mcp__hindsight__delete_document"]);
    await service.shutdown();
  });

  test("a delete of an already-missing document settles", async () => {
    const { path } = queuedHistory("hindsight-delete-missing");
    const service = new HindsightRetainService({
      call: async (name) => {
        if (name.endsWith("__delete_document")) {
          return { error: "Document 'shore:ada:seg0' not found" };
        }
        return { status: "accepted", operation_id: "op-1" };
      },
    });
    register(service, path);
    await service.runOnce();
    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    service.noteWork("ada");
    await service.runOnce();
    expect(pending(path)).toBe(false);
    await service.shutdown();
  });

  test("an empty segment is dropped rather than sent", async () => {
    const root = testTmp(`hindsight-empty-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const path = join(root, HISTORY_DB_FILE);
    const store = HistoryStore.open(path);
    const segment = store.beginCompaction(
      "ada",
      {
        file: HISTORY_DB_FILE,
        message_count: 1,
        compacted_at: "2026-08-21T12:00:00+10:00",
        retain: true,
      },
      [message("s1", "system", "housekeeping", "2026-08-20T10:00:00+10:00")],
      "before",
      "after",
    );
    store.finishCompaction("ada", segment);
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
    expect(pending(path)).toBe(false);
    await service.shutdown();
  });

  test("an idle character backs off and a mutation wakes it immediately", async () => {
    const { path } = queuedHistory("hindsight-idle", { retain: false });
    let now = 0;
    const service = new HindsightRetainService(
      { call: async () => ({}) },
      { now: () => now },
    );
    register(service, path);

    const ticked: number[] = [];
    const original = HistoryStore.open.bind(HistoryStore);
    (HistoryStore as unknown as { open: typeof HistoryStore.open }).open = (dbPath: string) => {
      ticked.push(now);
      return original(dbPath);
    };
    try {
      for (now = 0; now <= 20_000; now += 1_000) await service.runOnce();
      expect(ticked).toEqual([0, 1_000, 3_000, 7_000, 15_000]);

      ticked.length = 0;
      service.noteWork("ada");
      now = 20_500;
      await service.runOnce();
      expect(ticked).toEqual([20_500]);
    } finally {
      (HistoryStore as unknown as { open: typeof HistoryStore.open }).open = original;
      await service.shutdown();
    }
  });
});
