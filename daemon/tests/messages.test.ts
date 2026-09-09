import { readDurable } from "../src/storage/files.ts";
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

import fixture from "./engine_captures/messages.json";

const MINTED_VERSION_RE = /mv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const wire = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v), (key: string, entry: unknown) =>
    key === "version" && typeof entry === "string" ? "<minted_version>" : entry,
  );

const settledVersions = (text: string): string => text.replaceAll(MINTED_VERSION_RE, "<minted_version>");

const hydrate = (m: Message): Message => ({
  ...m,
  images: m.images ?? [],
  content_blocks: m.content_blocks ?? [],
});

async function inTemp<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shore-msgstore-"));
  try {
    return await fn(join(dir, "threads", "main", "active.jsonl"));
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

describe("interrupted tool-loop recovery", () => {
  test("persists error results for dangling tool calls exactly once", async () => {
    await inTemp(async (path) => {
      const store = MessageStore.create(path);
      await store.append({
        msg_id: "u1",
        role: "user",
        content: "look it up",
        images: [],
        content_blocks: [{ type: "text", text: "look it up" }],
        timestamp: "2026-08-28T00:00:00Z",
      });
      await store.append({
        msg_id: "a1",
        role: "assistant",
        content: "",
        images: [],
        content_blocks: [
          { type: "tool_use", id: "t1", name: "search", input: { query: "one" } },
          { type: "tool_use", id: "t2", name: "search", input: { query: "two" } },
        ],
        timestamp: "2026-08-28T00:01:00Z",
      });

      expect(await store.recoverInterruptedToolLoop("recovered", "2026-08-28T00:02:00Z")).toBe(2);
      expect(await store.recoverInterruptedToolLoop("duplicate", "2026-08-28T00:03:00Z")).toBe(0);
      expect(store.messages()).toHaveLength(3);
      expect(store.messages()[2]?.content_blocks).toEqual([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "Tool execution was interrupted by a Shore daemon restart before it returned a result.",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: "Tool execution was interrupted by a Shore daemon restart before it returned a result.",
          is_error: true,
        },
      ]);
      expect((await MessageStore.load(path)).messages()).toHaveLength(3);
    });
  });

  test("does nothing once the offered tool has a result", async () => {
    await inTemp(async (path) => {
      const store = MessageStore.create(path);
      await store.append({
        msg_id: "a1",
        role: "assistant",
        content: "",
        images: [],
        content_blocks: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
        timestamp: "2026-08-28T00:01:00Z",
      });
      await store.append({
        msg_id: "r1",
        role: "user",
        content: "done",
        images: [],
        content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
        timestamp: "2026-08-28T00:02:00Z",
      });

      expect(await store.recoverInterruptedToolLoop("recovered", "2026-08-28T00:03:00Z")).toBe(0);
      expect(store.messages()).toHaveLength(2);
    });
  });
});

