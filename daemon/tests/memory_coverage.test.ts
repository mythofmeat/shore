import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { newMessageVersion, processingUnitId } from "../src/engine/versions.ts";
import { claimUncovered, coverageIsRedundant } from "../src/memory/coverage.ts";
import {
  hindsightUnitFor,
  type HindsightUnit,
} from "../src/memory/hindsight_retain_service.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

const STAMP = "2026-09-05T00:00:00Z";

function store(): HistoryStore {
  return HistoryStore.openInMemory();
}

function onDisk(prefix: string): { path: string } {
  const root = testTmp(`${prefix}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return { path: join(root, HISTORY_DB_FILE) };
}

function message(text: string, version?: string): Message {
  return {
    msg_id: `m_${text}`,
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: STAMP,
    ...(version === undefined ? {} : { version }),
  };
}

function archive(
  history: HistoryStore,
  key: string,
  idx: number,
  messages: Message[],
  options: { retain?: boolean } = {},
): void {
  history.putSegment(
    key,
    idx,
    {
      file: HISTORY_DB_FILE,
      message_count: messages.length,
      compacted_at: STAMP,
      retain: options.retain ?? true,
    },
    messages,
  );
}

describe("durable coverage for a memory path", () => {
  test("a claim is not coverage until it is committed", () => {
    const history = store();
    const version = newMessageVersion();
    const claimed = history.claimMemoryCoverage(
      "ada",
      "compaction",
      [version],
      "claim-1",
      "unit-1",
      1_000,
      60_000,
    );
    expect(claimed).toEqual([version]);
    expect(history.coveredMemoryVersions("ada", "compaction", [version]).size).toBe(0);

    history.commitMemoryCoverage("ada", "compaction", "claim-1");
    expect([...history.coveredMemoryVersions("ada", "compaction", [version])]).toEqual([version]);
    history.close();
  });

  test("two branches racing for the same material: one claims it, the other gets nothing", () => {
    const history = store();
    const version = newMessageVersion();
    const first = history.claimMemoryCoverage(
      "ada", "compaction", [version], "parent", "unit", 1_000, 60_000,
    );
    const second = history.claimMemoryCoverage(
      "ada", "compaction", [version], "child", "unit", 1_000, 60_000,
    );
    expect(first).toEqual([version]);
    expect(second).toEqual([]);
    history.close();
  });

  test("an abandoned claim is reclaimable once its lease runs out", () => {
    const history = store();
    const version = newMessageVersion();
    history.claimMemoryCoverage("ada", "compaction", [version], "crashed", "u", 1_000, 60_000);
    expect(
      history.claimMemoryCoverage("ada", "compaction", [version], "next", "u", 30_000, 60_000),
    ).toEqual([]);
    expect(
      history.claimMemoryCoverage("ada", "compaction", [version], "next", "u", 120_000, 60_000),
    ).toEqual([version]);
    history.close();
  });

  test("a released claim leaves the material unprocessed rather than covered", () => {
    const history = store();
    const version = newMessageVersion();
    history.claimMemoryCoverage("ada", "compaction", [version], "failed", "u", 0, 60_000);
    history.releaseMemoryCoverage("ada", "compaction", "failed");
    expect(history.coveredMemoryVersions("ada", "compaction", [version]).size).toBe(0);
    expect(
      history.claimMemoryCoverage("ada", "compaction", [version], "retry", "u", 0, 60_000),
    ).toEqual([version]);
    history.close();
  });

  test("the two memory paths cover material independently", () => {
    const history = store();
    const version = newMessageVersion();
    history.claimMemoryCoverage("ada", "compaction", [version], "c", "u", 0, 60_000);
    history.commitMemoryCoverage("ada", "compaction", "c");
    expect(history.coveredMemoryVersions("ada", "hindsight", [version]).size).toBe(0);
    history.close();
  });

  test("coverage is scoped to the character, so imported names cannot collide", () => {
    const history = store();
    const version = newMessageVersion();
    history.claimMemoryCoverage("ada", "compaction", [version], "c", "u", 0, 60_000);
    history.commitMemoryCoverage("ada", "compaction", "c");
    expect(history.coveredMemoryVersions("bo", "compaction", [version]).size).toBe(0);
    history.close();
  });

  test("legacy messages with no version are never treated as covered", () => {
    const history = store();
    const planned = claimUncovered(history, "ada", "compaction", [message("legacy")]);
    expect(planned.claimed).toEqual([]);
    expect(planned.unversioned).toBe(1);
    expect(coverageIsRedundant(planned)).toBe(false);
    history.close();
  });

  test("a range whose every version is covered needs no second pass", () => {
    const history = store();
    const messages = [message("one", newMessageVersion()), message("two", newMessageVersion())];
    const first = claimUncovered(history, "ada", "compaction", messages);
    history.commitMemoryCoverage("ada", "compaction", first.claim);

    const second = claimUncovered(history, "ada", "compaction", messages);
    expect(second.claimed).toEqual([]);
    expect(second.covered).toHaveLength(2);
    expect(coverageIsRedundant(second)).toBe(true);
    history.close();
  });

  test("a mixed range claims only the new material and keeps the rest as background", () => {
    const history = store();
    const inherited = message("inherited", newMessageVersion());
    const first = claimUncovered(history, "ada", "compaction", [inherited]);
    history.commitMemoryCoverage("ada", "compaction", first.claim);

    const fresh = message("fresh", newMessageVersion());
    const second = claimUncovered(history, "ada", "compaction", [inherited, fresh]);
    expect(second.claimed).toEqual([required(fresh.version)]);
    expect(second.covered).toEqual([required(inherited.version)]);
    expect(coverageIsRedundant(second)).toBe(false);
    history.close();
  });

  test("a processing unit is the material it covers, not the segment it came from", () => {
    const one = newMessageVersion();
    const two = newMessageVersion();
    expect(processingUnitId([one, two])).toBe(processingUnitId([one, two]));
    expect(processingUnitId([one, two])).not.toBe(processingUnitId([two, one]));
    expect(processingUnitId([one])).not.toBe(processingUnitId([one, two]));
  });
});

describe("compaction coverage and the archive commit", () => {
  test("coverage lands with the segment, not before it", () => {
    const { path } = onDisk("coverage-commit");
    const history = HistoryStore.open(path);
    const messages = [message("archived", newMessageVersion())];
    const planned = claimUncovered(history, "ada", "compaction", messages);

    const idx = history.beginCompaction(
      "ada",
      { file: HISTORY_DB_FILE, message_count: 1, compacted_at: STAMP },
      messages,
      "before",
      "after",
      planned.claim,
    );
    expect(history.coveredMemoryVersions("ada", "compaction", [required(required(messages[0]).version)]).size).toBe(0);

    history.finishCompaction("ada", idx);
    expect(history.coveredMemoryVersions("ada", "compaction", [required(required(messages[0]).version)]).size).toBe(1);
    history.close();
  });

  test("an aborted archive gives the material back rather than marking it done", () => {
    const { path } = onDisk("coverage-abort");
    const history = HistoryStore.open(path);
    const messages = [message("archived", newMessageVersion())];
    const planned = claimUncovered(history, "ada", "compaction", messages);
    const idx = history.beginCompaction(
      "ada",
      { file: HISTORY_DB_FILE, message_count: 1, compacted_at: STAMP },
      messages,
      "before",
      "after",
      planned.claim,
    );

    history.abortCompaction("ada", idx);
    expect(history.memoryCoverageState("ada", "compaction", required(required(messages[0]).version))).toBeUndefined();
    history.close();
  });

  test("a crash after the memory write but before the commit leaves a claim, not coverage", () => {
    const { path } = onDisk("coverage-crash");
    const first = HistoryStore.open(path);
    const version = newMessageVersion();
    first.claimMemoryCoverage("ada", "compaction", [version], "crashed", "u", 1_000, 60_000);
    first.close();

    const restarted = HistoryStore.open(path);
    expect(restarted.coveredMemoryVersions("ada", "compaction", [version]).size).toBe(0);
    expect(restarted.memoryCoverageState("ada", "compaction", version)?.state).toBe("claimed");
    expect(
      restarted.claimMemoryCoverage("ada", "compaction", [version], "after", "u", 10 ** 7, 60_000),
    ).toEqual([version]);
    restarted.close();
  });

  test("a thread archive's coverage travels under the archive key's character", () => {
    const { path } = onDisk("coverage-thread");
    const history = HistoryStore.open(path);
    const messages = [message("side", newMessageVersion())];
    const planned = claimUncovered(history, "ada", "compaction", messages);
    const idx = history.beginCompaction(
      "ada/side",
      { file: HISTORY_DB_FILE, message_count: 1, compacted_at: STAMP },
      messages,
      "before",
      "after",
      planned.claim,
    );
    history.finishCompaction("ada/side", idx);
    expect(history.coveredMemoryVersions("ada", "compaction", [required(required(messages[0]).version)]).size).toBe(1);
    history.close();
  });
});

function unitFor(
  history: HistoryStore,
  key: string,
  idx: number,
  nowMs: number,
): HindsightUnit {
  const plan = hindsightUnitFor(history, key, idx, nowMs);
  if (plan.kind !== "unit") throw new Error(`expected a unit, got ${plan.kind}`);
  return plan;
}

describe("hindsight processing units across branches", () => {
  test("a segment of unprocessed material submits one document for that material", () => {
    const history = store();
    const messages = [message("one", newMessageVersion()), message("two", newMessageVersion())];
    archive(history, "ada", 0, messages);

    const unit = unitFor(history, "ada", 0, 1_000);
    expect(unit.messages).toHaveLength(2);
    expect(unit.background).toBe(0);
    expect(unit.documentId).toBe(
      `shore:ada:${processingUnitId(messages.map((m) => required(m.version)))}`,
    );
    history.close();
  });

  test("a shared unit takes the same document id from either branch", () => {
    const history = store();
    const messages = [message("one", newMessageVersion())];
    archive(history, "ada", 0, messages);
    archive(history, "ada/spin", 0, messages);

    const parent = unitFor(history, "ada", 0, 1_000);
    history.releaseMemoryCoverage("ada", "hindsight", parent.claim);
    const child = unitFor(history, "ada/spin", 0, 1_000);
    expect(child.documentId).toBe(parent.documentId);
    history.close();
  });

  test("once one branch's document is confirmed, the other has nothing new to submit", () => {
    const history = store();
    const messages = [message("one", newMessageVersion())];
    archive(history, "ada", 0, messages);
    archive(history, "ada/spin", 0, messages);

    const parent = unitFor(history, "ada", 0, 1_000);
    history.commitMemoryCoverage("ada", "hindsight", parent.claim);
    history.markMemoryDocumentOccurrence("ada", "hindsight", parent.documentId, "ada", 0);

    expect(hindsightUnitFor(history, "ada/spin", 0, 2_000).kind).toBe("covered");
    history.close();
  });

  test("a branch that adds new turns submits only those, with the rest as background", () => {
    const history = store();
    const inherited = message("inherited", newMessageVersion());
    const fresh = message("fresh", newMessageVersion());
    archive(history, "ada", 0, [inherited]);
    archive(history, "ada/spin", 0, [inherited, fresh]);

    const parent = unitFor(history, "ada", 0, 1_000);
    history.commitMemoryCoverage("ada", "hindsight", parent.claim);

    const child = unitFor(history, "ada/spin", 0, 2_000);
    expect(child.messages.map((m) => m.content)).toEqual(["fresh"]);
    expect(child.background).toBe(1);
    expect(child.documentId).not.toBe(parent.documentId);
    history.close();
  });

  test("a claim in flight in one branch is not handed to the other as well", () => {
    const history = store();
    const messages = [message("one", newMessageVersion())];
    archive(history, "ada", 0, messages);
    archive(history, "ada/spin", 0, messages);

    expect(hindsightUnitFor(history, "ada", 0, 1_000).kind).toBe("unit");
    expect(hindsightUnitFor(history, "ada/spin", 0, 1_000).kind).toBe("claimed_elsewhere");
    history.close();
  });

  test("a shared document survives excluding one of its occurrences", () => {
    const history = store();
    const messages = [message("one", newMessageVersion())];
    archive(history, "ada", 0, messages);
    archive(history, "ada/spin", 0, messages);

    const unit = unitFor(history, "ada", 0, 1_000);
    history.commitMemoryCoverage("ada", "hindsight", unit.claim);
    history.markMemoryDocumentOccurrence("ada", "hindsight", unit.documentId, "ada", 0);
    history.markMemoryDocumentOccurrence("ada", "hindsight", unit.documentId, "ada/spin", 0);

    history.setExcluded("ada", 0, true, true);
    expect(
      history.eligibleDocumentOccurrences("ada", "hindsight", unit.documentId),
    ).toEqual([{ archive_key: "ada/spin", segment: 0 }]);

    history.setExcluded("ada/spin", 0, true, true);
    expect(history.eligibleDocumentOccurrences("ada", "hindsight", unit.documentId)).toEqual([]);

    history.setExcluded("ada/spin", 0, false, true);
    expect(
      history.eligibleDocumentOccurrences("ada", "hindsight", unit.documentId),
    ).toEqual([{ archive_key: "ada/spin", segment: 0 }]);
    history.close();
  });

  test("dropping the last occupant of a document frees its material for retention again", () => {
    const history = store();
    const messages = [message("one", newMessageVersion())];
    archive(history, "ada", 0, messages);
    const unit = unitFor(history, "ada", 0, 1_000);
    history.commitMemoryCoverage("ada", "hindsight", unit.claim);

    history.releaseHindsightUnitCoverage("ada", unit.documentId);
    expect(history.coveredMemoryVersions("ada", "hindsight", [required(required(messages[0]).version)]).size).toBe(0);
    history.close();
  });

  test("a legacy segment with no versions keeps its per-segment document id", () => {
    const history = store();
    archive(history, "ada", 0, [message("legacy")]);
    expect(unitFor(history, "ada", 0, 1_000).documentId).toBe("shore:ada:seg0");
    history.close();
  });
});
