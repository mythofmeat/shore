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

const drop = (messages: WireMessage[], provider = "anthropic", model = "claude-opus-4-8") =>
  dropUnverifiableThinking(messages, provider, model);

describe("what the anthropic api will not verify", () => {
  const signed = { type: "thinking", thinking: "t", signature: "sig" };

  test("an unsigned block is dropped, because the api rejects one", () => {
    const { messages } = drop([thinkingTurn({ type: "thinking", thinking: "private chain" })]);
    expect(types(messages)).toEqual([["text"]]);
  });

  test("thinking minted by the active model is replayed", () => {
    const { messages } = drop([
      thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-8" }),
    ]);
    expect(types(messages)).toEqual([["thinking", "text"]]);
  });

  test("thinking minted by another model of the same provider is dropped", () => {
    const { messages } = drop([
      thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-6" }),
    ]);
    expect(types(messages)).toEqual([["text"]]);
  });

  test("a foreign carrier is dropped when provenance is unknown", () => {
    const { messages } = drop([
      thinkingTurn({ type: "thinking", thinking: "t", reasoning_details: [{ x: 1 }] }),
    ]);
    expect(types(messages)).toEqual([["text"]]);
  });

  test("a plain legacy blob with no provenance is kept", () => {
    const { messages } = drop([thinkingTurn(signed)]);
    expect(types(messages)).toEqual([["thinking", "text"]]);
  });

  test("an OpenRouter-tagged redacted blob is refused here", () => {
    const blob: WireMessage = {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "openrouter.reasoning:abc" },
        { type: "text", text: "answer" },
      ],
    };
    expect(types(drop([blob]).messages)).toEqual([["text"]]);
  });

  test("a turn left with nothing is dropped rather than sent empty", () => {
    const bare: WireMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "unsigned" }],
    };
    expect(drop([bare]).messages).toEqual([]);
  });
});