describe("operation traces", () => {
  interface Op {
    op: unknown;
    result: Record<string, unknown>;
    file?: string;
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


  function ids(messages: readonly Message[]): string[] {
    return messages.map((m) => m.msg_id);
  }

  function typedTurns(messages: readonly Message[]): number {
    return messages.filter(
      (m) =>
        m.role === "user" &&
        !(m.content_blocks.length > 0 && m.content_blocks.every((b) => b.type === "tool_result")),
    ).length;
  }

  function changedIds(before: readonly Message[], after: readonly Message[]): string[] {
    const was = new Map(before.map((m) => [m.msg_id, JSON.stringify(wire(m))]));
    return after
      .filter((m) => {
        const previous = was.get(m.msg_id);
        return previous !== undefined && previous !== JSON.stringify(wire(m));
      })
      .map((m) => m.msg_id);
  }

  function expectStoreShape(
    op: unknown,
    result: Record<string, unknown>,
    before: Message[],
    after: Message[],
    where: string,
  ): void {
    const unchanged = (why: string) => {
      expect(wire(after), `${where}: ${why}`).toEqual(wire(before));
    };

    if (typeof op === "string") {
      switch (op) {
        case "view":
        case "pending":
        case "inspect":
          unchanged("reading the store does not change it");
          return;
        case "clear":
          expect(after, `${where}: clearing leaves nothing`).toEqual([]);
          return;
        case "truncate": {
          const removed = result.removed as number;
          expect(ids(after), `${where}: truncating drops that many from the end`).toEqual(
            ids(before).slice(0, before.length - removed),
          );
          expect(changedIds(before, after), `${where}: and rewrites none of the rest`).toEqual([]);
          return;
        }
        case "replace": {
          const removed = result.removed as number;
          expect(
            ids(after).slice(0, before.length - removed),
            `${where}: replacing keeps everything up to the last user turn`,
          ).toEqual(ids(before).slice(0, before.length - removed));
          expect(
            after.slice(before.length - removed).map((m) => m.content),
            `${where}: and puts the new answer after it`,
          ).toEqual(["regenerated"]);
          return;
        }
        case "add_candidate":
          expect(
            changedIds(before, after).length <= 1,
            `${where}: a candidate lands on one message`,
          ).toBe(true);
          expect(ids(after), `${where}: and adds no message`).toEqual(ids(before));
          return;
        default:
          throw new Error(`${where}: no shape stated for ${op}`);
      }
    }

    const rec = op as Record<string, unknown>;
    if ("error" in result) {
      unchanged("a refused operation changes nothing");
      return;
    }
    if ("append_msg" in rec) {
      const appended = rec["append_msg"] as Message;
      expect(ids(after), `${where}: append puts it on the end`).toEqual([
        ...ids(before),
        appended.msg_id,
      ]);
      expect(changedIds(before, after), `${where}: and disturbs nothing`).toEqual([]);
      return;
    }
    if ("insert_msg" in rec) {
      const inserted = rec["insert_msg"] as Message;
      expect([...ids(after)].sort(), `${where}: insert adds exactly that message`).toEqual(
        [...ids(before), inserted.msg_id].sort(),
      );
      expect(changedIds(before, after), `${where}: and rewrites none of the others`).toEqual([]);
      const stamps = after
        .map((m) => Date.parse(m.timestamp))
        .filter((t) => !Number.isNaN(t));
      expect(
        [...stamps].sort((a, b) => a - b),
        `${where}: and leaves the parseable timestamps in order`,
      ).toEqual(stamps);
      return;
    }
    if ("edit" in rec) {
      const target = rec["edit"] as string;
      expect(ids(after), `${where}: editing adds and removes nothing`).toEqual(ids(before));
      expect(changedIds(before, after), `${where}: and touches only its target`).toEqual([target]);
      expect(
        required(after.find((m) => m.msg_id === target)).content,
        `${where}: which now reads as asked`,
      ).toBe("after");
      return;
    }
    if ("delete" in rec) {
      const target = rec["delete"] as string;
      expect(ids(after), `${where}: delete removes just that one`).toEqual(
        ids(before).filter((id) => id !== target),
      );
      expect(changedIds(before, after), `${where}: and rewrites none of the rest`).toEqual([]);
      return;
    }
    if ("set_alt" in rec || "add_candidate" in rec || "select" in rec) {
      const positions = ids(after).map((id) => ids(before).indexOf(id));
      expect(
        positions.every((n) => n >= 0),
        `${where}: choosing among answers adds no message`,
      ).toBe(true);
      expect(
        positions,
        `${where}: and leaves what remains in the order it was`,
      ).toEqual([...positions].sort((a, b) => a - b));
      const touched = changedIds(before, after);
      expect(touched.length <= 1, `${where}: and rewrites at most one`).toBe(true);

      const isTyped = (m: Message): boolean =>
        m.role === "user" &&
        !(m.content_blocks.length > 0 && m.content_blocks.every((b) => b.type === "tool_result"));
      const lastTurn = before.map(isTyped).lastIndexOf(true);
      for (const [i, m] of before.entries()) {
        if (ids(after).includes(m.msg_id)) continue;
        expect(
          i > lastTurn,
          `${where}: what it drops is the exchange that produced the answer it replaced`,
        ).toBe(true);
      }
      if ("select" in rec && typeof result.msg_id === "string") {
        const chosen = required(after.find((m) => m.msg_id === result.msg_id));
        expect(chosen.content, `${where}: the chosen answer is what the message now says`).toBe(
          result.content as string,
        );
        expect(chosen.alt_index, `${where}: and it remembers which one`).toBe(
          result.alt_index as number,
        );
        expect((chosen.alternatives ?? []).length, `${where}: out of how many`).toBe(
          result.alt_count as number,
        );
      }
      return;
    }
    throw new Error(`${where}: no shape stated for ${JSON.stringify(op)}`);
  }

  async function expectPersistedAsHeld(path: string, store: MessageStore, where: string): Promise<void> {
    const onDisk = readDurable(path);
    const lines = onDisk === "" ? [] : onDisk.split("\n").slice(0, -1);
    expect(lines.length, `${where}: one line on disk per message held`).toBe(
      store.messages().length,
    );
    expect(
      lines.map((line) => (JSON.parse(line) as { msg_id: string }).msg_id),
      `${where}: in the order they are held`,
    ).toEqual(store.messages().map((m) => m.msg_id));
    expect(onDisk.includes("BASE64BLOB"), `${where}: image bytes are not written to disk`).toBe(
      false,
    );

    const reloaded = await MessageStore.load(path);
    expect(
      wire(reloaded.messages()),
      `${where}: and reading it back gives what was held, normalized`,
    ).toEqual(wire(store.messages().map(normalizeMessage)));
  }

  for (const t of fixture.traces as unknown as Trace[]) {
    test(t.name, async () => {
      await inTemp(async (path) => {
        const target = t.name.includes("tail_branch") ? "a2" : "a1";
        if (t.seed_file !== "") await Bun.write(path, t.seed_file);
        const store = await MessageStore.load(path);

        for (const step of t.ops) {
          const before = wire(store.messages()) as Message[];
          let result: Record<string, unknown>;
          try {
            result = await apply(store, step.op, target);
          } catch (e) {
            result = { error: (e as Error).message };
          }
          const where = `${t.name}: ${JSON.stringify(step.op)}`;
          const after = store.messages();

          expect(wire(result), `result of ${JSON.stringify(step.op)}`).toEqual(wire(step.result));
          expect(store.messageCount(), `${where}: the count is what it holds`).toBe(after.length);
          expect(store.turnCount(), `${where}: a turn is a message the user typed`).toBe(
            typedTurns(after),
          );

          expectStoreShape(step.op, result, before, [...after], where);
          if (step.file === undefined) {
            await expectPersistedAsHeld(path, store, where);
          } else {
            expect(
              settledVersions(readDurable(path)),
              `file after ${JSON.stringify(step.op)}`,
            ).toBe(step.file);
          }
        }
      });
    });
  }
});
