import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";

import { buildCall, turnToVercel } from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";

describe("turnToVercel", () => {
  const names = new Map<string, string>([["tc_1", "search"]]);
  const conv = (t: TurnMessage) => turnToVercel(t, names);

  test("tool_result with unknown tool_use_id throws (no empty toolName)", () => {
    expect(() =>
      conv({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc_missing", content: "result" }],
      }),
    ).toThrow(/unknown tool_use_id: tc_missing/);
  });
});

describe("buildCall against the ai SDK's own prompt validation", () => {
  const conversation: SidecarRequest = {
    sdk: "moonshot",
    model: "kimi-k2-thinking",
    api_key: "sk-test",
    system: [{ type: "text", text: "You are Frank." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: [{ type: "text", text: "be brief" }] },
      { role: "user", content: [{ type: "text", text: "how are you" }] },
    ],
    max_tokens: 1024,
    replay_prior_thinking: "all",
  } as unknown as SidecarRequest;

  async function promptSeenByProvider(sidecarRequest: SidecarRequest): Promise<unknown> {
    let seen: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (
        options: LanguageModelV3CallOptions,
      ): Promise<LanguageModelV3GenerateResult> => {
        seen = options.prompt;
        return {
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          content: [{ type: "text", text: "ok" }],
          warnings: [],
        };
      },
    });
    const call = buildCall(sidecarRequest);
    await generateText({ ...call, model: model as unknown as LanguageModel });
    return seen;
  }

  test("the character's system prompt travels as instructions, not a message", () => {
    const call = buildCall(conversation);
    expect(call.instructions).toBe("You are Frank.");
    expect(call.messages?.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
  });

  test("generateText accepts the call: system prompt first, inline note in place", async () => {
    expect(await promptSeenByProvider(conversation)).toEqual([
      { role: "system", content: "You are Frank." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "how are you" }] },
    ]);
  });

  test("a request with no system prompt still validates", async () => {
    const { system: _system, ...rest } = conversation;
    const bare: SidecarRequest = { ...rest, messages: [required(conversation.messages[0])] };
    expect(await promptSeenByProvider(bare)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });
});
