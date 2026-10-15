import { writeDurable } from "../src/storage/files.ts";
import { withStorage } from "../src/storage/store.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { deleteMessages } from "../src/commands/conversation.ts";
import { CommandError } from "../src/commands/errors.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";

describe("deleting a tool loop leaves nothing the API will reject", () => {
  function msg(msg_id: string, role: Message["role"], blocks: Message["content_blocks"]): Message {
    return {
      msg_id,
      role,
      content: blocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
      images: [],
      content_blocks: blocks,
      timestamp: "2026-01-01T00:00:00.000+00:00",
    };
  }

  const wedgeShape: Message[] = [
    msg("m_29", "assistant", [{ type: "thinking", thinking: "hm" }, { type: "text", text: "sure" }]),
    msg("m_30", "user", [{ type: "text", text: "the typed message" }]),
    msg("m_31", "assistant", [
      { type: "thinking", thinking: "call it" },
      { type: "tool_use", id: "toolu_017aWq", name: "search", input: {} },
    ]),
    msg("m_32", "user", [{ type: "tool_result", tool_use_id: "toolu_017aWq", content: "hits" }]),
  ];

  async function engineOver(messages: Message[]): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-orphan-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    writeDurable(join(characterDir, "threads", "main", "active.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  function orphanedToolResults(messages: readonly Message[]): string[] {
    const orphans: string[] = [];
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const offered = new Set(
        prev?.role === "assistant"
          ? prev.content_blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
          : [],
      );
      for (const b of m.content_blocks) {
        if (b.type === "tool_result" && !offered.has(b.tool_use_id)) orphans.push(b.tool_use_id);
      }
    });
    return orphans;
  }

  test("deleting the last turn takes the whole tool loop, not just the assistant", async () => {
    const engine = await engineOver(wedgeShape);
    const result = await deleteMessages(engine, { refs: "last" });

    expect(result.deleted.sort()).toEqual(["m_31", "m_32"]);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("two refs inside one tool loop delete it once", async () => {
    const engine = await engineOver(wedgeShape);
    const result = await deleteMessages(engine, { refs: ["m_31", "m_32"] });

    expect(result.deleted.sort()).toEqual(["m_31", "m_32"]);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
  });

  test("deleting the assistant by raw msg_id takes its tool results too", async () => {
    const engine = await engineOver(wedgeShape);
    await deleteMessages(engine, { refs: "m_31" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("a multi-round loop goes as one turn", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      msg("m_3", "user", [{ type: "tool_result", tool_use_id: "t1", content: "r1" }]),
      msg("m_4", "assistant", [{ type: "tool_use", id: "t2", name: "b", input: {} }]),
      msg("m_5", "user", [{ type: "tool_result", tool_use_id: "t2", content: "r2" }]),
      msg("m_6", "assistant", [{ type: "text", text: "done" }]),
    ]);
    await deleteMessages(engine, { refs: "last" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("an already-orphaned tool_result is swept by the next delete", async () => {
    const engine = await engineOver([
      msg("m_29", "assistant", [{ type: "text", text: "sure" }]),
      msg("m_32", "user", [{ type: "tool_result", tool_use_id: "toolu_017aWq", content: "hits" }]),
      msg("m_33", "user", [{ type: "text", text: "still here" }]),
    ]);
    await deleteMessages(engine, { refs: "m_29" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_33"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("one unknown ref means nothing at all is deleted", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "text", text: "done" }]),
    ]);
    let thrown: unknown;
    try {
      await deleteMessages(engine, { refs: ["m_1", "nope"] });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1", "m_2"]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a delete that cannot be written is reported, not swallowed",
    async () => {
      const root = await mkdtemp(testTmp("shore-readonly-"));
      const characterDir = join(root, "TestChar");
      await mkdir(join(characterDir, "threads", "main"), { recursive: true });
      writeDurable(join(characterDir, "threads", "main", "active.jsonl"), [msg("m_1", "user", [{ type: "text", text: "go" }]), msg("m_2", "user", [{ type: "text", text: "stay" }])]
          .map((m) => JSON.stringify(m))
          .join("\n") + "\n");
      const engine = await ConversationEngine.load("TestChar", root, () => {});

      withStorage(root, (db) => db.run("CREATE TRIGGER refuse_state BEFORE INSERT ON state_files BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END"));
      let thrown: unknown;
      try {
        await deleteMessages(engine, { refs: ["m_1"] });
      } catch (e) {
        thrown = e;
      } finally {
        withStorage(root, (db) => db.run("DROP TRIGGER refuse_state"));
      }

      expect(thrown, "a store that refused the write is an error, not a silent success").toBeInstanceOf(
        CommandError,
      );
    },
  );

  test("a tool_result the delete did not orphan is left alone", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      msg("m_3", "user", [{ type: "tool_result", tool_use_id: "t1", content: "r1" }]),
      msg("m_4", "assistant", [{ type: "text", text: "done" }]),
      msg("m_5", "user", [{ type: "text", text: "thanks" }]),
    ]);
    await deleteMessages(engine, { refs: "m_5" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });
});
