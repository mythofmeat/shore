import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ConversationEngine, type History } from "../src/engine/conversation";
import { MessageNotFound } from "../src/engine/message_store";
import { SegmentReader } from "../src/engine/segments";
import type { Message } from "../src/engine/types";
import { testTmp } from "./support/tmp.ts";
import { expandShared } from "./support/shared_subtrees.ts";

interface SegmentRead {
  index: number;
  ok?: Message[];
  err?: string;
  err_kind?: string;
  err_contains?: string;
}

interface SegmentCase {
  name: string;
  manifest: unknown;
  segment_files: Record<string, string>;
  segment_count: number;
  total_message_count: number;
  reads: SegmentRead[];
}

interface WalkStep {
  op: Record<string, unknown>;
  revision: number;
  history_rewrite_generation: number;
  message_count: number;
  turn_count: number;
  segment_count: number;
  broadcasts: number;
  display_history: { messages: Message[]; active_start: number };
  snapshot: History;
}

interface WalkCase {
  name: string;
  character: string;
  initial_active: Message[] | null;
  manifest: unknown;
  segment_files: Record<string, string>;
  image_files?: Record<string, string>;
  steps: WalkStep[];
}

interface Fixture {
  segment_reader: SegmentCase[];
  engine_walk: WalkCase[];
}

const fixture = expandShared<Fixture>(
  await Bun.file(new URL("./engine_fixtures/engine.json", import.meta.url)).json(),
);

async function scratch(): Promise<string> {
  return await mkdtemp(testTmp("shore-engine-"));
}

async function layout(
  dir: string,
  manifest: unknown,
  segmentFiles: Record<string, string>,
  activeJsonl?: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (Object.keys(segmentFiles).length > 0 || manifest !== null) {
    await mkdir(join(dir, "segments"), { recursive: true });
  }
  for (const [name, body] of Object.entries(segmentFiles)) {
    await writeFile(join(dir, "segments", name), body);
  }
  if (manifest !== null) {
    await writeFile(join(dir, "compaction.json"), JSON.stringify(manifest, null, 2));
  }
  if (activeJsonl !== undefined) {
    await writeFile(join(dir, "active.jsonl"), activeJsonl);
  }
}

function rebase<T>(value: T, fromDir: string, toDir: string): T {
  const s = JSON.stringify(value);
  return JSON.parse(s.split(fromDir).join(toDir)) as T;
}

function recordedRoot(walk: WalkCase): string | undefined {
  const found = JSON.stringify(walk).match(/"(\/tmp\/[^/"]+)\/[^"]*"/);
  return found?.[1];
}

describe("the fixture is real", () => {
  test("a silently empty fixture must not pass", () => {
    expect(fixture.segment_reader.length).toBeGreaterThanOrEqual(4);
    expect(fixture.engine_walk.length).toBeGreaterThanOrEqual(3);
    const steps = fixture.engine_walk.reduce((n, w) => n + w.steps.length, 0);
    expect(steps).toBeGreaterThanOrEqual(15);
  });

  test("the walk actually exercises both counters moving independently", () => {
    const all = fixture.engine_walk.flatMap((w) => w.steps);
    const revOnly = all.filter((s, i) => {
      const prev = all[i - 1];
      return (
        prev !== undefined &&
        s.revision > prev.revision &&
        s.history_rewrite_generation === prev.history_rewrite_generation
      );
    });
    const both = all.filter((s, i) => {
      const prev = all[i - 1];
      return prev !== undefined && s.history_rewrite_generation > prev.history_rewrite_generation;
    });
    expect(revOnly.length, "some ops advance revision alone").toBeGreaterThan(0);
    expect(both.length, "some ops advance both").toBeGreaterThan(0);
  });

  test("a case exists where archived history is non-empty", () => {
    const withArchive = fixture.engine_walk.filter((w) =>
      w.steps.some((s) => s.display_history.active_start > 0),
    );
    expect(withArchive.length).toBeGreaterThan(0);
  });
});

