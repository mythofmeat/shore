import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  HISTORY_DB_FILE,
  HistoryStore,
  type MemoryDocumentState,
} from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import {
  HindsightRetainService,
  hindsightDocument,
} from "../src/memory/hindsight_retain_service.ts";
import type { MemoryBackend } from "../src/memory/backend.ts";
import { testTmp } from "./support/tmp.ts";

const ACCEPTED = {
  status: "accepted",
  message: "Memory storage initiated",
  operation_id: "3e96dcde-f9c0-47ef-8171-8228988a7acf",
};

const RETAIN_REJECTED = {
  status: "error",
  message:
    "Invalid timestamp format 'yesterday'. Expected ISO format like " +
    "'2024-01-15T10:30:00' or '2024-01-15T10:30:00Z'",
};

const DOCUMENT_MISSING = { error: "Document 'shore:ada:seg0' not found" };

const DELETED_MISSING = {
  status: "deleted",
  document_id: "shore:ada:seg0",
  document_deleted: 0,
  memory_units_deleted: 0,
};

const DELETED = {
  status: "deleted",
  document_id: "shore:ada:seg0",
  document_deleted: 1,
  memory_units_deleted: 8,
};

function operation(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: ACCEPTED.operation_id,
    status,
    operation_type: "batch_retain",
    created_at: "2026-08-30T02:09:35.094401+00:00",
    updated_at: "2026-08-30T02:09:35.094401+00:00",
    completed_at: null,
    error_message: null,
    retry_count: 0,
    next_retry_at: null,
    progress: null,
    details: null,
    result_metadata: { is_parent: true, document_id: "shore:ada:seg0", items_count: 1 },
    child_operations: [
      {
        operation_id: "7799b204-7473-4c26-a981-6bfcfa665c3d",
        status,
        sub_batch_index: 1,
        items_count: 1,
        error_message: null,
      },
    ],
    task_payload: null,
    ...extra,
  };
}

function document(id = "shore:ada:seg0"): Record<string, unknown> {
  return {
    id,
    bank_id: "ada",
    original_text: "Ren (2026-08-20T10:00:00+10:00): hello",
    content_hash: "f21782073d687d3125f8e2269b1d0d7a8efd48e301071d2b77d326906bc5b94e",
    memory_unit_count: 2,
    nodes_by_fact_type: { world: 1, experience: 1, observation: 0 },
    created_at: "2026-08-30T02:10:12.265966+00:00",
    updated_at: "2026-08-30T02:10:12.265966+00:00",
    tags: [],
    document_metadata: null,
    retain_params: { context: "A private conversation" },
    observation_scopes: null,
  };
}

function operations(rows: Record<string, unknown>[]): Record<string, unknown> {
  return { total: rows.length, operations: rows };
}

function operationRow(
  id: string,
  status: string,
  documentId: string | null,
  taskType = "batch_retain",
): Record<string, unknown> {
  return {
    id,
    task_type: taskType,
    items_count: 1,
    document_id: documentId,
    filename: null,
    mental_model_id: null,
    details: null,
    created_at: "2026-08-30T02:09:35.094401+00:00",
    updated_at: "2026-08-30T02:09:35.094401+00:00",
    status,
    error_message: null,
    retry_count: 0,
    next_retry_at: null,
    progress: null,
  };
}

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
    userName: "Ren",
    possessivePronoun: "her",
    timeoutMs: 1_000,
  });
}

function state(path: string, idx = 0): {
  status: MemoryDocumentState | undefined;
  attempts: number;
  error: string | undefined;
} {
  const store = HistoryStore.open(path);
  const record = store.entries("ada").find((entry) => entry.idx === idx);
  store.close();
  return {
    status: record?.memory_status,
    attempts: record?.memory_attempts ?? 0,
    error: record?.memory_error,
  };
}

