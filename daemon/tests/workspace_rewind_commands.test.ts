import { writeDurable } from "../src/storage/files.ts";

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { alt, deleteMessages, edit } from "../src/commands/conversation.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message, MessageAlternative } from "../src/engine/types.ts";
import { recordTurn, snapshotTree, undoTurns, workspaceTurnsFor, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
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

function alternative(text: string, version: string): MessageAlternative {
  return { content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: "2026-10-08T10:00:01Z", version };
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
  const before = await snapshotTree(turns);
  writeFileSync(join(turns.workspace, path), `${version}\n`);
  await recordTurn(turns, "main", version, before);
}

const there = (turns: WorkspaceTurns, path: string): boolean => existsSync(join(turns.workspace, path));

const history = (): Message[] => [
  user("m_u1", "first"),
  assistant("m_a1", "one", "mv_1"),
  user("m_u2", "second"),
  assistant("m_a2", "two", "mv_2"),
];

describe("deleting turns", () => {
  test("deleting the newest reply undoes its files", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_1", "one.md");
    await wrote(turns, "mv_2", "two.md");

    const result = await deleteMessages(engine, { refs: "last" }, turns);

    expect(result.workspace).toEqual({ restored: ["two.md"], skipped: [] });
    expect(there(turns, "two.md")).toBe(false);
    expect(there(turns, "one.md")).toBe(true);
  });

  test("deleting the last two exchanges walks back through both, newest first", async () => {
    const { engine, turns } = await world(history());
    writeFileSync(join(turns.workspace, "log.md"), "start\n");
    await wrote(turns, "mv_1", "log.md");
    await wrote(turns, "mv_2", "log.md");

    const result = await deleteMessages(engine, { refs: ["m_u1", "m_a1", "m_u2", "m_a2"] }, turns);

    expect(result.workspace).toEqual({ restored: ["log.md"], skipped: [] });
    expect(readFileSync(join(turns.workspace, "log.md"), "utf8")).toBe("start\n");
  });

  test("deleting a turn with later turns after it keeps the files and says so", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_1", "one.md");
    await wrote(turns, "mv_2", "two.md");

    const result = await deleteMessages(engine, { refs: "m_a1" }, turns);

    expect(result.workspace).toEqual({ restored: [], skipped: [], kept: "later_turns" });
    expect(there(turns, "one.md")).toBe(true);
  });

  test("deleting a reply that changed nothing reports nothing", async () => {
    const { engine, turns } = await world(history());
    const result = await deleteMessages(engine, { refs: "m_a1" }, turns);
    expect(result).toEqual({ deleted: ["m_a1"] });
  });

  test("a file changed after the reply is left alone and reported", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_2", "two.md");
    writeFileSync(join(turns.workspace, "two.md"), "the user's edit\n");

    const result = await deleteMessages(engine, { refs: "last" }, turns);

    expect(result.workspace).toEqual({ restored: [], skipped: ["two.md"] });
    expect(there(turns, "two.md")).toBe(true);
  });

  test("an edited reply can still be undone", async () => {
    const { engine, turns } = await world(history());
    await wrote(turns, "mv_2", "two.md");

    await edit(engine, { ref: "last", content: "two, edited" }, turns);
    const result = await deleteMessages(engine, { refs: "last" }, turns);

    expect(result.workspace).toEqual({ restored: ["two.md"], skipped: [] });
  });
});

describe("switching alternatives", () => {
  async function swiped(older: boolean): Promise<{ engine: ConversationEngine; turns: WorkspaceTurns }> {
    const alternatives = [alternative("draft a", "mv_a"), alternative("draft b", "mv_b")];
    const messages = older
      ? [user("m_u1", "first"), assistant("m_a1", "draft b", "mv_b", alternatives), user("m_u2", "second"), assistant("m_a2", "two", "mv_2")]
      : [user("m_u1", "first"), assistant("m_a1", "draft b", "mv_b", alternatives)];
    const made = await world(messages);
    await wrote(made.turns, "mv_a", "a.md");
    await undoTurns(made.turns, "main", ["mv_a"]);
    await wrote(made.turns, "mv_b", "b.md");
    return made;
  }

  test("on the newest turn the files follow the chosen alternative", async () => {
    const { engine, turns } = await swiped(false);

    const back = await alt(engine, { index: 0 }, turns);
    expect(back.workspace?.restored.sort()).toEqual(["a.md", "b.md"]);
    expect(there(turns, "a.md")).toBe(true);
    expect(there(turns, "b.md")).toBe(false);

    await alt(engine, { index: 1 }, turns);
    expect(there(turns, "a.md")).toBe(false);
    expect(there(turns, "b.md")).toBe(true);
  });

  test("on an older turn the files stay as they are", async () => {
    const { engine, turns } = await swiped(true);

    const back = await alt(engine, { ref: "m_a1", index: 0 }, turns);
    expect(back.workspace).toBeUndefined();
    expect(there(turns, "b.md")).toBe(true);
    expect(there(turns, "a.md")).toBe(false);
  });

  test("without a workspace the switch still works", async () => {
    const { engine, turns } = await swiped(false);
    rmSync(turns.workspace, { recursive: true });
    const back = await alt(engine, { index: 0 }, turns);
    expect(back.alt_index).toBe(0);
    expect(back.workspace).toBeUndefined();
  });
});
