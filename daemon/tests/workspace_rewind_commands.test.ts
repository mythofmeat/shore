import { writeDurable } from "../src/storage/files.ts";

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { deleteMessages } from "../src/commands/conversation.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message, MessageAlternative } from "../src/engine/types.ts";
import { WorkspaceRecorder, workspaceTurnsFor, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
import { testTmp } from "./support/tmp.ts";

function user(id: string, text: string): Message {
  return { msg_id: id, role: "user", content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: "2026-10-08T10:00:00Z", version: `mv_${id}` };
}

function assistant(id: string, text: string, version: string, alternatives?: MessageAlternative[], altIndex?: number): Message {
  return {
    msg_id: id, role: "assistant", content: text, images: [], content_blocks: [{ type: "text", text }],
    timestamp: "2026-10-08T10:00:01Z", version,
    ...(alternatives === undefined ? {} : { alternatives, alt_count: alternatives.length, alt_index: altIndex ?? alternatives.length - 1 }),
  };
}

async function world(history: Message[]): Promise<{ engine: ConversationEngine; turns: WorkspaceTurns }> {
  const root = await mkdtemp(testTmp("shore-rewind-"));
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache") };
  const thread = join(dirs.data, "ada", "threads", "main");
  mkdirSync(thread, { recursive: true });
  writeDurable(join(thread, "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const turns = workspaceTurnsFor(dirs, "ada");
  mkdirSync(turns.workspace, { recursive: true });
  return { engine: await ConversationEngine.load("ada", dirs.data, undefined), turns };
}

async function wrote(turns: WorkspaceTurns, version: string, path: string): Promise<void> {
  const recorder = new WorkspaceRecorder(turns);
  await recorder.track(async () => writeFileSync(join(turns.workspace, path), `${version}\n`));
  await recorder.settle("main", version);
}

const there = (turns: WorkspaceTurns, path: string): boolean => existsSync(join(turns.workspace, path));

const history = (): Message[] => [
  user("m_u1", "first"),
  assistant("m_a1", "one", "mv_1"),
  user("m_u2", "second"),
  assistant("m_a2", "two", "mv_2"),
];

describe("deleting turns", () => {

  test("deleting a turn with later turns after it keeps the files and says so", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_1", "one.md");
    await wrote(turns, "mv_2", "two.md");

    const result = await deleteMessages(engine, { refs: "m_a1" }, turns);

    expect(result.workspace).toEqual({ restored: [], skipped: [], kept: "later_turns" });
    expect(there(turns, "one.md")).toBe(true);
  });

  test("a file changed after the reply is left alone and reported", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_2", "two.md");
    writeFileSync(join(turns.workspace, "two.md"), "the user's edit\n");

    const result = await deleteMessages(engine, { refs: "last" }, turns);

    expect(result.workspace).toEqual({ restored: [], skipped: ["two.md"] });
    expect(there(turns, "two.md")).toBe(true);
  });
});