function pending(path: string, now = Number.MAX_SAFE_INTEGER): boolean {
  const store = HistoryStore.open(path);
  const job = store.nextCharacterMemoryRetainJob("ada", now);
  store.close();
  return job !== undefined;
}

interface Recorded {
  name: string;
  args: Record<string, unknown>;
}

function recorder(
  reply: (tool: string, args: Record<string, unknown>) => unknown,
): {
  calls: Recorded[];
  tools: string[];
  backend: (character: string) => MemoryBackend | undefined;
} {
  const calls: Recorded[] = [];
  const backend: MemoryBackend = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const answer = reply(name, args);
      if (answer instanceof Error) throw answer;
      return await Promise.resolve(answer);
    },
  };
  return {
    calls,
    get tools() {
      return calls.map((entry) => entry.name);
    },
    backend: () => backend,
  };
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

describe("hindsight retain acknowledgement", () => {
  test("a segment is stored only once the operation completes and the document exists", async () => {
    const { path } = queuedHistory("hindsight-send");
    let now = 0;
    let finished = false;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation(finished ? "completed" : "processing");
      if (tool === "get_document") return finished ? document() : DOCUMENT_MISSING;
      return {};
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    expect(mcp.tools).toEqual(["retain"]);
    expect(mcp.calls[0]?.args).toMatchObject({ document_id: "shore:ada:seg0" });
    expect(state(path)).toMatchObject({ status: "submitted", attempts: 1 });

    now = 1_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_operation"]);
    expect(state(path)).toMatchObject({ status: "submitted" });

    finished = true;
    now = 2_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_operation", "get_operation", "get_document"]);
    expect(state(path)).toMatchObject({ status: "stored", attempts: 0 });

    now = 1_000_000;
    await service.runOnce();
    expect(mcp.calls).toHaveLength(4);
    await service.shutdown();
  });

  test("an accepted reply without an operation id stays queued with a diagnostic", async () => {
    const { path } = queuedHistory("hindsight-no-operation");
    const mcp = recorder((tool) =>
      tool === "retain"
        ? { status: "accepted", message: "Memory storage initiated" }
        : operations([])
    );
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);

    await service.runOnce();
    expect(state(path).status).toBe("pending");
    expect(state(path).error).toContain("did not accept the document");
    expect(state(path).attempts).toBe(1);
    await service.shutdown();
  });

  test("an empty reply stays queued with a diagnostic", async () => {
    const { path } = queuedHistory("hindsight-empty-reply");
    const mcp = recorder((tool) => (tool === "retain" ? {} : operations([])));
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);

    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 1 });
    expect(state(path).error).toContain("did not accept the document");
    await service.shutdown();
  });

  test("an unreadable reply stays queued with a diagnostic", async () => {
    const { path } = queuedHistory("hindsight-unreadable-reply");
    const mcp = recorder((tool) => (tool === "retain" ? "not json at all" : operations([])));
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);

    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 1 });
    expect(state(path).error).toContain("an unreadable reply");
    await service.shutdown();
  });

  test("an unknown status stays queued rather than counting as success", async () => {
    const { path } = queuedHistory("hindsight-unknown-status");
    const mcp = recorder((tool) =>
      tool === "retain" ? { status: "queued", operation_id: "op-1" } : operations([])
    );
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);

    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 1 });
    await service.shutdown();
  });

  test("the live in-band error shape stays queued and backs off", async () => {
    const { path } = queuedHistory("hindsight-inband-error");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return RETAIN_REJECTED;
      if (tool === "get_document") return DOCUMENT_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, { now: () => now });
    register(service, path);

    await service.runOnce();
    expect(state(path).error).toContain("Invalid timestamp format");
    expect(pending(path)).toBe(true);

    now = 999;
    await service.runOnce();
    expect(mcp.tools.filter((tool) => tool === "retain")).toHaveLength(1);

    now = 1_000;
    await service.runOnce();
    expect(mcp.tools.filter((tool) => tool === "retain")).toHaveLength(2);
    expect(state(path)).toMatchObject({ status: "pending", attempts: 2 });
    await service.shutdown();
  });

  test("retry exhaustion is durable across restarts and becomes terminal", async () => {
    const { path } = queuedHistory("hindsight-exhausted");
    let now = 0;
    let rejected = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        rejected += 1;
        return { status: "error", message: "document rejected" };
      }
      if (tool === "get_document") return DOCUMENT_MISSING;
      return operations([]);
    });
    const options = { now: () => now, maxAttempts: 3, confirmIntervalMs: 1_000 };

    let service = new HindsightRetainService(mcp.backend, options);
    register(service, path);
    await service.runOnce();
    await service.shutdown();

    service = new HindsightRetainService(mcp.backend, options);
    register(service, path);
    now = 999;
    await service.runOnce();
    expect(rejected).toBe(1);
    now = 1_000;
    await service.runOnce();
    expect(rejected).toBe(2);
    now = 2_999;
    await service.runOnce();
    expect(rejected).toBe(2);
    now = 3_000;
    await service.runOnce();

    expect(state(path)).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "hindsight retain: document rejected",
    });

    now = 1_000_000;
    await service.runOnce();
    expect(rejected).toBe(3);
    await service.shutdown();
  });

  test("a failing segment does not block the segments queued behind it", async () => {
    const { path } = queuedHistory("hindsight-not-blocking");
    const seeded = HistoryStore.open(path);
    seeded.putSegment("ada", 1, {
      file: HISTORY_DB_FILE,
      message_count: 1,
      compacted_at: "2026-08-22T12:00:00+10:00",
      retain: true,
    }, [message("u2", "user", "later segment", "2026-08-22T10:00:00+10:00")]);
    seeded.close();
    let now = 0;
    const mcp = recorder((tool, args) => {
      if (tool === "retain") {
        return args["document_id"] === "shore:ada:seg0"
          ? { status: "error", message: "document rejected" }
          : ACCEPTED;
      }
      if (tool === "get_document") return DOCUMENT_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      maxAttempts: 3,
      confirmIntervalMs: 1_000,
    });
    register(service, path);

    await service.runOnce();
    expect(state(path, 0).status).toBe("pending");
    now = 1;
    await service.runOnce();
    expect(state(path, 1).status).toBe("submitted");
    await service.shutdown();
  });
});

