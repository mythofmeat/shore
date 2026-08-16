import { describe, expect, test } from "bun:test";

import { dropUnverifiableThinking } from "../src/llm/providers/anthropic.ts";
import type { WireMessage } from "../src/llm/types.ts";

function thinkingTurn(
  block: Record<string, unknown>,
  provenance: Partial<WireMessage> = {},
): WireMessage {
  return {
    role: "assistant" as const,
    content: [block as never, { type: "text" as const, text: "answer" }],
    ...provenance,
  };
}

const types = (msgs: WireMessage[]): string[][] => msgs.map((m) => m.content.map((b) => b.type));

const drop = (messages: WireMessage[]) => dropUnverifiableThinking(messages);

describe("what the anthropic api will not verify", () => {
  const signed = { type: "thinking", thinking: "t", signature: "sig" };

  test("an unsigned block is dropped, because the api rejects one", () => {
    const { messages } = drop([thinkingTurn({ type: "thinking", thinking: "private chain" })]);
    expect(types(messages)).toEqual([["text"]]);
  });

  test("a signed block reaching this layer is replayed", () => {
    const { messages } = drop([
      thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-8" }),
    ]);
    expect(types(messages)).toEqual([["thinking", "text"]]);
  });

  test("a redacted block needs no signature of its own", () => {
    const blob: WireMessage = {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-opus-4-8",
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
      ],
    };
    expect(types(drop([blob]).messages)).toEqual([["redacted_thinking", "text"]]);
  });

  test("a turn left with nothing is dropped rather than sent empty", () => {
    const bare: WireMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "unsigned" }],
    };
    expect(drop([bare]).messages).toEqual([]);
  });
});
