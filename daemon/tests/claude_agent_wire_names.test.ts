import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { contextFilterEnvironment } from "../src/llm/providers/claude_agent_injections.ts";
import { restoredToolNames, restoringToolNames, type WireNames } from "../src/llm/providers/claude_agent_wire_names.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";

const SCHEMA = { type: "object", properties: { query: { type: "string" } } };

function toolUseNames(body: { messages: unknown[] }): string[] {
  return body.messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? content.flatMap((block: { type?: string; name?: string }) => block.type === "tool_use" ? [String(block.name)] : [])
      : [];
  });
}

async function proxied(mockUrl: string, body: unknown): Promise<Response> {
  const base = contextFilterEnvironment(mockUrl).ANTHROPIC_BASE_URL;
  return fetch(`${String(base)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function streamed(wireNames: WireNames, chunks: (string | Uint8Array)[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(restoringToolNames(wireNames))).arrayBuffer());
}

test("the model is offered Shore's tools under their own names, and a call it makes runs whether it arrives in a response that isn't streamed or in one split byte by byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-names-"));
  const mock = await startMockAnthropic({
    streamBytesPerChunk: 1,
    script: [
      { status: 404 },
      { toolUses: [{ id: "toolu_whole", name: "bash", input: { command: "ls" } }] },
      { toolUses: [{ id: "toolu_split", name: "mcp__notes__find", input: { query: "groceries" } }] },
      { text: "Done." },
    ],
  });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const ran: string[] = [];
  try {
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "opus",
      system: [{ label: "soul", text: "You are Heidi." }],
      tools: [
        { name: "bash", description: "Run a shell command", input_schema: SCHEMA },
        { name: "mcp__notes__find", description: "Find a note", input_schema: SCHEMA },
      ],
      context: { character: "heidi", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
      max_tokens: 1024, reasoning_replay: "all",
      messages: [{ role: "user", content: [{ type: "text", text: "What do I need to buy?" }] }],
    }, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, {
      signal: AbortSignal.timeout(60_000), sink: () => {},
      tools: { messages: [], recordTurn: () => {}, runTool: (use: ToolUseEvent) => {
        ran.push(use.name);
        return Promise.resolve({ type: "tool_result" as const, tool_use_id: use.id, content: `${use.name} ran` });
      } },
    });

    expect(result.content).toBe("Done.");
    expect(ran).toEqual(["bash", "mcp__notes__find"]);
    expect(mock.requests.map(request => request.streaming)).toEqual([true, false, true, true]);
    for (const sent of mock.requests) {
      const offered = (sent.body.tools as { name: string }[]).map(tool => tool.name);
      expect(offered).toContain("bash");
      expect(offered).toContain("mcp__notes__find");
      expect(JSON.stringify(sent.body)).not.toContain("mcp__shore__");
    }
    expect(toolUseNames(mock.requests[3]?.body ?? { messages: [] })).toEqual(["bash", "mcp__notes__find"]);
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

test("every name Shore's tools reach the API under loses the CLI's prefix, unless another tool already has that name, and the model's own arguments are left as it wrote them", async () => {
  const mock = await startMockAnthropic({ script: [{ text: "Noted." }] });
  try {
    const response = await proxied(mock.url, {
      model: "claude-opus-5",
      max_tokens: 100,
      tools: [
        { name: "mcp__shore__read", input_schema: SCHEMA },
        { name: "mcp__shore__mcp__notes__find", input_schema: SCHEMA },
        { name: "mcp__shore__look", input_schema: SCHEMA },
        { name: "look", input_schema: SCHEMA },
      ],
      tool_choice: { type: "tool", name: "mcp__shore__read" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["mcp__shore__read", "look"] }] },
      messages: [
        { role: "user", content: [{ type: "text", text: "Find my list." }] },
        { role: "assistant", content: [
          { type: "text", text: "Looking.", citations: null },
          { type: "tool_use", id: "toolu_1", name: "mcp__shore__mcp__notes__find", input: { query: "list", plan: [{ type: "tool_use", name: "mcp__shore__read" }] } },
          { type: "tool_use", id: "toolu_2", name: "mcp__shore__edit_thread", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "tool_reference", tool_name: "mcp__shore__read" }] },
          { type: "tool_result", tool_use_id: "toolu_2", content: "done" },
        ] },
        { role: "system", content: [
          { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "mcp__shore__write", input_schema: SCHEMA } } },
          { type: "tool_addition", tool: { type: "tool_reference", name: "mcp__shore__read" } },
          { type: "tool_removal", tool: { type: "tool_reference", name: "mcp__shore__mcp__notes__find" } },
        ] },
      ],
    });
    expect(response.status).toBe(200);
    expect(mock.requests[0]?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 100,
      tools: [
        { name: "read", input_schema: SCHEMA },
        { name: "mcp__notes__find", input_schema: SCHEMA },
        { name: "mcp__shore__look", input_schema: SCHEMA },
        { name: "look", input_schema: SCHEMA },
      ],
      tool_choice: { type: "tool", name: "read" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["read", "look"] }] },
      messages: [
        { role: "user", content: [{ type: "text", text: "Find my list." }] },
        { role: "assistant", content: [
          { type: "text", text: "Looking.", citations: null },
          { type: "tool_use", id: "toolu_1", name: "mcp__notes__find", input: { query: "list", plan: [{ type: "tool_use", name: "mcp__shore__read" }] } },
          { type: "tool_use", id: "toolu_2", name: "edit_thread", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "tool_reference", tool_name: "read" }] },
          { type: "tool_result", tool_use_id: "toolu_2", content: "done" },
        ] },
        { role: "system", content: [
          { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "write", input_schema: SCHEMA } } },
          { type: "tool_addition", tool: { type: "tool_reference", name: "read" } },
          { type: "tool_removal", tool: { type: "tool_reference", name: "mcp__notes__find" } },
        ] },
      ],
    });
  } finally {
    await mock.stop();
  }
});

test("the calls in a response get the prefix back only for names the request took it off, streamed or not, and an error comes back as it was", async () => {
  const calls = ["read", "mcp__notes__find", "edit_thread", "write", "look", "mcp__shore__look", "made_up"];
  const reply = {
    text: "Voilà — café ✓",
    toolUses: calls.map((name, index) => ({ id: `toolu_${String(index)}`, name, input: { n: index } })),
  };
  const mock = await startMockAnthropic({ streamBytesPerChunk: 3, script: [reply, reply, { status: 529 }] });
  const request = (stream: boolean) => ({
    model: "claude-opus-5",
    max_tokens: 100,
    stream,
    tools: [
      { name: "mcp__shore__read", input_schema: SCHEMA },
      { name: "mcp__shore__mcp__notes__find", input_schema: SCHEMA },
      { name: "mcp__shore__look", input_schema: SCHEMA },
      { name: "look", input_schema: SCHEMA },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Go on." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "mcp__shore__edit_thread", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "done" }] },
      { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "mcp__shore__write" } } }] },
    ],
  });
  const restored = ["mcp__shore__read", "mcp__shore__mcp__notes__find", "mcp__shore__edit_thread", "mcp__shore__write", "look", "mcp__shore__look", "made_up"];
  try {
    const whole = (await (await proxied(mock.url, request(false))).json()) as { content: { type: string; name?: string; text?: string; input?: unknown }[] };
    expect(whole.content.map(block => block.name ?? block.text)).toEqual(["Voilà — café ✓", ...restored]);
    expect(whole.content.flatMap(block => block.type === "tool_use" ? [block.input] : [])).toEqual(calls.map((_, n) => ({ n })));

    const sse = await (await proxied(mock.url, request(true))).text();
    const events = sse.split("\n").flatMap(line => line.startsWith("data:") ? [JSON.parse(line.slice(5)) as Record<string, unknown>] : []);
    const started = events.flatMap(event => event.type === "content_block_start" ? [event.content_block as { type: string; name?: string }] : []);
    expect(started.map(block => block.name ?? block.type)).toEqual(["text", ...restored]);
    const text = events.flatMap(event => {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      return delta?.type === "text_delta" ? [delta.text] : [];
    }).join("");
    expect(text).toBe("Voilà — café ✓");

    const failed = await proxied(mock.url, request(true));
    expect(failed.status).toBe(529);
    expect(await failed.json()).toEqual({ type: "error", error: { type: "mock_error", message: "scripted 529" } });
  } finally {
    await mock.stop();
  }
});

const STREAM = [
  "event: message_start\n",
  `data: {"type": "message_start", "message": {"content": [], "usage": {"input_tokens": 3}}}\n\n`,
  "event: content_block_start\n",
  `data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n`,
  "event: content_block_delta\n",
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Voilà — ✓"}}\n\n`,
  "event: content_block_start\n",
  `data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_a", "name": "made_up", "input": {}}}\n\n`,
  "event: content_block_start\n",
  `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_b","name":"read","input":{}}}\n\n`,
  "event: message_stop\n",
  `data: {"type":"message_stop"}\n\n`,
].join("");
const RESTORED_STREAM = STREAM.replace(`"id":"toolu_b","name":"read"`, `"id":"toolu_b","name":"mcp__shore__read"`);

test("a stream comes back as it was sent except the names of the calls it restores, however its bytes are split", async () => {
  const wireNames = new Map([["read", "mcp__shore__read"]]);
  const bytes = new TextEncoder().encode(STREAM);
  const split = (size: number) => Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.slice(i * size, (i + 1) * size));
  for (const chunks of [[bytes], split(1), split(7), split(64)]) {
    expect(new TextDecoder().decode(await streamed(wireNames, chunks))).toBe(RESTORED_STREAM);
  }
  const unended = STREAM.slice(0, STREAM.indexOf("\n\nevent: message_stop"));
  expect(new TextDecoder().decode(await streamed(wireNames, [unended]))).toBe(RESTORED_STREAM.slice(0, RESTORED_STREAM.indexOf("\n\nevent: message_stop")));
});

