import { describe, expect, test } from "bun:test";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import {
  buildZaiMessages,
  buildZaiParams,
  resolveZaiBaseUrl,
  ZAI_BASE_URL,
  ZAI_CODING_BASE_URL,
  zaiGenerateResponse,
  zaiStreamEvents,
} from "../src/llm/providers/zai.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";

function req(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "zai",
    model: "glm-5.1",
    api_key: "k",
    provider_key: "zai",
    messages: [],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    ...over,
  };
}

function asChunk(raw: unknown): ChatCompletionChunk {
  return raw as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const item of arr) yield asChunk(item);
}

function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("request construction", () => {
  test("resolves default, subscription, and explicit base URLs", () => {
    expect(resolveZaiBaseUrl(req())).toBe(ZAI_BASE_URL);
    expect(resolveZaiBaseUrl(req({ provider_options: { zai_subscription: true } }))).toBe(
      ZAI_CODING_BASE_URL,
    );
    expect(
      resolveZaiBaseUrl(
        req({
          base_url: "https://custom.example/v4/",
          provider_options: { zai_subscription: true },
        }),
      ),
    ).toBe("https://custom.example/v4");
  });

  test("a subscription key reaches the coding endpoint even when discovery stamped the standard base URL", () => {
    expect(
      resolveZaiBaseUrl(
        req({
          base_url: "https://api.z.ai/api/paas/v4",
          provider_options: { zai_subscription: true },
        }),
      ),
    ).toBe(ZAI_CODING_BASE_URL);
    expect(
      resolveZaiBaseUrl(req({ base_url: "https://api.z.ai/api/paas/v4" })),
    ).toBe(ZAI_BASE_URL);
  });

  test("builds Z.ai params with thinking controls, tools, sampling, and usage streaming", () => {
    const params = buildZaiParams(
      req({
        max_tokens: 2048,
        temperature: 0.7,
        top_p: 0.9,
        provider_options: { zai_clear_thinking: true, reasoning_effort: "high" },
        tools: [
          {
            name: "search",
            description: "Search things",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      }),
      true,
    );

    expect(params.model).toBe("glm-5.1");
    expect(params.max_tokens).toBe(2048);
    expect(params.temperature).toBe(0.7);
    expect(params.top_p).toBe(0.9);
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(params.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(params.reasoning_effort).toBe("high");
    expect(params.tools as unknown).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search things",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
  });

  test("omits clear_thinking when not explicitly set (lets Z.ai default apply)", () => {
    const params = buildZaiParams(req({ provider_options: { reasoning_effort: "high" } }), false);
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.thinking).not.toHaveProperty("clear_thinking");
  });

  test("sends clear_thinking:false only when operator sets it explicitly", () => {
    const params = buildZaiParams(req({ provider_options: { zai_clear_thinking: false } }), false);
    expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });

  test("disables thinking when thinking_enabled is false (reasoning_effort=off)", () => {
    const params = buildZaiParams(req({ provider_options: { thinking_enabled: false } }), false);
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  test("disabled thinking suppresses reasoning_effort", () => {
    const params = buildZaiParams(
      req({ provider_options: { thinking_enabled: false, reasoning_effort: "high" } }),
      false,
    );
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  test("reasoning_effort=off is not sent as an effort value", () => {
    const params = buildZaiParams(req({ provider_options: { reasoning_effort: "off" } }), false);
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  test("disabled thinking omits clear_thinking and never replays reasoning", () => {
    const params = buildZaiParams(
      req({ provider_options: { thinking_enabled: false, zai_clear_thinking: false } }),
      false,
    );
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.thinking).not.toHaveProperty("clear_thinking");

    const messages = buildZaiMessages(
      req({
        provider_options: { thinking_enabled: false, zai_clear_thinking: false },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "chain", reasoning_content: "chain" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    ) as unknown as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  test("never replays a thinking block that lacks the reasoning carrier", () => {
    const messages = buildZaiMessages(
      req({
        system: [{ text: "You are helpful.", label: "system" }],
        provider_options: { zai_clear_thinking: false },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private chain" },
              { type: "text", text: "visible answer" },
            ],
          },
        ],
      }),
    ) as unknown as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(messages[1]).toEqual({ role: "assistant", content: "visible answer" });
    expect(messages[1]).not.toHaveProperty("reasoning_content");
    expect(messages[1]).not.toHaveProperty("reasoning");
  });

  test("replays prior reasoning_content verbatim from the carrier under Preserved Thinking", () => {
    const messages = buildZaiMessages(
      req({
        provider_options: { zai_clear_thinking: false },
        messages: [
          {
            role: "assistant",
            provider_key: "zai",
            model: "glm-5.1",
            content: [
              { type: "thinking", thinking: "step 1\nstep 2", reasoning_content: "step 1\nstep 2" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    ) as unknown as Array<Record<string, unknown>>;

    expect(messages[0]).toEqual({
      role: "assistant",
      content: "answer",
      reasoning_content: "step 1\nstep 2",
    });
  });

  test("does not replay reasoning when clear_thinking is true or omitted (stateless)", () => {
    const stateless = (over: Partial<SidecarRequest>) =>
      buildZaiMessages(
        req({
          ...over,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "chain", reasoning_content: "chain" },
                { type: "text", text: "answer" },
              ],
            },
          ],
        }),
      ) as unknown as Array<Record<string, unknown>>;

    expect(stateless({ provider_options: { zai_clear_thinking: true } })[0]).not.toHaveProperty(
      "reasoning_content",
    );
    expect(stateless({})[0]).not.toHaveProperty("reasoning_content");
  });

  test("never replays a foreign provider's carrier as Z.ai reasoning", () => {
    const messages = buildZaiMessages(
      req({
        provider_options: { zai_clear_thinking: false },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "or chain", reasoning_details: [{ text: "or chain" }] },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    ) as unknown as Array<Record<string, unknown>>;

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  test("passes inline system messages through as raw system messages", () => {
    const messages = buildZaiMessages(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "system", content: [{ type: "text", text: "behave" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      }),
    );

    expect(messages[1]).toEqual({ role: "system", content: "behave" });
  });
});

test("maps Z.ai stream chunks to StreamEvents", async () => {
  const chunks = [
    {
      model: "glm-5.1-plus",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "think", content: "Hello " },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "lookup", arguments: '{"id":' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: "world", tool_calls: [{ index: 0, function: { arguments: "7}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
        cost: 0.0012,
      },
    },
  ];

  const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks(chunks), fakeClock()));

  expect(events[0]).toEqual({ type: "start", model: "glm-5.1-plus" });
  expect(events[1]).toEqual({ type: "thinking", text: "think" });
  expect(events[2]).toEqual({ type: "reasoning_content", reasoning: "think" });
  expect(events[3]).toEqual({ type: "text", text: "Hello " });
  expect(events[4]).toEqual({ type: "text", text: "world" });
  expect(events[5]).toEqual({
    type: "tool_use",
    id: "call_1",
    name: "lookup",
    input: { id: 7 },
  });
  expect(events[6]).toEqual({
    type: "done",
    content: "Hello world",
    finish_reason: "tool_use",
    usage: {
      input_tokens: 8,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_tokens: 12,
      total_cost_usd: 0.0012,
    },
    timing: { total_ms: 20, time_to_first_token_ms: 10 },
  });
});

test("maps empty streams to start then done", async () => {
  const events = await collect(zaiStreamEvents("glm-5.1", fakeChunks([]), fakeClock()));

  expect(events[0]).toEqual({ type: "start", model: "glm-5.1" });
  expect(events[1]?.type).toBe("done");
});

test("maps Z.ai non-streaming responses to GenerateResponse", () => {
  const response = {
    model: "glm-5.1-plus",
    choices: [
      {
        message: {
          reasoning_content: "think",
          content: "hello",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: { id: 7 } },
            },
          ],
        },
        finish_reason: "sensitive",
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    },
  };

  expect(zaiGenerateResponse("glm-5.1", response, 77)).toEqual({
    content: "hello",
    content_blocks: [
      { type: "thinking", thinking: "think", reasoning_content: "think" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { id: 7 } },
    ],
    finish_reason: "content_filter",
    usage: {
      input_tokens: 15,
      output_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 2,
    },
    timing: { total_ms: 77, time_to_first_token_ms: 77 },
    model: "glm-5.1-plus",
  });
});
