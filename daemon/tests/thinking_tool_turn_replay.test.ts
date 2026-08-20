import { describe, expect, test } from "bun:test";

import { replayableMessagesWithDrops } from "../src/llm/replay.ts";
import { dropUnverifiableThinking } from "../src/llm/providers/anthropic.ts";
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
  };
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

  test("a model switch strips a tool-use turn that the strip policy would have kept", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request([thinkingWithToolUse()], {
        model: "claude-sonnet-5",
        replay_prior_thinking: "all",
      }),
    );

    expect(messages[0]?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(drops.strippedByPolicy).toBe(0);
    expect(drops.unportable).toBe(1);
  });
});

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

describe("the anthropic adapter drops per message, never per block", () => {
  test("one unsigned block takes its signed siblings with it", () => {
    const { messages, dropped } = dropUnverifiableThinking([mixed()]);

    expect(messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
    expect(dropped).toBe(2);
  });

  test("an unsigned block takes a redacted sibling with it too", () => {
    const message: WireMessage = {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "capture lost the signature" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
      ],
    };
    const { messages, dropped } = dropUnverifiableThinking([message]);

    expect(messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
    expect(dropped).toBe(2);
  });

  test("a message whose blocks all carry a signature keeps every one of them", () => {
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
    const { messages, dropped } = dropUnverifiableThinking([message]);

    expect(messages[0]?.content).toHaveLength(4);
    expect(dropped).toBe(0);
  });
});

describe("shared replay drops per message, never per block", () => {
  test("one unportable block takes its signed siblings with it", () => {
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

  test("every other sdk refuses a foreign block the same way", () => {
    const { messages, drops } = replayableMessagesWithDrops(
      request([mixed()], {
        sdk: "moonshot",
        provider_key: "opencode-go",
        model: "kimi-k3",
        replay_prior_thinking: "all",
      }),
    );

    expect(messages[0]?.content.filter((b) => b.type === "thinking")).toHaveLength(0);
    expect(drops.unportable).toBe(2);
  });
});