describe("hindsight retain confirmation", () => {
  test("a failed operation is resubmitted rather than recorded as stored", async () => {
    const { path } = queuedHistory("hindsight-operation-failed");
    let now = 0;
    let retains = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return ACCEPTED;
      }
      if (tool === "get_operation") {
        return retains === 1
          ? operation("failed", { error_message: "extraction provider unavailable" })
          : operation("completed");
      }
      if (tool === "get_document") return retains === 1 ? DOCUMENT_MISSING : document();
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending" });
    expect(state(path).error).toContain("extraction provider unavailable");

    await service.runOnce();
    expect(retains).toBe(2);
    expect(state(path).status).toBe("submitted");
    now = 2_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");
    await service.shutdown();
  });

  test("a completed operation that stored no document is resubmitted", async () => {
    const { path } = queuedHistory("hindsight-operation-empty");
    let now = 0;
    let retains = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return ACCEPTED;
      }
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return retains === 1 ? DOCUMENT_MISSING : document();
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("pending");
    expect(state(path).error).toContain("without storing shore:ada:seg0");

    await service.runOnce();
    now = 2_000;
    await service.runOnce();
    expect(retains).toBe(2);
    expect(state(path).status).toBe("stored");
    await service.shutdown();
  });

  test("a pruned operation is settled from the document itself", async () => {
    const { path } = queuedHistory("hindsight-operation-pruned");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") {
        return {
          operation_id: ACCEPTED.operation_id,
          status: "not_found",
          operation_type: null,
          created_at: null,
          updated_at: null,
          completed_at: null,
          error_message: null,
        };
      }
      if (tool === "get_document") return document();
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");
    await service.shutdown();
  });

  test("an operation that never finishes is resubmitted once the window closes", async () => {
    const { path } = queuedHistory("hindsight-operation-stuck");
    let now = 0;
    let retains = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return ACCEPTED;
      }
      if (tool === "get_operation") return operation("processing");
      if (tool === "get_document") return DOCUMENT_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 5_000,
    });
    register(service, path);

    await service.runOnce();
    for (now = 1_000; now < 5_000; now += 1_000) await service.runOnce();
    expect(state(path).status).toBe("submitted");
    expect(retains).toBe(1);

    now = 5_000;
    await service.runOnce();
    expect(state(path).status).toBe("pending");
    expect(state(path).error).toContain("confirmation window");
    await service.shutdown();
  });

  test("confirmation survives a restart between submission and completion", async () => {
    const { path } = queuedHistory("hindsight-restart");
    let now = 0;
    let finished = false;
    let retains = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return ACCEPTED;
      }
      if (tool === "get_operation") return operation(finished ? "completed" : "processing");
      if (tool === "get_document") return finished ? document() : DOCUMENT_MISSING;
      return operations([]);
    });
    const options = { now: () => now, confirmIntervalMs: 1_000, confirmWindowMs: 100_000 };

    let service = new HindsightRetainService(mcp.backend, options);
    register(service, path);
    await service.runOnce();
    expect(state(path).status).toBe("submitted");
    await service.shutdown();

    finished = true;
    service = new HindsightRetainService(mcp.backend, options);
    register(service, path);
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");
    expect(retains).toBe(1);
    await service.shutdown();
  });

  test("a lost acknowledgement adopts the in-flight operation instead of paying twice", async () => {
    const { path } = queuedHistory("hindsight-lost-ack");
    let now = 0;
    let retains = 0;
    let finished = false;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return new Error("retain timed out after 1000ms");
      }
      if (tool === "get_document") return finished ? document() : DOCUMENT_MISSING;
      if (tool === "get_operation") return operation(finished ? "completed" : "processing");
      return operations([
        operationRow("7799b204-7473-4c26-a981-6bfcfa665c3d", "processing", "shore:ada:seg0", "retain"),
        operationRow(ACCEPTED.operation_id, "processing", "shore:ada:seg0"),
        operationRow("48cb4aa0-0000-4000-8000-000000000000", "processing", "shore:ada:seg9"),
      ]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 1 });

    now = 1_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_document", "list_operations"]);
    expect(state(path).status).toBe("submitted");

    finished = true;
    now = 2_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");
    expect(retains).toBe(1);
    await service.shutdown();
  });

  test("a reconciliation that keeps failing still exhausts its attempts", async () => {
    const { path } = queuedHistory("hindsight-reconcile-broken");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return RETAIN_REJECTED;
      return new Error(`MCP server 'hindsight' is unavailable (${tool})`);
    });
    const service = new HindsightRetainService(mcp.backend, { now: () => now, maxAttempts: 3 });
    register(service, path);

    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 1 });
    now = 1_000;
    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 2 });
    now = 3_000;
    await service.runOnce();
    expect(state(path)).toMatchObject({ status: "failed", attempts: 3 });
    expect(state(path).error).toContain("is unavailable");
    await service.shutdown();
  });

  test("a resubmission adopts a document the lost submission already stored", async () => {
    const { path } = queuedHistory("hindsight-lost-ack-stored");
    let now = 0;
    let retains = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") {
        retains += 1;
        return new Error("retain timed out after 1000ms");
      }
      if (tool === "get_document") return retains === 1 ? document() : DOCUMENT_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");
    expect(retains).toBe(1);
    await service.shutdown();
  });
});

