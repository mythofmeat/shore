import { describe, expect, test } from "bun:test";

import { assemblePrompt, type PromptParams } from "../src/engine/prompt.ts";
import type { Message } from "../src/engine/types";

function message(id: string, role: "user" | "assistant", content: string, timestamp: string): Message {
  return {
    id,
    role,
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    timestamp,
  } as unknown as Message;
}

const conversation = [
  message("u1", "user", "the harbor's closed today", "2026-10-11T09:00:00Z"),
  message("a1", "assistant", "since when", "2026-10-11T09:01:00Z"),
  message("u2", "user", "since this morning", "2026-10-11T09:02:00Z"),
];

function prompt(overrides: Partial<PromptParams> = {}) {
  return assemblePrompt({
    character_name: "frank",
    display_name: "sam",
    character_definition: "FRANK IS A LIGHTHOUSE KEEPER",
    user_definition: "SAM LIKES TEA",
    memory_index: "SAM WAS TIRED YESTERDAY",
    has_prior_context: false,
    messages: conversation,
    user_timestamp_mode: "never",
    ...overrides,
  }, "UTC");
}

describe("where a character's notes go", () => {
  test("by default they stay in the system prompt and the conversation is left alone", () => {
    const { system, messages } = prompt();
    const text = system.map((block) => block.content).join("\n");
    expect(text).toContain("SAM LIKES TEA");
    expect(text).toContain("SAM WAS TIRED YESTERDAY");
    expect(messages[0]?.content).toBe("the harbor's closed today");
  });

  test("in the conversation they leave the system prompt, and who the character is stays", () => {
    const { system } = prompt({ notes_placement: "conversation" });
    const text = system.map((block) => block.content).join("\n");
    expect(text).toContain("FRANK IS A LIGHTHOUSE KEEPER");
    expect(text).not.toContain("SAM LIKES TEA");
    expect(text).not.toContain("SAM WAS TIRED YESTERDAY");
  });

  test("they open the first user turn, say whose they are, and come before what the user said", () => {
    const { messages } = prompt({ notes_placement: "conversation" });
    const first = messages[0];
    expect(first?.role).toBe("user");
    expect(first?.content).toContain("sam didn't write it");
    expect(first?.content).toContain("SAM LIKES TEA");
    expect(first?.content).toContain("SAM WAS TIRED YESTERDAY");
    expect(first?.content.endsWith("the harbor's closed today")).toBe(true);
    expect(first?.content_blocks.at(-1)).toEqual({ type: "text", text: "the harbor's closed today" });
    expect(messages[2]?.content).toBe("since this morning");
  });

  test("a thread's files go with them", () => {
    const thread = {
      id: "story",
      home: "main",
      created_at: "2026-10-01T00:00:00Z",
      started_by_you: false,
      files: [{ path: "notes/keeper.md", content: "THE KEEPER'S NAME IS MARA" }],
    } as unknown as PromptParams["thread"];
    const { system, messages } = prompt({ notes_placement: "conversation", thread });
    expect(system.map((block) => block.content).join("\n")).not.toContain("THE KEEPER'S NAME IS MARA");
    expect(messages[0]?.content).toContain("THE KEEPER'S NAME IS MARA");
  });

  test("with nothing said yet they get a turn of their own", () => {
    const { messages } = prompt({ notes_placement: "conversation", messages: [] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("SAM LIKES TEA");
  });

  test("with no notes at all the conversation is left alone", () => {
    const { messages } = prompt({ notes_placement: "conversation", user_definition: undefined, memory_index: undefined });
    expect(messages[0]?.content).toBe("the harbor's closed today");
  });

  test("they still count against the room for messages", () => {
    const big = "x".repeat(40_000);
    const inSystem = prompt({ memory_index: big });
    const inConversation = prompt({ memory_index: big, notes_placement: "conversation" });
    expect(inConversation.messageBudget).toBeLessThanOrEqual(inSystem.messageBudget + 64);
    expect(inConversation.messageBudget).toBeGreaterThanOrEqual(inSystem.messageBudget - 256);
  });
});
