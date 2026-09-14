import { expect, spyOn, test } from "bun:test";
import { query, type SDKToolProgressMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";

test("a slow Shore tool's SDK heartbeat is not reported as a nested agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-progress-"));
  const mock = await startMockAnthropic({ script: [
    { toolUses: [{ id: "toolu_memory", name: "mcp__shore__ask_memory", input: {} }] },
    { text: "Finished the memory lookup." },
  ] });
  const progress = Promise.withResolvers<void>();
  const notifications: SDKToolProgressMessage[] = [];
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: async function* (params) {
      for await (const event of query({ ...params, options: { ...params.options, env: {
        ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "test-key",
      } } })) {
        if (event.type === "tool_progress") {
          notifications.push(event);
          progress.resolve();
        }
        yield event;
      }
    },
  });
  try {
    const { result } = await runGeneration({
      sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "", base_url: mock.url,
      messages: [{ role: "user", content: [{ type: "text", text: "Look up a memory." }] }],
      tools: [{ name: "ask_memory", description: "Look up a memory", input_schema: { type: "object" } }],
      context: { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
      max_tokens: 256, replay_prior_thinking: "all",
    }, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, {
      signal: AbortSignal.timeout(45_000), tools: {
        messages: [], recordTurn: () => {},
        runTool: async (use) => {
          expect(use.name).toBe("ask_memory");
          await progress.promise;
          return { type: "tool_result", tool_use_id: use.id, content: "A remembered fact." };
        },
      },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      heartbeat: true, tool_name: "mcp__shore__ask_memory", parent_tool_use_id: "toolu_memory",
    });
    expect(result.content).toBe("Finished the memory lookup.");
    expect(mock.requests).toHaveLength(2);
    expect(warnings.mock.calls.flat().some(value => String(value).includes("ignoring nested frames"))).toBe(false);
  } finally {
    progress.resolve();
    warnings.mockRestore();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
