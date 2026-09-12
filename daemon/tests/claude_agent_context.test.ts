import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import { required } from "../src/util/required.ts";
import { appendCompactionTail } from "../src/memory/compaction/llm.ts";
import type { CallRecord } from "../src/call_store.ts";
import type { ContentBlock } from "../src/engine/types.ts";

const dateIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test.each([false, true])("the SDK receives the character context and unwrapped uploads across turns (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-sdk-context-"));
  const workspace = join(dir, "test");
  await mkdir(workspace);
  const config: LoadedConfig = {
    app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: dir, data: dir, cache: dir, runtime: dir, workspace: dir },
  };
  const mock = await startMockAnthropic({ fallback: { text: "reply" } });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: {
      ...params.options,
      env: { ...params.options.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), ANTHROPIC_API_KEY: "test-key" },
    } }),
  });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" } } as const;
  const messages: WireMessage[] = [];
  const captures: CallRecord[] = [];
  const previousTimezone = process.env.TZ;
  const originalDate = dateIn(hostZone());
  let toolCalls = 0;
  const phase: ToolPhase = {
    messages: [], recordTurn: () => {},
    runTool: call => {
      toolCalls += 1;
      return Promise.resolve({ type: "tool_result", tool_use_id: call.id, content: "workspace file contents" });
    },
  };
  try {
    process.env.TZ = required(["Pacific/Pago_Pago", "Pacific/Kiritimati"].find(zone => dateIn(zone) !== originalDate));
    for (const [index, content] of [
      [{ type: "text", text: "First photo" }, image],
      [{ type: "text", text: "Another photo" }, image],
      [{ type: "text", text: "Follow-up question" }],
    ].entries()) {
      messages.push({ role: "user", content: content as WireMessage["content"] });
      if (withTools && index === 2) mock.push({ toolUses: [{ name: "mcp__shore__read", input: {} }] });
      const request: SidecarRequest = {
        sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "", base_url: mock.url,
        messages: [...messages, { role: "system", content: [{ type: "text", text: `Temporary turn instruction ${index}.` }] }], max_tokens: 256, replay_prior_thinking: "all",
        system: [{ label: "character", text: `Character instructions for turn ${index}.` }],
        context: { character: "test", call_type: "message", thinking_enabled: false },
        ...(withTools ? { tools: [{ name: "read", description: "Read the character workspace", input_schema: { type: "object" } }] } : {}),
      };
      const firstRequest = mock.requests.length;
      const signal = AbortSignal.timeout(25_000);
      const { result } = await runGeneration(request, { providerKey: "claude-code" }, {
        config, providers: { claude_agent: provider }, env: {},
        callStore: { recordCall: call => captures.push(call) },
      }, { signal, ...(withTools ? { tools: phase } : {}) });
      expect(result.content).toBe("reply");
      const captured = required(required(captures.at(-1)).response_body).split("\n").map(line => JSON.parse(line) as { type: string; event?: { type: string; subtype?: string; claude_code_version?: string; modelUsage?: Record<string, { outputTokens: number }> } });
      const diagnostics = captured.filter(event => event.type === "provider_event").map(event => required(event.event));
      expect(diagnostics.find(event => event.subtype === "init")?.claude_code_version).toMatch(/^2\.1\./);
      expect(required(diagnostics.find(event => event.type === "result")?.modelUsage)["claude-sonnet-4-6"]?.outputTokens).toBeGreaterThan(0);
      expect(request.context?.workspace_dir).toBe(workspace);
      const sent = required(mock.requests[firstRequest]).body;
      expect(JSON.stringify(sent.messages)).not.toContain("Conversation replay follows");
      expect(JSON.stringify(sent.messages)).not.toContain("current_user_turn");
      expect(JSON.stringify(sent.messages)).not.toContain("[image attached:");
      expect((sent.messages as WireMessage[]).map(message => message.role)).toEqual(messages.map(message => message.role));
      const current = required((sent.messages as WireMessage[]).at(-1));
      for (const block of content) expect<unknown>(current.content).toEqual(expect.arrayContaining([expect.objectContaining(block)]));
      for (const call of mock.requests.slice(firstRequest)) {
        expect(JSON.stringify(call.body)).not.toContain("<total_tokens>");
        expect(JSON.stringify(call.body.system)).toContain(`Character instructions for turn ${index}.`);
        expect(JSON.stringify(call.body.system)).not.toContain("Temporary turn instruction");
        expect(JSON.stringify(call.body.messages)).toContain(`Temporary turn instruction ${index}.`);
        expect(JSON.stringify(call.body.messages)).toContain(`Primary working directory: ${workspace}`);
        expect(JSON.stringify(call.body.messages)).toContain(`Today's date is ${dateIn(hostZone())}.`);
      }
      messages.push({ role: "assistant", content: [{ type: "text", text: "reply" }] });
    }
    expect(toolCalls).toBe(withTools ? 1 : 0);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

test.each([false, true])("compaction keeps the chat system prompt and MCP tools while using tools (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-sdk-compaction-prefix-"));
  const mock = await startMockAnthropic({ fallback: { text: "reply" } });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: {
      ...params.options,
      env: { ...params.options.env, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    } }),
  });
  const request: SidecarRequest = {
    sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "test-key", base_url: mock.url,
    system: [{ label: "character", text: "Stable character instructions." }],
    messages: [{ role: "user", content: [{ type: "text", text: "The original conversation." }] }],
    context: { character: "test", call_type: "message", thinking_enabled: false },
    max_tokens: 256, replay_prior_thinking: "all",
    ...(withTools ? { tools: [
      { name: "read", description: "Read a workspace file.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "edit", description: "Edit a workspace file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
    ] } : {}),
  };
  let toolCalls = 0;
  const phase: ToolPhase = {
    messages: [], recordTurn: () => {},
    runTool: call => {
      toolCalls += 1;
      return Promise.resolve({ type: "tool_result", tool_use_id: call.id, content: `Tool result ${toolCalls}.` });
    },
  };
  const run = async (): Promise<ContentBlock[]> => {
    const signal = AbortSignal.timeout(25_000);
    if (!withTools) return (await provider.generate(request, signal)).content_blocks;
    for await (const event of provider.streamWithTools(request, phase, signal)) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") return required(event.content_blocks) as ContentBlock[];
    }
    throw new Error("SDK tool loop did not finish");
  };
  try {
    const reply = await run();
    request.messages.push({ role: "assistant", content: reply });
    appendCompactionTail(request,
      { role: "user", content: [{ type: "text", text: "Compact this conversation now." }] },
      "Write durable memory before archiving the conversation.");
    request.context = { character: "test", thinking_enabled: false, call_type: "compaction" };
    if (withTools) mock.push(
      { toolUses: [{ id: "toolu_read", name: "mcp__shore__read", input: { path: "memory.md" } }] },
      { toolUses: [{ id: "toolu_edit", name: "mcp__shore__edit", input: { path: "memory.md", content: "Durable memory." } }] },
    );
    await run();
    const first = required(mock.requests[0]).body;
    const compact = required(mock.requests[1]).body;
    for (const sent of mock.requests.slice(1)) {
      expect(JSON.stringify(sent.body.system)).toBe(JSON.stringify(first.system));
      expect(JSON.stringify(sent.body["tools"])).toBe(JSON.stringify(first["tools"]));
    }
    expect(toolCalls).toBe(withTools ? 2 : 0);
    if (withTools) {
      expect((first["tools"] as { name: string }[]).map(tool => tool.name)).toEqual(["mcp__shore__edit", "mcp__shore__read"]);
      expect(mock.requests).toHaveLength(4);
    }
    const messages = compact.messages as WireMessage[];
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(messages[0])).toContain("The original conversation.");
    expect(JSON.stringify(messages.slice(0, -1))).not.toContain("Write durable memory");
    expect(JSON.stringify(messages.at(-1))).toContain("Write durable memory");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
