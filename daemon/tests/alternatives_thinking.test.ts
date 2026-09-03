import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageStore } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";

const THINKING: ContentBlock = {
  type: "thinking",
  thinking: "she asked twice, so answer the second one",
  signature: "ErUBCkYIBRgCIkDsig==",
};

function assistant(blocks: ContentBlock[], text: string): Message {
  return {
    msg_id: "m_1",
    role: "assistant",
    content: text,
    images: [],
    content_blocks: blocks,
    timestamp: "2026-08-13T01:53:00Z",
    provider_key: "anthropic",
    model: "claude-opus-4-6",
  };
}

function user(text: string): Message {
  return {
    msg_id: "m_0",
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: "2026-08-13T01:52:00Z",
  };
}

async function inTemp<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shore-altthink-"));
  try {
    return await fn(join(dir, "threads", "main", "active.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const thinkingIn = (blocks: ContentBlock[] | undefined): ContentBlock[] =>
  (blocks ?? []).filter((b) => b.type === "thinking" || b.type === "redacted_thinking");

describe("thinking survives regeneration", () => {
  test("a generated alternative keeps the thinking block and its signature", () => {
    const messages = [user("hey"), assistant([THINKING, { type: "text", text: "hi" }], "hi")];

    const attached = MessageStore.attachGeneratedAlt(messages, []);

    expect(attached).toEqual([0, 1]);
    const alt = required(required(required(messages[1]).alternatives)[0]);
    expect(thinkingIn(alt.content_blocks)).toEqual([THINKING]);
    expect(alt.content).toBe("hi");
  });

  test("redacted thinking is kept too", () => {
    const redacted: ContentBlock = { type: "redacted_thinking", data: "EroBCkYIBRgCIkC" };
    const messages = [user("hey"), assistant([redacted, { type: "text", text: "hi" }], "hi")];

    MessageStore.attachGeneratedAlt(messages, []);

    expect(thinkingIn(required(required(required(messages[1]).alternatives)[0]).content_blocks)).toEqual([redacted]);
  });

  test("tool_use blocks are still dropped, since their results are not carried", () => {
    const toolUse: ContentBlock = {
      type: "tool_use",
      id: "toolu_1",
      name: "read",
      input: { path: "notes.md" },
    };
    const messages = [user("hey"), assistant([THINKING, toolUse, { type: "text", text: "hi" }], "hi")];

    MessageStore.attachGeneratedAlt(messages, []);

    const kept = required(required(required(messages[1]).alternatives)[0]).content_blocks.map((b) => b.type);
    expect(kept).toEqual(["thinking", "text"]);
  });

  test("a thinking-only turn keeps its thinking when the text is recovered from content", () => {
    const messages = [user("hey"), assistant([THINKING], "hi")];

    MessageStore.attachGeneratedAlt(messages, []);

    const alt = required(required(required(messages[1]).alternatives)[0]);
    expect(alt.content_blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(alt.content).toBe("hi");
  });

  test("the pending alternative captured before a regen keeps thinking", async () => {
    await inTemp(async (path) => {
      const store = MessageStore.create(path);
      await store.append(user("hey"));
      await store.append(assistant([THINKING, { type: "text", text: "hi" }], "hi"));

      const pending = store.pendingRegenAlt();

      expect(thinkingIn(required(required(pending).alternatives[0]).content_blocks)).toEqual([THINKING]);
    });
  });

  test("swiping back to an alternative restores its thinking, on disk and in memory", async () => {
    await inTemp(async (path) => {
      const store = MessageStore.create(path);
      await store.append(user("hey"));
      await store.append(assistant([THINKING, { type: "text", text: "first" }], "first"));

      const prior = required(store.pendingRegenAlt()).alternatives;
      const second: ContentBlock = {
        type: "thinking",
        thinking: "try a warmer opening",
        signature: "ErUBCkYIBRgCIkDsecond==",
      };
      const regenerated = [assistant([second, { type: "text", text: "second" }], "second")];
      MessageStore.attachGeneratedAlt(regenerated, prior);
      await store.replaceAfterLastUserTurn(regenerated);

      const back = await store.selectAlt("m_1", 0);
      expect(back.content).toBe("first");

      const live = required(store.messages().find((m) => m.role === "assistant"));
      expect(thinkingIn(live.content_blocks)).toEqual([THINKING]);

      const reloaded = await MessageStore.load(path);
      const persisted = required(reloaded.messages().find((m) => m.role === "assistant"));
      expect(thinkingIn(persisted.content_blocks)).toEqual([THINKING]);
      expect(thinkingIn(required(required(persisted.alternatives)[1]).content_blocks)).toEqual([second]);
    });
  });
});

describe("thinking survives editing", () => {
  test("an assistant edit replaces only text, in memory and on disk", async () => {
    await inTemp(async (path) => {
      const redacted: ContentBlock = { type: "redacted_thinking", data: "opaque" };
      const store = MessageStore.create(path);
      await store.append(
        assistant(
          [
            THINKING,
            { type: "text", text: "first half" },
            redacted,
            { type: "text", text: "second half" },
          ],
          "first half\nsecond half",
        ),
      );

      await store.edit("m_1", "edited answer");

      const expected: ContentBlock[] = [
        THINKING,
        { type: "text", text: "edited answer" },
        redacted,
      ];
      expect(required(store.messages()[0]).content_blocks).toEqual(expected);
      expect(required(store.messages()[0]).content).toBe("edited answer");

      const reloaded = await MessageStore.load(path);
      expect(required(reloaded.messages()[0]).content_blocks).toEqual(expected);
      expect(required(reloaded.messages()[0]).content).toBe("edited answer");
    });
  });

  test("an assistant response with no text gains text without losing thinking", async () => {
    await inTemp(async (path) => {
      const store = MessageStore.create(path);
      await store.append(assistant([THINKING], ""));

      await store.edit("m_1", "added answer");

      expect(required(store.messages()[0]).content_blocks).toEqual([
        THINKING,
        { type: "text", text: "added answer" },
      ]);
    });
  });
});
