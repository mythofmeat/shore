import { afterEach, expect, test, describe } from "bun:test";
import { type ChatCompletionChunk, type ChatCompletionCreateParams } from "openai/resources/chat/completions";
import { openAIStreamEvents, applyPromptCaching, buildOpenAIMessages, OpenAIProvider, turnToOpenAI } from "../src/llm/providers/openai.ts";
import { collect, tickingClock, timedChunks } from "./support/stream.ts";
import { REASONING_OFF, type Sdk, type SidecarRequest, type StreamEvent } from "../src/llm/types.ts";

function asChunk(c: unknown): ChatCompletionChunk {
  return c as ChatCompletionChunk;
}

async function* fakeChunks(arr: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const c of arr) yield asChunk(c);
}

test("maps a reasoning + text + split tool_call stream to StreamEvents", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } },
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
          delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        cost: 0.0012,
      },
    },
  ];

  const events = await collect(
    openAIStreamEvents("deepseek/deepseek-v4-pro", fakeChunks(chunks), tickingClock()),
  );

  expect(events[0]).toEqual({ type: "start", model: "deepseek/deepseek-v4-pro" });
  expect(events[1]).toEqual({ type: "thinking", text: "think" });
  expect(events[2]).toEqual({ type: "text", text: "Hello " });
  expect(events[3]).toEqual({ type: "text", text: "world" });
  expect(events[4]).toEqual({
    type: "tool_use",
    id: "call_1",
    name: "search",
    input: { q: "x" },
  });

  const done = events[5];
  expect(done?.type).toBe("done");
  if (done?.type === "done") {
    expect(done.content).toBe("Hello world");
    expect(done.finish_reason).toBe("tool_use");
    expect(done.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 80,
      cache_creation_tokens: 0,
      total_cost_usd: 0.0012,
    });
    expect(done.timing).toEqual({ total_ms: 20, time_to_first_token_ms: 10 });
  }

  expect(events.length).toBe(6);

  for (const e of events) {
    expect(["start", "text", "thinking", "thinking_signature", "redacted_thinking", "tool_use", "done"]).toContain(e.type);
  }
});

test("text-only stream ends with end_turn and no tool_use events", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  ];
  const events = await collect(openAIStreamEvents("openai/gpt-5.5", fakeChunks(chunks), tickingClock()));
  expect(events.map((e) => e.type)).toEqual(["start", "text", "done"]);
  const done = events[2];
  if (done?.type === "done") {
    expect(done.finish_reason).toBe("end_turn");
    expect(done.content).toBe("hi");
    expect(done.usage.total_cost_usd).toBeUndefined();
  }
});

function request(sdk: Sdk, cacheTtl?: string): SidecarRequest {
  return {
    sdk,
    provider_key: sdk === "nanogpt" ? "nanogpt" : "openai",
    model: "anthropic/claude-sonnet-5",
    api_key: "k",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(cacheTtl === undefined ? {} : { provider_options: { cache_ttl: cacheTtl } }),
  } as SidecarRequest;
}

function params(messageCount = 0): ChatCompletionCreateParams {
  return {
    model: "anthropic/claude-sonnet-5",
    messages: Array.from({ length: messageCount }, () => ({
      role: "user" as const,
      content: "hi",
    })),
  };
}

const helperIn = (p: ChatCompletionCreateParams): unknown =>
  (p as unknown as Record<string, unknown>)["prompt_caching"];

describe("the prompt-cache helper nano-gpt reads", () => {

  test("OpenAI's own endpoint never sees the field, which it would reject", () => {
    const p = params();
    applyPromptCaching(request("openai", "1h"), p);
    expect(helperIn(p)).toBeUndefined();
  });
});

interface Seen {
  readonly body: Record<string, unknown>;
  readonly accept: string | null;
}

