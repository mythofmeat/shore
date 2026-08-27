import { describe, expect, test } from "bun:test";

import { VercelProvider } from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";

function req(): SidecarRequest {
  return {
    sdk: "openrouter",
    provider_key: "openrouter",
    model: "moonshotai/kimi-k3",
    api_key: "sk-test",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 1024,
    replay_prior_thinking: "all",
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sseFetch(chunks: unknown[], requestBody: { value?: Record<string, unknown> }): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
    requestBody.value = JSON.parse(init.body) as Record<string, unknown>;
    const data = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(data, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("OpenRouter AI SDK streaming", () => {
  test("reasoning detail deltas become one replayable logical block", async () => {
    const detail = (text: string) => ({
      type: "reasoning.text",
      text,
      format: "unknown",
      index: 0,
    });
    const base = {
      id: "gen_1",
      provider: "DigitalOcean",
      model: "moonshotai/kimi-k3",
      object: "chat.completion.chunk",
      created: 1,
    };
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { reasoning: "ok", reasoning_details: [detail("ok")] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { reasoning: "\n\n\n", reasoning_details: [detail("\n\n\n")] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { reasoning: " i", reasoning_details: [detail(" i")] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          { index: 0, delta: { content: "answer" }, finish_reason: null },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 30,
          total_tokens: 80,
          cost: 0.001,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
    ];
    const captured: { value?: Record<string, unknown> } = {};
    const provider = new VercelProvider(sseFetch(chunks, captured));
    const out = await collect(provider.stream(req()));

    expect(out.map((event) => event.type)).toEqual([
      "start",
      "thinking",
      "thinking",
      "thinking",
      "reasoning_details",
      "text",
      "done",
    ]);
    expect(out.find((event) => event.type === "reasoning_details")).toEqual({
      type: "reasoning_details",
      details: [{ type: "reasoning.text", text: "ok\n\n\n i", format: "unknown", index: 0 }],
    });
    expect(out.at(-1)).toMatchObject({
      type: "done",
      content: "answer",
      finish_reason: "end_turn",
      usage: {
        input_tokens: 10,
        cache_read_tokens: 40,
        output_tokens: 30,
        total_cost_usd: 0.001,
      },
    });
    expect(captured.value?.stream).toBe(true);
    expect(captured.value?.stream_options).toEqual({ include_usage: true });
  });

  test("an empty reasoning_details signal survives a text-only turn", async () => {
    const base = {
      id: "gen_2",
      provider: "DigitalOcean",
      model: "moonshotai/kimi-k3",
      object: "chat.completion.chunk",
      created: 1,
    };
    const chunks = [
      {
        ...base,
        choices: [{ index: 0, delta: { content: "plain" }, finish_reason: null }],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    ];
    const provider = new VercelProvider(sseFetch(chunks, {}));
    const out = await collect(provider.stream(req()));

    expect(out.map((event) => event.type)).toEqual([
      "start",
      "text",
      "reasoning_details",
      "done",
    ]);
    expect(out[2]).toEqual({ type: "reasoning_details", details: [] });
  });
});
