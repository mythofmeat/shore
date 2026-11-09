import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";

import { buildCall, turnToVercel } from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";
import { ONE_PIXEL_GIF } from "./support/test_images.ts";

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

describe("turns as the ai SDK takes them", () => {
  const names = new Map<string, string>([["tc_1", "search"], ["tc_2", "look"]]);
  const details = [{ type: "reasoning.text", text: "x" }];
  const gif = { type: "base64" as const, media_type: "image/gif", data: ONE_PIXEL_GIF };
  const tiff = { ...gif, media_type: "image/tiff" };

  test("an assistant turn sends its thought, unless OpenRouter carries it, then its text and calls", () => {
    const turn: TurnMessage = { role: "assistant", content: [
      { type: "thinking", thinking: "p" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "tc_1", name: "search", input: { q: "x" } },
    ] };
    const call = { type: "tool-call" as const, toolCallId: "tc_1", toolName: "search", input: { q: "x" } };
    expect(turnToVercel(turn, names, "moonshot")).toStrictEqual([{ role: "assistant", content: [{ type: "reasoning", text: "p" }, { type: "text", text: "answer" }, call] }]);
    expect(turnToVercel(turn, names, "openrouter")).toStrictEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }, call] }]);
  });

  test("an empty thought sends nothing, and a turn left empty is dropped unless OpenRouter has reasoning details for it", () => {
    const empty: TurnMessage = { role: "assistant", content: [{ type: "thinking", thinking: "" }] };
    const carried: TurnMessage = { role: "assistant", content: [{ type: "thinking", thinking: "", reasoning_details: details }] };
    expect(turnToVercel(empty, names, "moonshot")).toStrictEqual([]);
    expect(turnToVercel(empty, names, "openrouter")).toStrictEqual([]);
    expect(turnToVercel(carried, names, "moonshot")).toStrictEqual([]);
    expect(turnToVercel(carried, names, "openrouter")).toStrictEqual([{ role: "assistant", content: [], providerOptions: { openrouter: { reasoning_details: details } } }]);
  });

  test("reasoning details ride along only to OpenRouter, and only when there are some", () => {
    const turn: TurnMessage = { role: "assistant", content: [{ type: "thinking", thinking: "plan", reasoning_details: details }, { type: "text", text: "hi" }] };
    expect(turnToVercel(turn, names, "moonshot")).toStrictEqual([{ role: "assistant", content: [{ type: "reasoning", text: "plan" }, { type: "text", text: "hi" }] }]);
    expect(turnToVercel(turn, names, "openrouter")).toStrictEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }], providerOptions: { openrouter: { reasoning_details: details } } }]);
    expect(turnToVercel({ role: "assistant", content: [{ type: "text", text: "hi" }] }, names, "openrouter")).toStrictEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
  });

  test("each tool's pictures follow the results under a header, and a picture that can't go becomes a notice", () => {
    const turn: TurnMessage = { role: "user", content: [
      { type: "tool_result", tool_use_id: "tc_1", content: [{ type: "text", text: "found" }, { type: "image", source: gif }] },
      { type: "tool_result", tool_use_id: "tc_2", content: [{ type: "image", source: tiff }] },
      { type: "text", text: "and this" },
      { type: "image", source: gif },
      { type: "image", source: tiff },
    ] };
    expect(turnToVercel(turn, names)).toStrictEqual([
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "tc_1", toolName: "search", output: { type: "text", value: "found" } },
        { type: "tool-result", toolCallId: "tc_2", toolName: "look", output: { type: "text", value: "" } },
      ] },
      { role: "user", content: [
        { type: "text", text: "Images from tool search (tool_call_id: tc_1):" },
        { type: "image", image: ONE_PIXEL_GIF, mediaType: "image/gif" },
        { type: "text", text: "Images from tool look (tool_call_id: tc_2):" },
        { type: "text", text: "[image omitted: a tool result image — image/tiff is not a supported format]" },
        { type: "text", text: "and this" },
        { type: "image", image: ONE_PIXEL_GIF, mediaType: "image/gif" },
        { type: "text", text: "[image omitted: an attached image — image/tiff is not a supported format]" },
      ] },
    ]);
  });

  test("a result finds the name of the call an earlier turn made", () => {
    const call = buildCall({ sdk: "moonshot", model: "kimi-k2-thinking", api_key: "sk-test", max_tokens: 1024, replay_prior_thinking: "all", messages: [
      { role: "user", content: [{ type: "text", text: "find it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tc_9", name: "search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tc_9", content: "found" }] },
    ] });
    expect(call.messages?.at(-1)).toStrictEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "tc_9", toolName: "search", output: { type: "text", value: "found" } }] });
  });
});
