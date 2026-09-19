import { expect, test } from "bun:test";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { handleBash } from "../src/tools/bash.ts";
import type { ToolInput } from "../src/tools/workspace.ts";

test("SDK-normalized bash arguments execute and stay consistent with recorded history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-tool-input-"));
  const input = { command: String.raw`printf '%s' '\u2014' > result.txt` };
  const normalized = { command: "printf '%s' '—' > result.txt" };
  const secondInput = { command: String.raw`printf '%s' '\u2603' > second.txt` };
  const secondNormalized = { command: "printf '%s' '☃' > second.txt" };
  const followup = { command: "cat result.txt second.txt > combined.txt" };
  const mock = await startMockAnthropic({ script: [
    { toolUses: [
      { id: "toolu_unicode", name: "mcp__shore__bash", input },
      { id: "toolu_second", name: "mcp__shore__bash", input: secondInput },
    ] },
    { toolUses: [{ id: "toolu_followup", name: "mcp__shore__bash", input: followup }] },
    { text: "Saved the character." },
  ] });
  const sdkMessages: SDKMessage[] = [];
  const recorded: { role: string; blocks: ContentBlock[] }[] = [];
  const executed: ToolUseEvent[] = [];
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: async function* (params) {
      for await (const event of query({ ...params, options: { ...params.options, env: {
        ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "test-key",
      } } })) {
        sdkMessages.push(event);
        yield event;
      }
    },
  });
  try {
    const { result } = await runGeneration({
      sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "", base_url: mock.url,
      messages: [{ role: "user", content: [{ type: "text", text: "Save the character with bash." }] }],
      tools: [{ name: "bash", description: "Run a shell command", input_schema: {
        type: "object", properties: { command: { type: "string" } }, required: ["command"],
      } }],
      context: { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
      max_tokens: 256, replay_prior_thinking: "all",
    }, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, {
      signal: AbortSignal.timeout(20_000), tools: {
        messages: [], recordTurn: (role, blocks) => { recorded.push({ role, blocks }); },
        runTool: async (use) => {
          executed.push(use);
          const output = await handleBash(use.input as ToolInput, dir, "test");
          return { type: "tool_result", tool_use_id: use.id, content: `exit ${output.exit_code}` };
        },
      },
    });
    expect(result.content).toBe("Saved the character.");
    expect(await readFile(join(dir, "combined.txt"), "utf8")).toBe("—☃");
    expect(executed).toEqual([
      { id: "toolu_unicode", name: "bash", input: normalized },
      { id: "toolu_second", name: "bash", input: secondNormalized },
      { id: "toolu_followup", name: "bash", input: followup },
    ]);
    expect(result.tool_uses).toEqual(executed);
    expect(recorded).toEqual([
      { role: "assistant", blocks: [
        { type: "tool_use", id: "toolu_unicode", name: "bash", input: normalized },
        { type: "tool_use", id: "toolu_second", name: "bash", input: secondNormalized },
      ] },
      { role: "user", blocks: [
        { type: "tool_result", tool_use_id: "toolu_unicode", content: "exit 0" },
        { type: "tool_result", tool_use_id: "toolu_second", content: "exit 0" },
      ] },
      { role: "assistant", blocks: [{ type: "tool_use", id: "toolu_followup", name: "bash", input: followup }] },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "toolu_followup", content: "exit 0" }] },
    ]);
    const completed = sdkMessages.filter(event => event.type === "assistant")
      .flatMap(event => event.message.content).filter(block => block.type === "tool_use");
    expect(completed.map(block => ({ id: block.id, input: block.input }))).toEqual([
      { id: "toolu_unicode", input: normalized },
      { id: "toolu_second", input: secondNormalized },
      { id: "toolu_followup", input: followup },
    ]);
    expect(mock.requests).toHaveLength(3);
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