describe("reading a conversation back off disk", () => {
  for (const c of fixture.segment_reader) {
    test(c.name, async () => {
      const dir = await scratch();
      await layout(dir, c.manifest, c.segment_files);
      const reader = await SegmentReader.load(dir);

      expect(reader.segmentCount()).toBe(c.segment_count);
      expect(reader.totalMessageCount()).toBe(c.total_message_count);

      for (const read of c.reads) {
        if (read.ok !== undefined) {
          expect(await reader.readSegment(read.index)).toEqual(read.ok);
          continue;
        }
        if (read.err !== undefined) {
          let caught: unknown;
          try {
            await reader.readSegment(read.index);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(MessageNotFound);
          expect((caught as Error).message).toBe(read.err);
          continue;
        }
        expect(read.err_kind).toBe("io");
        let caught: unknown;
        try {
          await reader.readSegment(read.index);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeDefined();
        expect(String(caught)).toContain(read.err_contains ?? "");
      }
    });
  }
});

describe("driving the conversation engine", () => {
  for (const walk of fixture.engine_walk) {
    test(walk.name, async () => {
      const root = await scratch();
      const charDir = join(root, walk.character);
      const from = recordedRoot(walk);
      const activeJsonl =
        walk.initial_active === null
          ? undefined
          : `${walk.initial_active.map((m) => JSON.stringify(m)).join("\n")}\n`;
      await layout(charDir, walk.manifest, walk.segment_files, activeJsonl);

      for (const [name, base64] of Object.entries(walk.image_files ?? {})) {
        await writeFile(join(charDir, name), Buffer.from(base64, "base64"));
      }

      let broadcasts = 0;
      const engine = await ConversationEngine.load(walk.character, root, () => {
        broadcasts += 1;
      });

      for (const step of walk.steps) {
        const op = from === undefined ? step.op : rebase(step.op, from, root);
        broadcasts = 0;
        await applyOp(engine, op, charDir);

        const expected = from === undefined ? step : rebase(step, from, root);
        const where = `${walk.name} :: ${String(op["op"])}`;

        expect(engine.currentRevision(), `${where} revision`).toBe(expected.revision);
        expect(engine.historyRewriteGeneration(), `${where} generation`).toBe(
          expected.history_rewrite_generation,
        );
        expect(engine.messageCount(), `${where} message_count`).toBe(expected.message_count);
        expect(engine.turnCount(), `${where} turn_count`).toBe(expected.turn_count);
        expect(engine.segments().segmentCount(), `${where} segment_count`).toBe(
          expected.segment_count,
        );
        expect(broadcasts, `${where} broadcasts`).toBe(expected.broadcasts);

        const display = await engine.displayHistory();
        expect(display.messages, `${where} display_history.messages`).toEqual(
          expected.display_history.messages,
        );
        expect(display.activeStart, `${where} display_history.active_start`).toBe(
          expected.display_history.active_start,
        );

        expect(
          JSON.parse(JSON.stringify(engine.historySnapshot({ k: "v" }))),
          `${where} snapshot`,
        ).toEqual(expected.snapshot as unknown as Record<string, unknown>);
      }
    });
  }
});

async function applyOp(
  engine: ConversationEngine,
  op: Record<string, unknown>,
  charDir: string,
): Promise<void> {
  switch (op["op"]) {
    case "load":
      return;
    case "external_write": {
      await mkdir(join(charDir, "segments"), { recursive: true });
      for (const [name, body] of Object.entries(
        (op["segment_files"] ?? {}) as Record<string, string>,
      )) {
        await writeFile(join(charDir, "segments", name), body);
      }
      await writeFile(
        join(charDir, "compaction.json"),
        JSON.stringify(op["manifest"], null, 2),
      );
      return;
    }
    case "append":
      await engine.appendMessage(op["msg"] as Message);
      return;
    case "insert_by_timestamp":
      await engine.insertMessageByTimestamp(op["msg"] as Message);
      return;
    case "edit":
      await engine.editMessage(op["msg_id"] as string, op["content"] as string);
      return;
    case "delete":
      await engine.deleteMessage(op["msg_id"] as string);
      return;
    case "truncate_after_last_user_turn": {
      const removed = await engine.truncateAfterLastUserTurn();
      expect(removed, "truncate removed count").toBe(op["removed"] as number);
      return;
    }
    case "replace_after_last_user_turn": {
      const removed = await engine.replaceAfterLastUserTurn(op["messages"] as Message[]);
      expect(removed, "replace removed count").toBe(op["removed"] as number);
      return;
    }
    case "set_alt":
      await engine.setAlt(op["msg_id"] as string, op["index"] as number, op["count"] as number);
      return;
    case "add_alt_candidate": {
      const count = await engine.addAltCandidate(op["msg_id"] as string);
      expect(count, "add_alt_candidate returned").toBe(op["returned"] as number);
      return;
    }
    case "select_alt":
      await engine.selectAlt(op["msg_id"] as string, op["index"] as number);
      return;
    case "reset":
      await engine.reset();
      return;
    case "reload":
      await engine.reload();
      return;
    default:
      throw new Error(`unhandled op in fixture: ${String(op["op"])}`);
  }
}
