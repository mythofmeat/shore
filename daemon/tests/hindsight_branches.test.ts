import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  HISTORY_DB_FILE,
  HistoryStore,
  type MemoryDocumentState,
} from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { newMessageVersion, processingUnitId } from "../src/engine/versions.ts";
import { HindsightRetainService } from "../src/memory/hindsight_retain_service.ts";
import type { MemoryBackend } from "../src/memory/backend.ts";
import { importHistoryDatabase } from "../src/commands/archive_databases.ts";
import { exportHistoryDatabase } from "../src/commands/archive_databases.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

const ACCEPTED = {
  status: "accepted",
  message: "Memory storage initiated",
  operation_id: "3e96dcde-f9c0-47ef-8171-8228988a7acf",
};

function message(id: string, role: Message["role"], text: string, version: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: "2026-08-20T10:00:00+10:00",
    version,
  };
}

function root(prefix: string): string {
  const dir = testTmp(`${prefix}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function archive(path: string, key: string, messages: Message[]): void {
  const store = HistoryStore.open(path);
  const idx = store.beginCompaction(
    key,
    {
      file: HISTORY_DB_FILE,
      message_count: messages.length,
      compacted_at: "2026-08-21T12:00:00+10:00",
      retain: true,
    },
    messages,
    `before-${key}`,
    `after-${key}`,
  );
  store.finishCompaction(key, idx);
  store.close();
}

interface Recorded {
  name: string;
  args: Record<string, unknown>;
}

interface BackendOptions {
  settles?: () => boolean;
  failRetain?: () => boolean;
}

function backend(stored: Set<string>, options: BackendOptions = {}): {
  calls: Recorded[];
  backend: (character: string) => MemoryBackend | undefined;
} {
  const settles = options.settles ?? (() => true);
  const calls: Recorded[] = [];
  const memory: MemoryBackend = {
    call: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const raw = args["document_id"];
      const id = typeof raw === "string" ? raw : "";
      if (name === "retain") {
        if (options.failRetain?.() === true) {
          return Promise.resolve({ status: "error", message: "the backend refused it" });
        }
        if (settles()) stored.add(id);
        return Promise.resolve(ACCEPTED);
      }
      if (name === "get_document") {
        return stored.has(id)
          ? Promise.resolve({ id })
          : Promise.resolve({ error: `Document '${id}' not found` });
      }
      if (name === "delete_document") {
        stored.delete(id);
        return Promise.resolve({ status: "deleted", document_id: id, document_deleted: 1 });
      }
      if (name === "get_operation") {
        return Promise.resolve({
          status: settles() ? "completed" : "processing",
          operation_id: ACCEPTED.operation_id,
        });
      }
      if (name === "list_operations") return Promise.resolve({ total: 0, operations: [] });
      return Promise.resolve({});
    },
  };
  return { calls, backend: () => memory };
}

function service(
  memory: (character: string) => MemoryBackend | undefined,
  path: string,
  clock: () => number = () => 0,
): HindsightRetainService {
  const built = new HindsightRetainService(memory, {
    now: clock,
    confirmIntervalMs: 0,
    confirmWindowMs: 100_000,
  });
  built.register({
    character: "ada",
    historyPath: path,
    userName: "Ren",
    possessivePronoun: "her",
    timeoutMs: 1_000,
  });
  return built;
}

async function drain(built: HindsightRetainService, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await built.runOnce();
}

function statusOf(path: string, key: string, idx = 0): MemoryDocumentState | undefined {
  const store = HistoryStore.open(path);
  const record = store.entries(key).find((entry) => entry.idx === idx);
  store.close();
  return record?.memory_status;
}

function retainedIds(calls: readonly Recorded[]): string[] {
  return calls
    .filter((call) => call.name === "retain")
    .map((call) => {
      const id = call.args["document_id"];
      return typeof id === "string" ? id : "";
    });
}

describe("retaining a conversation that two threads share", () => {
  test("the parent retains it once and the child does not send it again", async () => {
    const path = join(root("hindsight-parent-first"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);
    archive(path, "ada/spin", shared);

    const stored = new Set<string>();
    const mcp = backend(stored);
    await drain(service(mcp.backend, path));

    expect(retainedIds(mcp.calls)).toEqual([
      `shore:ada:${processingUnitId([required(shared[0]).version ?? ""])}`,
    ]);
    expect(statusOf(path, "ada")).toBe("stored");
    expect(statusOf(path, "ada/spin")).toBe("stored");
  });

  test("either branch may be the one that does the work", async () => {
    const path = join(root("hindsight-child-first"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada/spin", shared);
    archive(path, "ada", shared);

    const stored = new Set<string>();
    const mcp = backend(stored);
    await drain(service(mcp.backend, path));

    expect(retainedIds(mcp.calls)).toHaveLength(1);
    expect(statusOf(path, "ada")).toBe("stored");
    expect(statusOf(path, "ada/spin")).toBe("stored");
  });

  test("a branch that added turns retains only what it added", async () => {
    const path = join(root("hindsight-mixed"), HISTORY_DB_FILE);
    const inherited = message("u1", "user", "hello", newMessageVersion());
    const fresh = message("u2", "user", "and another thing", newMessageVersion());
    archive(path, "ada", [inherited]);
    archive(path, "ada/spin", [inherited, fresh]);

    const stored = new Set<string>();
    const mcp = backend(stored);
    await drain(service(mcp.backend, path));

    const sent = mcp.calls.filter((call) => call.name === "retain");
    expect(sent).toHaveLength(2);
    const bodies = sent.map((call) => {
      const body = call.args["content"];
      return typeof body === "string" ? body : "";
    });
    expect(bodies.some((body) => body.includes("hello") && !body.includes("another"))).toBe(true);
    expect(bodies.some((body) => body.includes("another") && !body.includes("hello"))).toBe(true);
  });

  test("excluding one occurrence keeps the shared document that the other still needs", async () => {
    const path = join(root("hindsight-exclude"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);
    archive(path, "ada/spin", shared);

    const stored = new Set<string>();
    const mcp = backend(stored);
    const built = service(mcp.backend, path);
    await drain(built);
    const documentId = required(retainedIds(mcp.calls)[0]);

    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    built.noteWork("ada");
    await drain(built);

    expect(stored.has(documentId)).toBe(true);
    expect(mcp.calls.some((call) => call.name === "delete_document")).toBe(false);
  });

  test("excluding the last occurrence deletes it and frees the material again", async () => {
    const path = join(root("hindsight-exclude-last"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);
    archive(path, "ada/spin", shared);

    const stored = new Set<string>();
    const mcp = backend(stored);
    const built = service(mcp.backend, path);
    await drain(built);
    const documentId = required(retainedIds(mcp.calls)[0]);

    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.setExcluded("ada/spin", 0, true, true);
    store.close();
    built.noteWork("ada");
    await drain(built);

    expect(stored.has(documentId)).toBe(false);
    const after = HistoryStore.open(path);
    expect(
      after.coveredMemoryVersions("ada", "hindsight", [required(required(shared[0]).version)]).size,
    ).toBe(0);
    after.close();
  });

  test("re-including an occupant restores its eligibility without a second copy", async () => {
    const path = join(root("hindsight-reinclude"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);
    archive(path, "ada/spin", shared);

    const stored = new Set<string>();
    const mcp = backend(stored);
    const built = service(mcp.backend, path);
    await drain(built);
    const documentId = required(retainedIds(mcp.calls)[0]);

    const store = HistoryStore.open(path);
    store.setExcluded("ada", 0, true, true);
    store.close();
    built.noteWork("ada");
    await drain(built);

    const back = HistoryStore.open(path);
    back.setExcluded("ada", 0, false, true);
    back.close();
    built.noteWork("ada");
    await drain(built);

    expect(retainedIds(mcp.calls)).toEqual([documentId]);
    expect(
      HistoryStore.open(path).eligibleDocumentOccurrences("ada", "hindsight", documentId),
    ).toEqual([
      { archive_key: "ada", segment: 0 },
      { archive_key: "ada/spin", segment: 0 },
    ]);
  });

  test("an import into a different backend re-submits rather than trusting the old success", async () => {
    const source = join(root("hindsight-export"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(source, "ada", shared);
    archive(source, "ada/spin", shared);

    const stored = new Set<string>();
    await drain(service(backend(stored).backend, source));
    expect(statusOf(source, "ada")).toBe("stored");

    const staging = join(root("hindsight-staging"), "history.db");
    exportHistoryDatabase(source, "ada", staging);
    const destination = join(root("hindsight-import"), HISTORY_DB_FILE);
    importHistoryDatabase(destination, staging, "ada");

    expect(statusOf(destination, "ada")).toBe("pending");
    const imported = HistoryStore.open(destination);
    expect(
      imported.coveredMemoryVersions("ada", "hindsight", [required(required(shared[0]).version)])
        .size,
    ).toBe(0);
    expect(imported.threadForks("ada")).toEqual([]);
    imported.close();

    const freshBackend = new Set<string>();
    const mcp = backend(freshBackend);
    await drain(service(mcp.backend, destination));
    expect(retainedIds(mcp.calls)).toHaveLength(1);
  });

  test("lineage survives export and import", async () => {
    const source = join(root("fork-export"), HISTORY_DB_FILE);
    const store = HistoryStore.open(source);
    store.recordThreadFork("ada", {
      fork_id: "fk_1",
      child: "spin",
      source: "main",
      created_at: "2026-09-05T00:00:00Z",
      message_count: 3,
      turn_count: 1,
    });
    store.putSegment(
      "ada",
      0,
      { file: HISTORY_DB_FILE, message_count: 1, compacted_at: "2026-09-05T00:00:00Z" },
      [message("u1", "user", "hello", newMessageVersion())],
    );
    store.close();

    const staging = join(root("fork-staging"), "history.db");
    exportHistoryDatabase(source, "ada", staging);
    const destination = join(root("fork-import"), HISTORY_DB_FILE);
    importHistoryDatabase(destination, staging, "ada");

    const imported = HistoryStore.open(destination);
    expect(imported.forkAncestry("ada", "spin").map((fork) => fork.source)).toEqual(["main"]);
    imported.close();
  });
});

describe("what a submitted document does and does not prove", () => {
  test("a document in flight is not coverage, so the other branch waits rather than skipping", async () => {
    const path = join(root("hindsight-inflight"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);
    archive(path, "ada/spin", shared);

    const stored = new Set<string>();
    const mcp = backend(stored, { settles: () => false });
    await drain(service(mcp.backend, path), 3);

    expect(statusOf(path, "ada")).toBe("submitted");
    expect(statusOf(path, "ada/spin")).not.toBe("stored");
    const store = HistoryStore.open(path);
    expect(
      store.coveredMemoryVersions("ada", "hindsight", [required(required(shared[0]).version)]).size,
    ).toBe(0);
    store.close();
  });

  test("a confirmed document records the occurrence that supports it", async () => {
    const path = join(root("hindsight-occurrence"), HISTORY_DB_FILE);
    archive(path, "ada", [message("u1", "user", "hello", newMessageVersion())]);

    const stored = new Set<string>();
    const mcp = backend(stored);
    await drain(service(mcp.backend, path));
    const documentId = required(retainedIds(mcp.calls)[0]);

    const store = HistoryStore.open(path);
    expect(store.eligibleDocumentOccurrences("ada", "hindsight", documentId)).toEqual([
      { archive_key: "ada", segment: 0 },
    ]);
    store.close();
  });

  test("a retain the backend refuses gives its material back to the next attempt", async () => {
    const path = join(root("hindsight-failed"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);

    const stored = new Set<string>();
    let refuse = true;
    let clock = 0;
    const mcp = backend(stored, { failRetain: () => refuse });
    const built = service(mcp.backend, path, () => clock);
    await built.runOnce();

    expect(statusOf(path, "ada")).toBe("pending");
    const store = HistoryStore.open(path);
    expect(
      store.memoryCoverageState("ada", "hindsight", required(required(shared[0]).version)),
    ).toBeUndefined();
    store.close();

    refuse = false;
    clock = 10 ** 7;
    built.noteWork("ada");
    await drain(built);
    expect(statusOf(path, "ada")).toBe("stored");
  });
});

describe("what a coverage record remembers", () => {
  test("committing files the material under the document that actually covered it", () => {
    const path = join(root("coverage-unit"), HISTORY_DB_FILE);
    const store = HistoryStore.open(path);
    const version = newMessageVersion();
    store.claimMemoryCoverage("ada", "hindsight", [version], "claim", "tentative", 0, 60_000);
    store.commitMemoryCoverage("ada", "hindsight", "claim", "settled");

    expect(store.memoryUnitsFor("ada", "hindsight", [version])).toEqual(["settled"]);
    store.close();
  });

  test("a document that never confirmed leaves no unit behind to adopt", () => {
    const path = join(root("coverage-unit-uncommitted"), HISTORY_DB_FILE);
    const store = HistoryStore.open(path);
    const version = newMessageVersion();
    store.claimMemoryCoverage("ada", "hindsight", [version], "claim", "tentative", 0, 60_000);

    expect(store.memoryUnitsFor("ada", "hindsight", [version])).toEqual([]);
    store.close();
  });

  test("the unit filed is the document's own, even when another pass held part of the range", async () => {
    const path = join(root("coverage-partial-claim"), HISTORY_DB_FILE);
    const held = message("u1", "user", "held elsewhere", newMessageVersion());
    const mine = message("u2", "user", "mine to write", newMessageVersion());
    archive(path, "ada", [held, mine]);

    const before = HistoryStore.open(path);
    before.claimMemoryCoverage(
      "ada",
      "hindsight",
      [required(held.version)],
      "someone-else",
      "their-unit",
      0,
      60_000,
    );
    before.close();

    const stored = new Set<string>();
    const mcp = backend(stored);
    await drain(service(mcp.backend, path));

    const documentId = required(retainedIds(mcp.calls)[0]);
    expect(documentId).toBe(`shore:ada:${processingUnitId([required(mine.version)])}`);
    const store = HistoryStore.open(path);
    expect(store.memoryUnitsFor("ada", "hindsight", [required(mine.version)])).toEqual([
      processingUnitId([required(mine.version)]),
    ]);
    store.close();
  });

  test("a resubmission after a lost operation reclaims its own material", async () => {
    const path = join(root("hindsight-requeue"), HISTORY_DB_FILE);
    const shared = [message("u1", "user", "hello", newMessageVersion())];
    archive(path, "ada", shared);

    const stored = new Set<string>();
    let settles = false;
    let clock = 0;
    const mcp = backend(stored, { settles: () => settles });
    const built = service(mcp.backend, path, () => clock);
    await drain(built, 3);
    expect(statusOf(path, "ada")).toBe("submitted");

    clock = 10 ** 7;
    settles = true;
    built.noteWork("ada");
    await drain(built);
    expect(statusOf(path, "ada")).toBe("stored");
    const store = HistoryStore.open(path);
    expect(
      store.coveredMemoryVersions("ada", "hindsight", [required(required(shared[0]).version)]).size,
    ).toBe(1);
    store.close();
  });
});
