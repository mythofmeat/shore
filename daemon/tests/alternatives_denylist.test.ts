import { describe, expect, test } from "bun:test";

import { MessageStore, cannotTravelInAlternative } from "../src/engine/message_store.ts";
import type { ContentBlock, Message, MessageAlternative } from "../src/engine/types.ts";

const THINKING: ContentBlock = { type: "thinking", thinking: "weighing", signature: "sig" };
const TEXT: ContentBlock = { type: "text", text: "an answer" };
const IMAGE: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
};
const TOOL_USE: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
const TOOL_RESULT: ContentBlock = {
  type: "tool_result",
  tool_use_id: "t1",
  content: "file text",
  is_error: false,
};

function assistant(blocks: ContentBlock[]): Message {
  return {
    msg_id: "m1",
    role: "assistant",
    content: "an answer",
    images: [],
    content_blocks: blocks,
    timestamp: "2026-08-12T00:00:00Z",
  };
}

describe("cannotTravelInAlternative", () => {
  test("only what genuinely cannot travel is removed", () => {
    expect(cannotTravelInAlternative(TOOL_USE)).toBe(true);
    expect(cannotTravelInAlternative(TOOL_RESULT)).toBe(true);
    expect(cannotTravelInAlternative({ type: "text", text: "   " })).toBe(true);
  });

  test("everything else is kept, including block types nobody enumerated", () => {
    expect(cannotTravelInAlternative(THINKING)).toBe(false);
    expect(cannotTravelInAlternative(TEXT)).toBe(false);
    expect(cannotTravelInAlternative(IMAGE)).toBe(false);
    expect(cannotTravelInAlternative({ type: "redacted_thinking", data: "opaque" })).toBe(false);
    expect(cannotTravelInAlternative({ type: "future_block" } as unknown as ContentBlock)).toBe(
      false,
    );
  });
});

function storedAlt(blocks: ContentBlock[], live = assistant(blocks)): MessageAlternative {
  const messages = [live];
  MessageStore.attachGeneratedAlt(messages, []);
  return (messages[0]?.alternatives ?? [])[0] as MessageAlternative;
}

describe("a stored alternative is a copy with the unusable parts removed", () => {
  test("thinking, its signature, and an image all survive", () => {
    const blocks = storedAlt([THINKING, IMAGE, TEXT]).content_blocks;

    expect(blocks.map((b) => b.type)).toEqual(["thinking", "image", "text"]);
    expect((blocks[0] as { signature?: string }).signature).toBe("sig");
  });

  test("an orphaned tool_use does not, since its results are not stored with it", () => {
    expect(storedAlt([TOOL_USE, TEXT]).content_blocks.map((b) => b.type)).toEqual(["text"]);
  });

  test("the alternative does not alias the live message's blocks", () => {
    const live = assistant([THINKING, TEXT]);
    const stored = storedAlt([THINKING, TEXT], live).content_blocks[0] as { thinking: string };

    (live.content_blocks[0] as { thinking: string }).thinking = "mutated afterwards";
    expect(stored.thinking).toBe("weighing");
  });
});