test("each line of a stream is passed on as soon as it is complete, not held for the rest", async () => {
  const restoring = restoringToolNames(new Map([["read", "mcp__shore__read"]]));
  const writer = restoring.writable.getWriter();
  const reader = restoring.readable.getReader();
  const decoder = new TextDecoder();
  void writer.write(new TextEncoder().encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"re`));
  expect(decoder.decode((await reader.read()).value)).toBe("event: content_block_start\n");
  void writer.write(new TextEncoder().encode(`ad","input":{}}}\n\nevent: ping\n`));
  expect(decoder.decode((await reader.read()).value)).toBe(`data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"mcp__shore__read","input":{}}}\n\nevent: ping\n`);
  void writer.close();
  expect(decoder.decode((await reader.read()).value)).toBe("");
});

test("a whole response with no call to restore comes back exactly as it was sent", () => {
  const wireNames = new Map([["read", "mcp__shore__read"]]);
  const pretty = JSON.stringify({ content: [{ type: "text", text: "Hi." }, { type: "tool_use", id: "t", name: "made_up", input: {} }] }, null, 2);
  for (const body of [pretty, JSON.stringify({ input_tokens: 12 }, null, 2), "upstream unavailable", ""]) {
    expect(restoredToolNames(body, wireNames)).toBe(body);
  }
  expect(JSON.parse(restoredToolNames(pretty.replace("made_up", "read"), wireNames))).toEqual({
    content: [{ type: "text", text: "Hi." }, { type: "tool_use", id: "t", name: "mcp__shore__read", input: {} }],
  });
});