describe("hindsight exclusion", () => {
  test("a segment excluded before it is committed is never read or sent", async () => {
    const { path } = queuedHistory("hindsight-excluded", { excluded: true });
    const mcp = recorder(() => ({}));
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);
    await service.runOnce();
    expect(mcp.calls).toHaveLength(0);
    await service.shutdown();
  });

  test("excluding a segment that was never sent queues no delete", async () => {
    const { path } = queuedHistory("hindsight-exclude-unsent");
    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();
    const mcp = recorder(() => ({}));
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);
    await service.runOnce();
    expect(mcp.calls).toHaveLength(0);
    expect(state(path).status).toBeUndefined();
    await service.shutdown();
  });

  test("excluding a stored segment deletes its document, once", async () => {
    const { path } = queuedHistory("hindsight-exclude-after");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return document();
      if (tool === "delete_document") return DELETED;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);
    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");

    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();

    service.noteWork("ada");
    now = 2_000;
    await service.runOnce();
    expect(mcp.tools.at(-1)).toBe("delete_document");
    expect(state(path).status).toBeUndefined();

    service.noteWork("ada");
    now = 3_000;
    await service.runOnce();
    expect(mcp.tools.filter((tool) => tool === "delete_document")).toHaveLength(1);
    await service.shutdown();
  });

  test("excluding an in-flight segment waits for the operation before deleting", async () => {
    const { path } = queuedHistory("hindsight-exclude-inflight");
    let now = 0;
    let finished = false;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation(finished ? "completed" : "processing");
      if (tool === "get_document") return finished ? document() : DOCUMENT_MISSING;
      if (tool === "delete_document") return DELETED;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);
    await service.runOnce();
    expect(state(path).status).toBe("submitted");

    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();

    service.noteWork("ada");
    now = 1_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_operation"]);
    expect(state(path).status).toBe("submitted");

    finished = true;
    now = 2_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_operation", "get_operation", "delete_document"]);
    expect(state(path).status).toBeUndefined();
    await service.shutdown();
  });

  test("a delete of an already-missing document settles", async () => {
    const { path } = queuedHistory("hindsight-delete-missing");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return document();
      if (tool === "delete_document") return DELETED_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);
    await service.runOnce();
    now = 1_000;
    await service.runOnce();

    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    service.noteWork("ada");
    now = 2_000;
    await service.runOnce();
    expect(state(path).status).toBeUndefined();
    expect(pending(path)).toBe(false);
    await service.shutdown();
  });

  test("a delete that answers with a not-found error settles too", async () => {
    const { path } = queuedHistory("hindsight-delete-notfound", { retain: false });
    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    const mcp = recorder((tool) =>
      tool === "delete_document" ? { error: "Document 'shore:ada:seg0' not found" } : {}
    );
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);
    await service.runOnce();
    expect(mcp.tools).toEqual(["delete_document"]);
    expect(state(path).status).toBeUndefined();
    await service.shutdown();
  });

  test("excluding a segment backfill imported deletes its document", async () => {
    const { path } = queuedHistory("hindsight-adopt-backfill", { retain: false });
    const store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    store.close();
    const mcp = recorder(() => DELETED);
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);
    await service.runOnce();
    expect(mcp.tools).toEqual(["delete_document"]);
    await service.shutdown();
  });

  test("re-including a deleted segment queues a fresh retain", async () => {
    const { path } = queuedHistory("hindsight-reinclude");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return document();
      if (tool === "delete_document") return DELETED;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);
    await service.runOnce();
    now = 1_000;
    await service.runOnce();

    let store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    service.noteWork("ada");
    now = 2_000;
    await service.runOnce();
    expect(state(path).status).toBeUndefined();

    store = HistoryStore.open(path);
    expect(store.setExcluded("ada", 0, false, true)).toBe(true);
    store.close();
    expect(state(path)).toMatchObject({ status: "pending", attempts: 0 });

    service.noteWork("ada");
    now = 3_000;
    await service.runOnce();
    expect(mcp.tools.filter((tool) => tool === "retain")).toHaveLength(2);
    await service.shutdown();
  });

  test("re-including before the delete ran keeps the stored document", async () => {
    const { path } = queuedHistory("hindsight-reinclude-race");
    let now = 0;
    const mcp = recorder((tool) => {
      if (tool === "retain") return ACCEPTED;
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return document();
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);
    await service.runOnce();
    now = 1_000;
    await service.runOnce();
    expect(state(path).status).toBe("stored");

    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.setExcluded("ada", 0, false, true);
    store.close();

    service.noteWork("ada");
    now = 2_000;
    await service.runOnce();
    expect(mcp.tools).toEqual(["retain", "get_operation", "get_document"]);
    expect(state(path).status).toBe("stored");
    await service.shutdown();
  });

  test("a segment excluded mid-submission is deleted rather than confirmed", async () => {
    const { path } = queuedHistory("hindsight-exclude-race");
    let now = 0;
    const mcp = recorder((tool, args) => {
      if (tool === "retain") {
        const store = HistoryStore.open(path);
        store.setExcluded("ada", 0, true, true);
        store.close();
        return ACCEPTED;
      }
      if (tool === "get_operation") return operation("completed");
      if (tool === "get_document") return document();
      if (tool === "delete_document") {
        expect(args["document_id"]).toBe("shore:ada:seg0");
        return DELETED;
      }
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      confirmIntervalMs: 1_000,
      confirmWindowMs: 100_000,
    });
    register(service, path);

    await service.runOnce();
    expect(state(path).status).toBe("submitted");

    now = 1_000;
    await service.runOnce();
    now = 2_000;
    await service.runOnce();
    expect(mcp.tools).toContain("delete_document");
    expect(state(path).status).toBeUndefined();
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

    const mcp = recorder(() => ({}));
    const service = new HindsightRetainService(mcp.backend, { now: () => 0 });
    register(service, path);
    await service.runOnce();
    expect(mcp.calls).toHaveLength(0);
    expect(state(path).status).toBeUndefined();
    await service.shutdown();
  });
});

