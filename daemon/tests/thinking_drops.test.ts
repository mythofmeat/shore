import { describe, expect, test } from "bun:test";

import {
  replayableMessages,
  replayableMessagesWithDrops,
  totalThinkingDrops,
} from "../src/llm/replay.ts";
import type { CallContext, SidecarRequest, WireMessage } from "../src/llm/types.ts";

function signedThinking(provider: string, model: string): WireMessage {
  return {
    role: "assistant",
    provider_key: provider,
    model,
    content: [
      { type: "thinking", thinking: "weighing it up", signature: "sig-abc" },
      { type: "text", text: "here is my answer" },
    ],
  };
}

function request(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-5",
    api_key: "k",
    max_tokens: 100,
    replay_prior_thinking: "all",
    messages: [],
    ...over,
  } as SidecarRequest;
}

function context(): CallContext {
  return { character: "Rhia", call_type: "message", thinking_enabled: true };
}

describe("thinking blocks that cannot travel are counted", () => {
  test("a block minted by another model is dropped and the drop is recorded", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request({ messages: [signedThinking("anthropic", "claude-sonnet-5")] }),
    );

    expect(drops.unportable).toBe(1);
    expect(totalThinkingDrops(drops)).toBe(1);
    expect(messages[0]?.content.map((b) => b.type)).toEqual(["text"]);
  });

  test("a block minted by this same provider and model still travels", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request({ messages: [signedThinking("anthropic", "claude-opus-5")] }),
    );

    expect(totalThinkingDrops(drops)).toBe(0);
    expect(messages[0]?.content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  test("a policy strip is counted separately from an unportable one", () => {
    const { drops } = replayableMessagesWithDrops(
      request({
        replay_prior_thinking: "none",
        messages: [signedThinking("anthropic", "claude-opus-5")],
      }),
    );

    expect(drops.strippedByPolicy).toBe(1);
    expect(drops.unportable).toBe(0);
  });

  test("an unsigned block dropped for want of a carrier is its own count", () => {
    const { drops } = replayableMessagesWithDrops(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "no signature here" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    );

    expect(drops.uncarried).toBe(1);
  });
});

describe("the count reaches the call log", () => {
  test("a stripped history is visible on the request context", () => {
    const ctx = context();
    replayableMessages(
      request({ context: ctx, messages: [signedThinking("anthropic", "claude-sonnet-5")] }),
    );
    expect(ctx.thinking_dropped).toBe(1);
  });

  test("a clean request records zero rather than leaving the field unset", () => {
    const ctx = context();
    replayableMessages(
      request({ context: ctx, messages: [signedThinking("anthropic", "claude-opus-5")] }),
    );
    expect(ctx.thinking_dropped).toBe(0);
  });
});
