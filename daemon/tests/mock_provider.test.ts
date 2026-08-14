import { afterEach, describe, expect, test } from "bun:test";

import { OpenAIProvider } from "../src/llm/providers/openai.ts";
import { startMockProvider, type MockProvider } from "../src/testing/mock_provider.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";

let running: MockProvider | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function mock(...args: Parameters<typeof startMockProvider>): Promise<MockProvider> {
  running = await startMockProvider(...args);
  return running;
}

function request(mockUrl: string, overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "openai",
    model: "mock-model",
    api_key: "test-key",
    base_url: mockUrl,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 256,
    ...overrides,
  } as SidecarRequest;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("streaming", () => {
  test("text arrives as deltas and ends with one done", async () => {
    const m = await mock({ script: [{ text: "hello there, friend" }] });
    const events = await collect(new OpenAIProvider().stream(request(m.url)));

    expect(events[0]).toEqual({ type: "start", model: "mock-model" });

    const text = events.filter((e) => e.type === "text");
    expect(text.length).toBeGreaterThan(1);
    expect(text.map((e) => (e as { text: string }).text).join("")).toBe("hello there, friend");

    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.content).toBe("hello there, friend");
    expect(done.finish_reason).toBe("end_turn");
  });

  test("usage rides the trailing chunk and reaches done", async () => {
    const m = await mock({
      script: [
        {
          text: "hi",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            total_tokens: 107,
            prompt_tokens_details: { cached_tokens: 90 },
          },
        },
      ],
    });
    const events = await collect(new OpenAIProvider().stream(request(m.url)));
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;

    expect(done.usage.input_tokens).toBe(10);
    expect(done.usage.cache_read_tokens).toBe(90);
    expect(done.usage.output_tokens).toBe(7);
    expect(done.usage.input_tokens + done.usage.cache_read_tokens).toBe(100);
  });

  test("thinking arrives as reasoning_content", async () => {
    const m = await mock({ script: [{ thinking: "let me think about it", text: "yes" }] });
    const events = await collect(new OpenAIProvider().stream(request(m.url)));

    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.map((e) => (e as { text: string }).text).join("")).toBe("let me think about it");
    expect(events.findIndex((e) => e.type === "thinking")).toBeLessThan(
      events.findIndex((e) => e.type === "text"),
    );
  });

  test("a tool call is consolidated into one event with parsed input", async () => {
    const m = await mock({
      script: [
        {
          toolCalls: [{ name: "read", arguments: { path: "/tmp/notes.md", limit: 40 } }],
        },
      ],
    });
    const events = await collect(new OpenAIProvider().stream(request(m.url)));

    const toolUses = events.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({
      type: "tool_use",
      name: "read",
      input: { path: "/tmp/notes.md", limit: 40 },
    });

    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.finish_reason).toBe("tool_use");
  });

  test("two tool calls keep their order and their own arguments", async () => {
    const m = await mock({
      script: [
        {
          toolCalls: [
            { name: "read", arguments: { path: "a" } },
            { name: "search", arguments: { query: "b" } },
          ],
        },
      ],
    });
    const events = await collect(new OpenAIProvider().stream(request(m.url)));
    const toolUses = events.filter((e) => e.type === "tool_use") as Extract<
      StreamEvent,
      { type: "tool_use" }
    >[];

    expect(toolUses.map((e) => e.name)).toEqual(["read", "search"]);
    expect(toolUses[0]!.input).toEqual({ path: "a" });
    expect(toolUses[1]!.input).toEqual({ query: "b" });
    expect(new Set(toolUses.map((e) => e.id)).size).toBe(2);
  });
});

describe("non-streaming", () => {
  test("generate returns content, blocks and usage", async () => {
    const m = await mock({ script: [{ text: "a plain answer" }] });
    const result = await new OpenAIProvider().generate(request(m.url));

    expect(result.content).toBe("a plain answer");
    expect(result.content_blocks).toEqual([{ type: "text", text: "a plain answer" }]);
    expect(result.finish_reason).toBe("end_turn");
    expect(m.requests[0]!.streaming).toBe(false);
  });

  test("generate surfaces a tool call", async () => {
    const m = await mock({ script: [{ toolCalls: [{ name: "git", arguments: { args: ["log"] } }] }] });
    const result = await new OpenAIProvider().generate(request(m.url));

    expect(result.content_blocks).toEqual([
      { type: "tool_use", id: "call_0", name: "git", input: { args: ["log"] } },
    ]);
  });
});

describe("failures", () => {
  test("a scripted status becomes a thrown error, not a done", async () => {
    const m = await mock({ script: [{ status: 429 }] });
    expect(collect(new OpenAIProvider().stream(request(m.url)))).rejects.toThrow();
  });

  test("fallback: null refuses an unscripted turn", async () => {
    const m = await mock({ script: [], fallback: null });
    expect(new OpenAIProvider().generate(request(m.url))).rejects.toThrow();
  });
});

describe("the harness itself", () => {
  test("requests are recorded with the assembled prompt", async () => {
    const m = await mock({ script: [{ text: "ok" }] });
    await new OpenAIProvider().generate(
      request(m.url, {
        system: [{ text: "You are a test.", label: "system" }],
        messages: [{ role: "user", content: [{ type: "text", text: "what is 2+2?" }] }],
      } as Partial<SidecarRequest>),
    );

    expect(m.requests).toHaveLength(1);
    const body = m.requests[0]!.body;
    expect(body.model).toBe("mock-model");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a test." });
    expect(body.messages.at(-1)).toMatchObject({ role: "user" });
    expect(m.requests[0]!.headers["authorization"]).toBe("Bearer test-key");
  });

  test("the script is consumed in order, then the fallback answers", async () => {
    const m = await mock({ script: [{ text: "first" }, { text: "second" }] });
    const provider = new OpenAIProvider();

    expect((await provider.generate(request(m.url))).content).toBe("first");
    expect((await provider.generate(request(m.url))).content).toBe("second");
    expect((await provider.generate(request(m.url))).content).toBe("mock reply to: hello");
  });

  test("push appends to a running script", async () => {
    const m = await mock({ script: [], fallback: null });
    m.push({ text: "added later" });
    expect((await new OpenAIProvider().generate(request(m.url))).content).toBe("added later");
  });

  test("the model list is served for discovery", async () => {
    const m = await mock({ models: ["mock-a", "mock-b"] });
    const listed = (await (await fetch(`${m.url}/models`)).json()) as {
      data: { id: string }[];
    };
    expect(listed.data.map((d) => d.id)).toEqual(["mock-a", "mock-b"]);
  });
});
