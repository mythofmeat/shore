import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";

import { buildCall, buildProviderOptions, toUsage, turnToVercel } from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";

function req(sdk: "deepseek" | "moonshot", provider_options?: Record<string, unknown>): SidecarRequest {
  return {
    sdk,
    model: sdk === "deepseek" ? "deepseek-reasoner" : "kimi-k2-thinking",
    api_key: "sk-test",
    messages: [],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    ...(provider_options ? { provider_options } : {}),
  };
}

describe("buildProviderOptions", () => {
  test("thinking_enabled=false → thinking disabled (both vendors)", () => {
    expect(buildProviderOptions(req("deepseek", { thinking_enabled: false }))).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(buildProviderOptions(req("moonshot", { thinking_enabled: false }))).toEqual({
      moonshotai: { thinking: { type: "disabled" } },
    });
  });

  test("disable wins over a present effort/budget", () => {
    expect(
      buildProviderOptions(req("deepseek", { thinking_enabled: false, reasoning_effort: "high" })),
    ).toEqual({ deepseek: { thinking: { type: "disabled" } } });
  });

  test("deepseek reasoning_effort → reasoningEffort", () => {
    expect(buildProviderOptions(req("deepseek", { reasoning_effort: "high" }))).toEqual({
      deepseek: { reasoningEffort: "high" },
    });
  });

  test("moonshot budget_tokens → thinking.budgetTokens", () => {
    expect(buildProviderOptions(req("moonshot", { budget_tokens: 4096 }))).toEqual({
      moonshotai: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  test("no reasoning options → undefined", () => {
    expect(buildProviderOptions(req("deepseek"))).toBeUndefined();
    expect(buildProviderOptions(req("moonshot"))).toBeUndefined();
    expect(buildProviderOptions(req("deepseek", { budget_tokens: 4096 }))).toBeUndefined();
    expect(buildProviderOptions(req("moonshot", { reasoning_effort: "high" }))).toBeUndefined();
  });
});

describe("turnToVercel", () => {
  const names = new Map<string, string>([["tc_1", "search"]]);
  const conv = (t: TurnMessage) => turnToVercel(t, names);

  test("assistant thinking + text + tool_use → reasoning/text/tool-call parts", () => {
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tc_1", name: "search", input: { q: "x" } },
      ],
    });
    expect(m?.role).toBe("assistant");
    expect(m?.content).toEqual([
      { type: "reasoning", text: "ponder" },
      { type: "text", text: "answer" },
      { type: "tool-call", toolCallId: "tc_1", toolName: "search", input: { q: "x" } },
    ]);
  });

  test("user tool_result → role:tool with recovered toolName", () => {
    const out = conv({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tc_1", content: "result" }],
    });
    expect(out[0]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "tc_1", toolName: "search", output: { type: "text", value: "result" } },
      ],
    });
  });

  test("tool_result with unknown tool_use_id throws (no empty toolName)", () => {
    expect(() =>
      conv({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc_missing", content: "result" }],
      }),
    ).toThrow(/unknown tool_use_id: tc_missing/);
  });

  test("user text → single role:user message", () => {
    const out = conv({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("empty assistant turn → no message", () => {
    expect(conv({ role: "assistant", content: [] })).toEqual([]);
  });
});

describe("buildMessages tool-name causality", () => {
  const withMessages = (messages: SidecarRequest["messages"]): SidecarRequest => ({
    ...req("deepseek"),
    messages,
  });

  test("tool_result resolves a tool_use from an earlier turn", () => {
    const call = buildCall(
      withMessages([
        { role: "assistant", content: [{ type: "tool_use", id: "tc_1", name: "search", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tc_1", content: "ok" }] },
      ]),
    );
    const toolMsg = call.messages?.find((m) => m.role === "tool");
    expect(toolMsg?.content).toEqual([
      { type: "tool-result", toolCallId: "tc_1", toolName: "search", output: { type: "text", value: "ok" } },
    ]);
  });

  test("tool_result pointing at a LATER tool_use throws (causality)", () => {
    expect(() =>
      buildCall(
        withMessages([
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tc_1", content: "ok" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "tc_1", name: "search", input: {} }] },
        ]),
      ),
    ).toThrow(/unknown tool_use_id: tc_1/);
  });
});

describe("toUsage", () => {
  test("subtracts cache read/write from inputTokens (disjoint buckets)", () => {
    expect(
      toUsage({
        inputTokens: 671464,
        outputTokens: 18579,
        inputTokenDetails: { cacheReadTokens: 579840 },
      } as never),
    ).toEqual({
      input_tokens: 91624,
      output_tokens: 18579,
      cache_read_tokens: 579840,
      cache_creation_tokens: 0,
    });
  });

  test("subtracts both cache read and write", () => {
    expect(
      toUsage({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 12 },
      } as never),
    ).toEqual({
      input_tokens: 18,
      output_tokens: 20,
      cache_read_tokens: 70,
      cache_creation_tokens: 12,
    });
  });

  test("clamps at zero and tolerates missing details", () => {
    expect(toUsage({ inputTokens: 5, outputTokens: 1 } as never)).toEqual({
      input_tokens: 5,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    expect(toUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });
});

describe("buildCall against the ai SDK's own prompt validation", () => {
  const conversation: SidecarRequest = {
    sdk: "moonshot",
    model: "kimi-k2-thinking",
    api_key: "sk-test",
    system: [{ type: "text", text: "You are Poppy." }],
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
    expect(call.instructions).toBe("You are Poppy.");
    expect(call.messages?.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
  });

  test("generateText accepts the call: system prompt first, inline note in place", async () => {
    expect(await promptSeenByProvider(conversation)).toEqual([
      { role: "system", content: "You are Poppy." },
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
