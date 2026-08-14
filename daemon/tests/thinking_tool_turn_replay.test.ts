import { describe, expect, test } from "bun:test";

import { replayableMessagesWithDrops } from "../src/llm/replay.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

const SIG = "sig-abc";

function thinkingWithToolUse(): WireMessage {
  return {
    role: "assistant",
    provider_key: "anthropic",
    model: "claude-opus-5",
    content: [
      { type: "thinking", thinking: "", signature: SIG },
      { type: "text", text: "let me look that up" },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
    ],
  };
}

function thinkingWithoutToolUse(): WireMessage {
  return {
    role: "assistant",
    provider_key: "anthropic",
    model: "claude-opus-5",
    content: [
      { type: "thinking", thinking: "weighing it up", signature: SIG },
      { type: "text", text: "here is my answer" },
    ],
  };
}

function request(messages: WireMessage[], over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-5",
    api_key: "k",
    max_tokens: 100,
    replay_prior_thinking: "none",
    messages,
    ...over,
  } as SidecarRequest;
}

describe("the strip policy stops at a tool-use turn", () => {
  test("thinking that accompanies a tool_use survives replay_prior_thinking=none", () => {
    const { messages, drops } = replayableMessagesWithDrops(request([thinkingWithToolUse()]));

    expect(messages[0]?.content[0]).toEqual({ type: "thinking", thinking: "", signature: SIG });
    expect(drops.strippedByPolicy).toBe(0);
  });

  test("thinking on a plain assistant turn is still stripped", () => {
    const { messages, drops } = replayableMessagesWithDrops(request([thinkingWithoutToolUse()]));

    expect(messages[0]?.content).toEqual([{ type: "text", text: "here is my answer" }]);
    expect(drops.strippedByPolicy).toBe(1);
  });

  test("a mixed history strips the plain turn and keeps the tool-use turn", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request([thinkingWithoutToolUse(), thinkingWithToolUse()]),
    );

    expect(messages[0]?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(messages[1]?.content.some((b) => b.type === "thinking")).toBe(true);
    expect(drops.strippedByPolicy).toBe(1);
  });

  test("replay_prior_thinking=all keeps both, as before", () => {
    const { drops } = replayableMessagesWithDrops(
      request([thinkingWithoutToolUse(), thinkingWithToolUse()], { replay_prior_thinking: "all" }),
    );

    expect(drops.strippedByPolicy).toBe(0);
  });

  test("a model switch still strips a tool-use turn, as the docs require", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request([thinkingWithToolUse()], {
        model: "claude-sonnet-5",
        replay_prior_thinking: "all",
      }),
    );

    expect(messages[0]?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(drops.unportable).toBe(1);
  });
});

describe("thinking blocks are dropped per message, never per block", () => {
  function mixed(): WireMessage {
    return {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "signed", signature: SIG },
        { type: "thinking", thinking: "capture lost the signature" },
        { type: "text", text: "answer" },
      ],
    };
  }

  test("one uncarried block takes its signed siblings with it", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request([mixed()], { replay_prior_thinking: "all" }),
    );

    expect(messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
    expect(drops.uncarried).toBe(2);
  });

  test("a redacted_thinking block is dropped with its regular siblings", () => {
    const message: WireMessage = {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-sonnet-5",
      content: [
        { type: "thinking", thinking: "signed", signature: SIG },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
      ],
    };
    const { messages, drops } = replayableMessagesWithDrops(
      request([message], { replay_prior_thinking: "all" }),
    );

    expect(messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
    expect(drops.unportable).toBe(2);
  });

  test("a message whose blocks all travel keeps every one of them", () => {
    const message: WireMessage = {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "first", signature: SIG },
        { type: "redacted_thinking", data: "opaque" },
        { type: "thinking", thinking: "", signature: "second" },
        { type: "text", text: "answer" },
      ],
    };
    const { messages, drops } = replayableMessagesWithDrops(
      request([message], { replay_prior_thinking: "all" }),
    );

    expect(messages[0]?.content).toHaveLength(4);
    expect(drops.uncarried + drops.unportable + drops.strippedByPolicy).toBe(0);
  });
});
