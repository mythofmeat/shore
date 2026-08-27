import { describe, expect, test } from "bun:test";

import {
  buildOpenRouterSettings,
  turnToVercel,
  VercelProvider,
} from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";

type Rec = Record<string, unknown>;

function req(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "openrouter",
    provider_key: "openrouter",
    model: "moonshotai/kimi-k3",
    api_key: "sk-test",
    messages: [],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    ...overrides,
  };
}

describe("OpenRouter AI SDK message conversion", () => {
  const names = new Map<string, string>([["tc_1", "search"]]);
  const conv = (turn: TurnMessage) => turnToVercel(turn, names, "openrouter") as unknown as Rec[];

  test("reasoning_details travel as provider metadata without replaying display text", () => {
    const details = [{ type: "reasoning.text", text: "prior", format: "unknown", index: 0 }];
    const [message] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "prior", reasoning_details: details },
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tc_1", name: "search", input: { q: "x" } },
      ],
    });

    expect(message?.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool-call", toolCallId: "tc_1", toolName: "search", input: { q: "x" } },
    ]);
    expect(message?.providerOptions).toEqual({ openrouter: { reasoning_details: details } });
    expect(JSON.stringify(message)).not.toContain('"type":"reasoning"');
  });

  test("an explicit empty reasoning_details array remains present", () => {
    const [message] = conv({
      role: "assistant",
      content: [{ type: "thinking", thinking: "", reasoning_details: [] }],
    });
    expect(message?.providerOptions).toEqual({ openrouter: { reasoning_details: [] } });
  });

  test("tool results retain the tool name required by the AI SDK", () => {
    expect(
      conv({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc_1", content: "found 5" }],
      }),
    ).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc_1",
            toolName: "search",
            output: { type: "text", value: "found 5" },
          },
        ],
      },
    ]);
  });
});

describe("OpenRouter model settings", () => {
  test("routing accepts config snake_case and camelCase keys", () => {
    expect(
      buildOpenRouterSettings(
        req({
          provider_options: {
            openrouter_provider: {
              order: ["DigitalOcean"],
              allowFallbacks: false,
              require_parameters: true,
              maxPrice: { prompt: "10", completion: "20" },
            },
          },
        }),
      ).provider,
    ).toEqual({
      order: ["DigitalOcean"],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: "10", completion: "20" },
    });
  });

  test("a token budget is used when no named effort overrides it", () => {
    expect(
      buildOpenRouterSettings(req({ provider_options: { budget_tokens: 4096 } })).reasoning,
    ).toEqual({ max_tokens: 4096 });
  });
});

describe("official provider request wire shape", () => {
  test("stored reasoning is round-tripped by the provider", async () => {
    let body: Rec | undefined;
    const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
      body = JSON.parse(init.body) as Rec;
      return new Response(
        JSON.stringify({
          id: "gen_1",
          provider: "DigitalOcean",
          model: "moonshotai/kimi-k3",
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
            cost: 0.001,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const details = [
      { type: "reasoning.text", text: "prior", format: "unknown", index: 0 },
    ];
    const provider = new VercelProvider(mockFetch);
    const response = await provider.generate(
      req({
        system: [{ label: "character", text: "be brief" }],
        provider_options: {
          reasoning_effort: "high",
          openrouter_provider: { order: ["DigitalOcean"], allow_fallbacks: false },
        },
        tools: [{ name: "search", description: "Search", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "look this up" }] },
          {
            role: "assistant",
            provider_key: "openrouter",
            model: "moonshotai/kimi-k3",
            content: [
              { type: "thinking", thinking: "prior", reasoning_details: details },
              { type: "tool_use", id: "tc_1", name: "search", input: { z: 1, a: 2 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tc_1", content: "found" }],
          },
        ],
      }),
    );

    expect(body?.model).toBe("moonshotai/kimi-k3");
    expect(body?.reasoning).toEqual({ effort: "high" });
    expect(body?.provider).toEqual({ order: ["DigitalOcean"], allow_fallbacks: false });
    const messages = body?.messages as Rec[];
    const assistant = messages.find((message) => message.role === "assistant");
    const toolResult = messages.find((message) => message.role === "tool");
    expect(assistant).toMatchObject({
      content: null,
      reasoning_details: details,
      tool_calls: [
        {
          id: "tc_1",
          type: "function",
          function: { name: "search", arguments: '{"a":2,"z":1}' },
        },
      ],
    });
    expect(assistant).not.toHaveProperty("reasoning");
    expect(toolResult).toMatchObject({
      role: "tool",
      tool_call_id: "tc_1",
      name: "search",
      content: "found",
    });
    expect(response.usage).toMatchObject({
      input_tokens: 4,
      cache_read_tokens: 8,
      output_tokens: 2,
      total_cost_usd: 0.001,
    });
  });
});