describe("hindsight retain scheduling", () => {
  test("an idle character opens history.db only for its safety sweep", async () => {
    const { path } = queuedHistory("hindsight-idle", { retain: false });
    let now = 0;
    const opens: number[] = [];
    const service = new HindsightRetainService(
      () => ({ call: async () => await Promise.resolve({}) }),
      {
        now: () => now,
        sweepIntervalMs: 3_600_000,
        openStore: (dbPath) => {
          opens.push(now);
          return HistoryStore.open(dbPath);
        },
      },
    );
    register(service, path);

    for (now = 0; now <= 6 * 3_600_000; now += 60_000) await service.runOnce();
    expect(opens).toEqual([
      0,
      3_600_000,
      7_200_000,
      10_800_000,
      14_400_000,
      18_000_000,
      21_600_000,
    ]);

    opens.length = 0;
    service.noteWork("ada");
    now += 30_000;
    await service.runOnce();
    expect(opens).toEqual([now]);
    await service.shutdown();
  });

  test("a retry deadline wakes the worker without polling in between", async () => {
    const { path } = queuedHistory("hindsight-deadline");
    let now = 0;
    const opens: number[] = [];
    const mcp = recorder((tool) => {
      if (tool === "retain") return RETAIN_REJECTED;
      if (tool === "get_document") return DOCUMENT_MISSING;
      return operations([]);
    });
    const service = new HindsightRetainService(mcp.backend, {
      now: () => now,
      sweepIntervalMs: 3_600_000,
      openStore: (dbPath) => {
        opens.push(now);
        return HistoryStore.open(dbPath);
      },
    });
    register(service, path);

    for (now = 0; now <= 4_000; now += 100) await service.runOnce();
    expect(opens).toEqual([0, 1_000, 3_000]);
    expect(state(path).attempts).toBe(3);
    await service.shutdown();
  });
});
