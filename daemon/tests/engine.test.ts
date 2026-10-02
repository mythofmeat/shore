import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import { writeDurable } from "../src/storage/files.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ConversationEngine } from "../src/engine/conversation";


import type { Message } from "../src/engine/types";
import { existsSync } from "node:fs";
import { mergeToolLoopMessages } from "../src/engine/merge.ts";
import { testTmp } from "./support/tmp.ts";
import { expandShared } from "./support/shared_subtrees.ts";

interface StoredSegment { entry: SegmentEntry; messages: Message[] }

interface WalkStep {
  op: Record<string, unknown>;
  revision: number;
  message_count: number;
  turn_count: number;
  segment_count: number;
  broadcasts: number;
}

interface WalkCase {
  name: string;
  character: string;
  initial_active: Message[] | null;
  segments: StoredSegment[];
  image_files?: Record<string, string>;
  steps: WalkStep[];
}

interface Fixture {
  engine_walk: WalkCase[];
}

const fixture = expandShared<Fixture>(
  await Bun.file(new URL("./engine_captures/engine.json", import.meta.url)).json(),
);

async function scratch(): Promise<string> {
  return await mkdtemp(testTmp("shore-engine-"));
}

async function layout(dir: string, segments: StoredSegment[], activeJsonl?: string): Promise<void> {
  await mkdir(join(dir, "threads", "main"), { recursive: true });
  const store = HistoryStore.open(join(dirname(dir), "shore.db"));
  try {
    for (const [index, segment] of segments.entries()) store.putSegment(basename(dir), index, segment.entry, segment.messages);
  } finally { store.close(); }
  if (activeJsonl !== undefined) writeDurable(join(dir, "threads", "main", "active.jsonl"), activeJsonl);
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
    expect(fixture.engine_walk.length).toBeGreaterThanOrEqual(3);
    const steps = fixture.engine_walk.reduce((n, w) => n + w.steps.length, 0);
    expect(steps).toBeGreaterThanOrEqual(15);
  });

  test("a case exists where archived history is non-empty", () => {
    const withArchive = fixture.engine_walk.filter((w) =>
      w.steps.some((s) => s.segment_count > 0),
    );
    expect(withArchive.length).toBeGreaterThan(0);
  });
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
      await layout(charDir, walk.segments, activeJsonl);

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
        expect(engine.messageCount(), `${where} message_count`).toBe(expected.message_count);
        expect(engine.turnCount(), `${where} turn_count`).toBe(expected.turn_count);
        expect(engine.segments().segmentCount(), `${where} segment_count`).toBe(
          expected.segment_count,
        );
        expect(broadcasts, `${where} broadcasts`).toBe(expected.broadcasts);

        const snapshot = JSON.parse(JSON.stringify(engine.historySnapshot({ k: "v" }))) as {
          messages: Message[];
          config: unknown;
          selected_character: string;
          revision: number;
        };
        expect(snapshot.revision, `${where}: the snapshot says which revision it is`).toBe(
          engine.currentRevision(),
        );
        expect(snapshot.selected_character, `${where}: and whose conversation`).toBe(walk.character);
        expect(snapshot.config, `${where}: and carries the config it was handed`).toEqual({ k: "v" });
        expect(
          snapshot.messages.map((m) => m.msg_id),
          `${where}: a snapshot is the live half of the history, never the archive`,
        ).toEqual(mergeToolLoopMessages([...engine.messages()]).map((m) => m.msg_id));
        for (const message of snapshot.messages) {
          for (const image of message.images) {
            expect(
              image.data !== undefined,
              `${where}: ${image.path} carries its bytes exactly when they can be read`,
            ).toBe(existsSync(image.path));
          }
        }
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
      await layout(charDir, op["segments"] as StoredSegment[]);
      return;
    }
    case "append":
      await engine.appendMessage(op["msg"] as Message);
      return;
    case "edit":
      await engine.editMessage(op["msg_id"] as string, op["content"] as string);
      return;
    case "delete":
      await engine.deleteMessages([op["msg_id"] as string]);
      return;
    case "replace_after_last_user_turn": {
      const removed = await engine.replaceAfterLastUserTurn(op["messages"] as Message[]);
      expect(removed, "replace removed count").toBe(op["removed"] as number);
      return;
    }
    case "select_alt":
      await engine.selectAlt(op["msg_id"] as string, op["index"] as number);
      return;
    case "reload":
      await engine.reload();
      return;
    default:
      throw new Error(`unhandled op in fixture: ${String(op["op"])}`);
  }
}
