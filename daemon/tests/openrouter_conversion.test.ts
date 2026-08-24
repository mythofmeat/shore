import { describe, expect, test } from "bun:test";

import { ChatMessages$outboundSchema, ChatRequest$outboundSchema } from "@openrouter/sdk/models";

import { buildCall, turnToOpenRouter } from "../src/llm/providers/openrouter.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";

type Rec = Record<string, unknown>;
const conv = (t: TurnMessage) => turnToOpenRouter(t) as unknown as Rec[];

describe("turnToOpenRouter", () => {
  test("assistant text + tool_use → content + toolCalls; no reasoning leaked", () => {
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    });
    expect(m?.role).toBe("assistant");
    expect(m?.content).toBe("let me check");
    const calls = m?.toolCalls as Rec[] | undefined;
    expect(calls?.[0]).toMatchObject({
      id: "tu_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    });
    expect(m).not.toHaveProperty("reasoning");
    expect(m).not.toHaveProperty("reasoningDetails");
  });

  test("thinking block with reasoning_details → replays them verbatim", () => {
    const details = [{ type: "reasoning.text", text: "prior", id: "r1", format: "unknown" }];
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "prior", reasoning_details: details },
        { type: "tool_use", id: "tu_2", name: "f", input: {} },
      ],
    });
    expect(m?.reasoningDetails).toEqual(details);
  });

  test("thinking block carrying only an Anthropic signature → no replay", () => {
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "Ev0BCkYIB...opaque-anthropic-sig" },
        { type: "text", text: "hi" },
      ],
    });
    expect(m).not.toHaveProperty("reasoningDetails");
  });

  test("user tool_result → role:tool with toolCallId", () => {
    const msgs = conv({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found 5 results" }],
    });
    expect(msgs[0]).toEqual({ role: "tool", toolCallId: "tu_1", content: "found 5 results" });
  });

  test("user text → single role:user message", () => {
    const msgs = conv({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("inline system turn passes through raw (no wrapper)", () => {
    const msgs = conv({ role: "system", content: [{ type: "text", text: "be brief" }] });
    expect(msgs[0]).toEqual({ role: "system", content: "be brief" });
  });
});

describe("the OpenRouter SDK accepts what turnToOpenRouter builds", () => {
  const PNG_B64 = "iVBORw0KGgo=";
  const DATA_URL = `data:image/png;base64,${PNG_B64}`;

  const turns: TurnMessage[] = [
    { role: "system", content: [{ type: "text", text: "be brief" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm", reasoning_details: [] },
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "5 hits" }] },
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
        { type: "text", text: "what is this?" },
      ],
    },
  ];

  test("every converted message passes the schema the SDK validates against", () => {
    for (const turn of turns) {
      for (const msg of turnToOpenRouter(turn)) {
        expect(() => ChatMessages$outboundSchema.parse(msg)).not.toThrow();
      }
    }
  });

  test("an image part serializes to the snake_case wire shape", () => {
    const [msg] = turnToOpenRouter(turns[3] as TurnMessage);
    expect(ChatMessages$outboundSchema.parse(msg)).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "text", text: "what is this?" },
      ],
    });
  });
});

describe("openrouter_provider routing reaches the wire", () => {
  const routed = (routing: unknown) => {
    const req = {
      model: "anthropic/claude-opus-4",
      max_tokens: 256,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      provider_options: { openrouter_provider: routing },
    } as unknown as SidecarRequest;
    const { chatRequest } = buildCall(req, true);
    return ChatRequest$outboundSchema.parse(chatRequest).provider as Record<string, unknown>;
  };

  test("snake_case keys from config survive instead of being silently dropped", () => {
    expect(
      routed({
        order: ["anthropic"],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        max_price: { prompt: "10", completion: "20" },
      }),
    ).toEqual({
      order: ["anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      max_price: { prompt: "10", completion: "20" },
    });
  });

  test("camelCase keys are accepted too", () => {
    expect(routed({ allowFallbacks: false, requireParameters: true })).toEqual({
      allow_fallbacks: false,
      require_parameters: true,
    });
  });

  test("values are left alone", () => {
    expect(routed({ order: ["z_ai", "deep_infra"], sort: { by: "throughput" } })).toEqual({
      order: ["z_ai", "deep_infra"],
      sort: { by: "throughput" },
    });
  });
});
