import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessageStore,
  normalizeMessage,
  } from "../src/engine/message_store";
import type { Message, MessageAlternative } from "../src/engine/types";

import fixture from "./engine_fixtures/messages.json";

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const hydrate = (m: Message): Message => ({
  ...m,
  images: m.images ?? [],
  content_blocks: m.content_blocks ?? [],
});

async function inTemp<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shore-msgstore-"));
  try {
    return await fn(join(dir, "active.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loading", () => {
  for (const c of fixture.load as {
    name: string;
    file: string | null;
    expect: { ok: boolean; messages?: Message[]; turn_count?: number; error?: string };
  }[]) {
    test(c.name, async () => {
      await inTemp(async (path) => {
        if (c.file !== null) await Bun.write(path, c.file);
        if (!c.expect.ok) {
          const store = await MessageStore.load(path);
          expect(store.quarantinedLines).toBeGreaterThan(0);
          expect(store.messages().length).toBe(countParsableLines(c.file ?? ""));
          return;
        }
        const store = await MessageStore.load(path);
        expect(wire(store.messages())).toEqual(wire(c.expect.messages));
        expect(store.turnCount()).toBe(required(c.expect.turn_count));
      });
    });
  }
});

function countParsableLines(file: string): number {
  return file.split("\n").filter((line) => {
    if (line.trim() === "") return false;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }).length;
}

describe("attach_generated_alt", () => {
  for (const c of fixture.attach_generated_alt as unknown as {
    name: string;
    input: Message[];
    prior: MessageAlternative[];
    returned: [number, number] | null;
    messages: Message[];
  }[]) {
    test(c.name, () => {
      const messages = c.input.map((m) => ({
        ...m,
        images: m.images ?? [],
        content_blocks: m.content_blocks ?? [],
      }));
      const out = MessageStore.attachGeneratedAlt(messages, [...c.prior]);
      expect(out ?? null).toEqual(c.returned);
      expect(wire(messages)).toEqual(wire(c.messages));
    });
  }
});

describe("operation traces", () => {
  interface Op {
    op: unknown;
    result: Record<string, unknown>;
    file: string;
    messages: Message[];
    turn_count: number;
    message_count: number;
  }
  interface Trace {
    name: string;
    seed_file: string;
    ops: Op[];
  }

  async function apply(
    store: MessageStore,
    op: unknown,
    target: string,
  ): Promise<Record<string, unknown>> {
    if (op === "view") return { view: store.messagesThroughLastUserTurn() };
    if (op === "pending") {
      const p = store.pendingRegenAlt();
      return { alternatives: p === undefined ? null : p.alternatives };
    }
    if (op === "inspect") return {};
    if (op === "truncate") return { removed: await store.truncateAfterLastUserTurn() };
    if (op === "clear") {
      await store.clear();
      return {};
    }
    if (op === "add_candidate") return { count: await store.addAltCandidate("a1") };
    if (op === "replace") {
      return {
        removed: await store.replaceAfterLastUserTurn([
          normalizeMessage({
            msg_id: "new1",
            role: "assistant",
            content: "regenerated",
            images: [],
            content_blocks: [{ type: "text", text: "regenerated" }],
            timestamp: "2026-04-04T12:00:00-04:00",
          }),
        ]),
      };
    }

    const rec = op as Record<string, unknown>;
    if ("append_msg" in rec) {
      await store.append(hydrate(rec["append_msg"] as Message));
      return { ok: true };
    }
    if ("insert_msg" in rec) {
      await store.insertByTimestamp(hydrate(rec["insert_msg"] as Message));
      return {};
    }
    if ("set_alt" in rec) {
      const [i, n] = rec["set_alt"] as [number, number];
      await store.setAlt("a1", i, n);
      return {};
    }
    if ("add_candidate" in rec) {
      return { count: await store.addAltCandidate(rec["add_candidate"] as string) };
    }
    if ("edit" in rec) {
      await store.edit(rec["edit"] as string, "after");
      return {};
    }
    if ("delete" in rec) {
      await store.delete(rec["delete"] as string);
      return {};
    }
    if ("select" in rec) {
      const v = rec["select"];
      const sel =
        typeof v === "number"
          ? await store.selectAlt(target, v)
          : await store.selectAlt(v as string, 0);
      return {
        msg_id: sel.msg_id,
        alt_index: sel.alt_index,
        alt_count: sel.alt_count,
        content: sel.content,
      };
    }
    throw new Error(`unhandled op: ${JSON.stringify(op)}`);
  }

  for (const t of fixture.traces as unknown as Trace[]) {
    test(t.name, async () => {
      await inTemp(async (path) => {
        const target = t.name.includes("tail_branch") ? "a2" : "a1";
        if (t.seed_file !== "") await Bun.write(path, t.seed_file);
        const store = await MessageStore.load(path);

        for (const step of t.ops) {
          let result: Record<string, unknown>;
          try {
            result = await apply(store, step.op, target);
          } catch (e) {
            result = { error: (e as Error).message };
          }
          expect(wire(result), `result of ${JSON.stringify(step.op)}`).toEqual(wire(step.result));
          expect(await Bun.file(path).text(), `file after ${JSON.stringify(step.op)}`).toBe(
            step.file,
          );
          expect(wire(store.messages())).toEqual(wire(step.messages));
          expect(store.turnCount()).toBe(step.turn_count);
          expect(store.messageCount()).toBe(step.message_count);
        }
      });
    });
  }
});