const servers: Array<{ stop: (force: boolean) => unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

function fakeOpenAI(reply: () => Response) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (incoming) => {
      seen.push({ body: (await incoming.json()) as Record<string, unknown>, accept: incoming.headers.get("accept") });
      return reply();
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${String(server.port)}/v1`, seen };
}

const sse = (chunks: readonly unknown[]): Response =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

const completion = (message: Record<string, unknown>, finish = "stop", usage?: Record<string, unknown>): Response =>
  Response.json({ id: "c1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });

function call(url: string, overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "openai",
    provider_key: "openai",
    model: "gpt-test",
    api_key: "k",
    base_url: url,
    max_tokens: 100,
    replay_prior_thinking: "all",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  };
}

describe("what OpenAI-compatible endpoints are sent", () => {
  test("the model, messages, OpenAI's token limit and only the sampling settings asked for, with tools as functions", async () => {
    const server = fakeOpenAI(() => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]));
    await collect(new OpenAIProvider().stream(call(server.url, {
      temperature: 0.4,
      top_p: 0.9,
      tools: [{ name: "search", description: "look it up", input_schema: { type: "object", properties: { q: { type: "string" } } } }, { name: "ping", description: "no input", input_schema: { type: "object" } }],
    })));
    await collect(new OpenAIProvider().stream(call(server.url)));
    const [tuned, plain] = server.seen;
    expect(tuned?.body).toMatchObject({
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_completion_tokens: 100,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.4,
      top_p: 0.9,
      tools: [
        { type: "function", function: { name: "search", description: "look it up", parameters: { type: "object", properties: { q: { type: "string" } } } } },
        { type: "function", function: { name: "ping", description: "no input", parameters: { type: "object" } } },
      ],
    });
    expect(tuned?.body).not.toHaveProperty("max_tokens");
    expect(tuned?.accept).not.toBe("text/event-stream");
    for (const key of ["temperature", "top_p", "tools", "reasoning_effort"]) expect(plain?.body).not.toHaveProperty(key);
  });

  test("nano-gpt is sent max_tokens, an event-stream Accept header when streaming, and reasoning off when thinking is", async () => {
    const server = fakeOpenAI(() => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]));
    await collect(new OpenAIProvider().stream(call(server.url, { sdk: "nanogpt", provider_key: "nanogpt", provider_options: { thinking_enabled: false } })));
    const thinking = fakeOpenAI(() => completion({ content: "ok" }));
    await new OpenAIProvider().generate(call(thinking.url, { provider_key: "nanogpt", provider_options: { thinking_enabled: true } }));
    const [streamed] = server.seen;
    expect(streamed?.body).toMatchObject({ max_tokens: 100, reasoning_effort: "none" });
    expect(streamed?.body).not.toHaveProperty("max_completion_tokens");
    expect(streamed?.accept).toBe("text/event-stream");
    expect(thinking.seen[0]?.body).toMatchObject({ max_tokens: 100 });
    expect(thinking.seen[0]?.body).not.toHaveProperty("reasoning_effort");
    expect(thinking.seen[0]?.accept).not.toBe("text/event-stream");
  });

  test("a reasoning effort is passed on, with off sent as none", async () => {
    const server = fakeOpenAI(() => completion({ content: "ok" }));
    await new OpenAIProvider().generate(call(server.url, { provider_options: { reasoning_effort: "high" } }));
    await new OpenAIProvider().generate(call(server.url, { provider_options: { reasoning_effort: REASONING_OFF } }));
    await new OpenAIProvider().generate(call(server.url, { provider_options: { reasoning_effort: "", thinking_enabled: false } }));
    expect(server.seen.map((s) => s.body["reasoning_effort"])).toEqual(["high", "none", undefined]);
  });
});

describe("what comes back", () => {
  test("a whole reply is read into thinking, text and tool calls, with an id made up for a call that has none", async () => {
    const server = fakeOpenAI(() => completion({
      reasoning_content: "let me think",
      content: "here",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
        { type: "function", function: { name: "ping", arguments: "" } },
      ],
    }, "tool_calls", { prompt_tokens: 50, completion_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }));
    const reply = await new OpenAIProvider().generate(call(server.url));
    expect(reply).toMatchObject({
      content: "here",
      content_blocks: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "here" },
        { type: "tool_use", id: "call_a", name: "search", input: { q: "x" } },
        { type: "tool_use", id: "tc_1", name: "ping", input: {} },
      ],
      finish_reason: "tool_use",
      usage: { input_tokens: 15, output_tokens: 7, cache_read_tokens: 30, cache_creation_tokens: 5 },
      model: "gpt-test",
    });
    expect(reply.timing.total_ms).toBe(reply.timing.time_to_first_token_ms);

    const other = fakeOpenAI(() => completion({ reasoning: "other field", content: null }, "length"));
    expect(await new OpenAIProvider().generate(call(other.url))).toMatchObject({
      content: "",
      content_blocks: [{ type: "thinking", thinking: "other field" }],
      finish_reason: "max_tokens",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    const empty = fakeOpenAI(() => completion({ reasoning_content: "", content: "" }, "content_filter"));
    expect(await new OpenAIProvider().generate(call(empty.url))).toMatchObject({ content_blocks: [], finish_reason: "content_filter" });
  });

  test("a stream that never sends a token counts the whole time as waiting, and ignores empty deltas", async () => {
    const events = await collect(openAIStreamEvents("m", fakeChunks([
      { choices: [{ index: 0, delta: { content: "", reasoning_content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]), tickingClock()));
    expect(events).toEqual([
      { type: "start", model: "m" },
      { type: "done", content: "", finish_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 10, time_to_first_token_ms: 10 } },
    ]);
  });

  test("the first token is whichever comes first: reasoning, text or a tool call", async () => {
    for (const delta of [{ reasoning: "r" }, { content: "c" }, { tool_calls: [{ index: 0, id: "t", function: { name: "n", arguments: "{}" } }] }]) {
      const events = await collect(openAIStreamEvents("m", fakeChunks([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: "later" }, finish_reason: "stop" }] }]), tickingClock()));
      const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
      expect(done.timing).toEqual({ total_ms: 20, time_to_first_token_ms: 10 });
    }
  });

  test("tool calls streamed out of order come out in order, and a later fragment can name or rename the call", async () => {
    const events = await collect(openAIStreamEvents("m", fakeChunks([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "first", function: { name: "one", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "second", function: { name: "two", arguments: "2}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "first" }] }, finish_reason: null }] },
    ]), tickingClock()));
    expect(events.filter((e) => e.type === "tool_use")).toEqual([
      { type: "tool_use", id: "first", name: "one", input: {} },
      { type: "tool_use", id: "second", name: "two", input: { b: 2 } },
    ]);
  });
});

describe("how conversation turns are written for OpenAI", () => {
  const png = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "iVBORw0K" } };
  const bmp = { type: "image" as const, source: { type: "base64" as const, media_type: "image/bmp", data: "Qk0=" } };

  test("system and assistant turns: text joined, thinking as reasoning_content, tool calls as functions", () => {
    expect(turnToOpenAI({ role: "system", content: [{ type: "text", text: "be " }, { type: "thinking", thinking: "x" }, { type: "text", text: "kind" }] })).toEqual([{ role: "system", content: "be kind" }]);
    expect(turnToOpenAI({ role: "assistant", content: [
      { type: "thinking", thinking: "one" },
      { type: "text", text: "a" },
      { type: "thinking", thinking: "two" },
      { type: "text", text: "b" },
      { type: "tool_use", id: "t1", name: "search", input: { q: 1 } },
      { type: "tool_use", id: "t2", name: "ping", input: undefined },
    ] })).toEqual([{
      role: "assistant",
      content: "ab",
      reasoning_content: "one\n\ntwo",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "search", arguments: '{"q":1}' } },
        { id: "t2", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    } as never]);
    expect(turnToOpenAI({ role: "assistant", content: [{ type: "text", text: "" }] })).toEqual([{ role: "assistant" }]);
  });

  test("a user turn sends its tool results first, then its text and pictures, with pictures it can't send named", () => {
    const toolNames = new Map([["t1", "screenshot"]]);
    expect(turnToOpenAI({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "taken" }, png, bmp] },
        { type: "tool_result", tool_use_id: "t2", content: [png] },
        { type: "tool_result", tool_use_id: "t3", content: "plain" },
        { type: "text", text: "look" },
        png,
        bmp,
      ],
    }, toolNames)).toEqual([
      { role: "tool", tool_call_id: "t1", content: "taken" },
      { role: "tool", tool_call_id: "t2", content: "" },
      { role: "tool", tool_call_id: "t3", content: "plain" },
      { role: "user", content: [
        { type: "text", text: "Images from tool screenshot (tool_call_id: t1):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } },
        { type: "text", text: "[image omitted: a tool result image — image/bmp is not a supported format]" },
        { type: "text", text: "Images from tool result (tool_call_id: t2):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } },
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } },
        { type: "text", text: "[image omitted: an attached image — image/bmp is not a supported format]" },
      ] },
    ] as never);
    expect(turnToOpenAI({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "only" }] })).toEqual([{ role: "tool", tool_call_id: "t1", content: "only" }]);
    expect(turnToOpenAI({ role: "user", content: [] })).toEqual([]);
  });

  test("a request becomes a system message followed by its turns, naming tools by the call that made them", () => {
    expect(buildOpenAIMessages({
      sdk: "openai", model: "gpt-test", api_key: "k", max_tokens: 10, replay_prior_thinking: "all",
      system: [{ text: "be kind", label: "soul" }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [png] }] },
      ],
    })).toEqual([
      { role: "system", content: "be kind" },
      { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "" },
      { role: "user", content: [{ type: "text", text: "Images from tool screenshot (tool_call_id: t1):" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } }] },
    ] as never);
  });
});

describe("prompt-cache settings", () => {
  test("the ledger records the cache lifetime actually used: none where the endpoint can't take one", () => {
    const openai = { ...request("openai", "1h"), context: { character: "ada", call_type: "chat", thinking_enabled: false, cache_ttl: "1h" } };
    applyPromptCaching(openai, params());
    expect(openai.context.cache_ttl).toBeUndefined();
    const nano = { ...request("nanogpt", "1h"), context: { character: "ada", call_type: "chat", thinking_enabled: false, cache_ttl: "1h" } };
    const nanoParams = params(2);
    applyPromptCaching(nano, nanoParams);
    expect(nano.context.cache_ttl).toBe("1h");
    expect(helperIn(nanoParams)).toEqual({ enabled: true, ttl: "1h", stickyProvider: true, explicitCacheControl: true });
    const plain = { ...request("nanogpt"), context: { character: "ada", call_type: "chat", thinking_enabled: false } };
    const plainParams = params(2);
    applyPromptCaching(plain, plainParams);
    expect(plain.context).not.toHaveProperty("cache_ttl");
    expect(helperIn(plainParams)).toBeUndefined();
  });

  test("nano-gpt is told to cache and gets breakpoints on the conversation", async () => {
    const server = fakeOpenAI(() => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]));
    await collect(new OpenAIProvider().stream({ ...call(server.url, { sdk: "nanogpt", provider_key: "nanogpt", model: "anthropic/claude-sonnet-5", provider_options: { cache_ttl: "5m" } }), system: [{ text: "be kind", label: "soul" }] }));
    const body = server.seen[0]?.body;
    expect(body?.["prompt_caching"]).toEqual({ enabled: true, ttl: "5m", stickyProvider: true, explicitCacheControl: true });
    expect(JSON.stringify(body?.["messages"])).toContain('"cache_control":{"type":"ephemeral"}');
  });
});

describe("stream timing", () => {
  const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  test("a one-letter thought or text counts, and the first of them times the first token", async () => {
    const { clock, chunks } = timedChunks<ChatCompletionChunk>(50, [[100, delta({ reasoning_content: "r" })], [200, delta({ content: "a" }, "stop")]], 1000);
    const events = await collect(openAIStreamEvents("m", chunks, clock));
    expect(events.slice(1, -1)).toEqual([{ type: "thinking", text: "r" }, { type: "text", text: "a" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", content: "a", timing: { total_ms: 950, time_to_first_token_ms: 50 } });
  });

  test("a reply that only calls a tool times its first token at the call", async () => {
    const { clock, chunks } = timedChunks<ChatCompletionChunk>(50, [[100, delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "look", arguments: "{}" } }] }, "tool_calls")]], 1000);
    const events = await collect(openAIStreamEvents("m", chunks, clock));
    expect(events.at(-1)).toMatchObject({ type: "done", timing: { total_ms: 950, time_to_first_token_ms: 50 } });
  });
});

describe("the prompt-cache helper is nano-gpt's alone", () => {
  test("another SDK that keeps a cache lifetime still gets no helper", () => {
    const p = params(2);
    applyPromptCaching(request("anthropic", "1h"), p);
    expect(helperIn(p)).toBeUndefined();
  });
});
