import { describe, expect, test } from "bun:test";

import {
  replayableMessages,
  replayableMessagesWithDrops,
  totalThinkingDrops,
} from "../src/llm/replay.ts";
import { dropUnverifiableThinking } from "../src/llm/providers/anthropic.ts";
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
  };
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

  test("the drop reaches a gemini request too, not just an anthropic one", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request({
        sdk: "gemini",
        provider_key: "gemini",
        model: "gemini-3-pro",
        messages: [signedThinking("anthropic", "claude-opus-5")],
      }),
    );

    expect(drops.unportable).toBe(1);
    expect(messages[0]?.content.map((b) => b.type)).toEqual(["text"]);
  });

  test("an unsigned block carries nothing to invalidate, so it survives replay", () => {
    const { messages, drops } = replayableMessagesWithDrops(
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
});

describe("the anthropic adapter drops what its api cannot verify", () => {
  test("an unsigned block is dropped for want of a signature", () => {
    const { messages, dropped } = dropUnverifiableThinking([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no signature here" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    expect(dropped).toBe(1);
    expect(messages[0]?.content.map((b) => b.type)).toEqual(["text"]);
  });

  test("a signed block that got past replay is left alone", () => {
    const { messages, dropped } = dropUnverifiableThinking([
      signedThinking("anthropic", "claude-opus-5"),
    ]);

    expect(dropped).toBe(0);
    expect(messages[0]?.content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });
});

describe("the count reaches the call log", () => {
  test("a policy strip is visible on the request context", () => {
    const ctx = context();
    replayableMessages(
      request({
        context: ctx,
        replay_prior_thinking: "none",
        messages: [signedThinking("anthropic", "claude-opus-5")],
      }),
    );
    expect(ctx.thinking_dropped).toBe(1);
  });

  test("an unportable block is visible on the request context", () => {
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
