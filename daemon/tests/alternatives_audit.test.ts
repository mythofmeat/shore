import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditAlternatives, describeAlternativeDefects } from "../src/engine/alt_audit.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const THINKING: ContentBlock = {
  type: "thinking",
  thinking: "weighing it up",
  signature: "sig-abc",
};
const UNSIGNED: ContentBlock = { type: "thinking", thinking: "weighing it up" };
const TEXT: ContentBlock = { type: "text", text: "an answer" };

function message(over: Partial<Message> = {}): Message {
  return {
    msg_id: "m1",
    role: "assistant",
    content: "an answer",
    images: [],
    content_blocks: [THINKING, TEXT],
    timestamp: "2026-08-12T00:00:00Z",
    ...over,
  } as Message;
}

function alt(blocks: ContentBlock[], content = "an answer") {
  return { content, images: [], content_blocks: blocks, timestamp: "2026-08-12T00:00:00Z" };
}

describe("auditAlternatives", () => {
  test("an alternative that lost its thinking while the live turn kept one is flagged", () => {
    const defects = auditAlternatives([
      message({ alternatives: [alt([TEXT]), alt([THINKING, TEXT])] }),
    ]);
    expect(defects).toEqual([{ msg_id: "m1", alt_index: 0, kind: "thinking_lost" }]);
  });

  test("thinking with no signature cannot be replayed, and says so", () => {
    const defects = auditAlternatives([message({ alternatives: [alt([UNSIGNED, TEXT])] })]);
    expect(defects).toEqual([
      { msg_id: "m1", alt_index: 0, kind: "thinking_without_signature" },
    ]);
  });

  test("an empty alternative is flagged on its own", () => {
    const defects = auditAlternatives([message({ alternatives: [alt([], "")] })]);
    expect(defects).toEqual([{ msg_id: "m1", alt_index: 0, kind: "empty" }]);
  });

  test("a turn that never had thinking is not accused of losing it", () => {
    const defects = auditAlternatives([
      message({ content_blocks: [TEXT], alternatives: [alt([TEXT]), alt([TEXT])] }),
    ]);
    expect(defects).toEqual([]);
  });

  test("complete alternatives report nothing", () => {
    const defects = auditAlternatives([
      message({ alternatives: [alt([THINKING, TEXT]), alt([THINKING, TEXT])] }),
    ]);
    expect(defects).toEqual([]);
  });
});

describe("describeAlternativeDefects", () => {
  test("a clean conversation produces no line at all", () => {
    expect(describeAlternativeDefects("/tmp/active.jsonl", [])).toBeUndefined();
  });

  test("the report counts by kind so the damage is legible at a glance", () => {
    const line = describeAlternativeDefects("/tmp/active.jsonl", [
      { msg_id: "m1", alt_index: 0, kind: "thinking_lost" },
      { msg_id: "m2", alt_index: 1, kind: "thinking_lost" },
      { msg_id: "m3", alt_index: 0, kind: "empty" },
    ]);
    expect(line).toContain("3 stored alternative(s)");
    expect(line).toContain("thinking_lost=2");
    expect(line).toContain("empty=1");
  });
});

describe("the audit runs at load", () => {
  test("a conversation on disk reports its incomplete alternatives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shore-altaudit-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "active.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(message({ alternatives: [alt([TEXT]), alt([THINKING, TEXT])] }))}\n`,
      "utf8",
    );

    const store = await MessageStore.load(path);
    expect(store.alternativeDefects).toEqual([
      { msg_id: "m1", alt_index: 0, kind: "thinking_lost" },
    ]);
  });
});
