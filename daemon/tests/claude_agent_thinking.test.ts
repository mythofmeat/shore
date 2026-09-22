import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";

test.each([
  { model: "claude-opus-5", withTools: true, display: undefined },
  { model: "claude-opus-4-8", withTools: false, display: undefined },
  { model: "claude-haiku-4-5-20251001", withTools: false, display: undefined },
  { model: "claude-opus-5", withTools: false, display: "omitted" as const },
  { model: "claude-opus-5", withTools: false, display: undefined, reasoningOff: true },
  { model: "claude-opus-5", withTools: true, display: undefined, reasoningOff: true },
  { model: "claude-opus-5", withTools: false, display: undefined, noEffort: true },
])("the real SDK carries thinking through to client frames (%j)", async ({ model, withTools, display, reasoningOff, noEffort }) => {
  const wanted = reasoningOff === true ? undefined : display ?? "summarized";
  const options = reasoningOff === true
    ? { thinking_enabled: false }
    : { ...(noEffort === true ? {} : { reasoning_effort: "high" }), ...(display === undefined ? {} : { thinking_display: display }) };
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-thinking-"));
  const summary = "Checking the request.";
  let round = 0;
  const mock = await startMockAnthropic({ fallback: sent => {
    const thinking = sent.body.thinking as { display?: string } | undefined;
    return {
      ...(thinking?.display === "summarized" ? { thinking: summary, thinkingSignature: "signed-thinking" } : {}),
      ...(withTools && round++ === 0
        ? { toolUses: [{ id: "toolu_memory", name: "mcp__shore__ask_memory", input: {} }] }
        : { text: "Here is the answer." }),
    };
  } });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "test-key",
    } } }),
  });
  const frames: ServerMessage[] = [];
  const recorded: ContentBlock[] = [];
  try {
    const { result } = await runGeneration({
      sdk: "claude_agent", model, api_key: "", base_url: mock.url,
      messages: [{ role: "user", content: [{ type: "text", text: "Look up a memory and explain it." }] }],
      provider_options: options,
      context: { character: "test", workspace_dir: dir, thinking_enabled: reasoningOff !== true && noEffort !== true, call_type: "message" },
      max_tokens: 4096, replay_prior_thinking: "all",
      ...(withTools ? { tools: [{ name: "ask_memory", description: "Look up a memory", input_schema: { type: "object" } }] } : {}),
    }, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, {
      signal: AbortSignal.timeout(20_000), sink: frame => { frames.push(frame); },
      ...(withTools ? { tools: {
        messages: [], recordTurn: (_role, blocks) => { recorded.push(...blocks); },
        runTool: async use => {
          expect(use.name).toBe("ask_memory");
          return { type: "tool_result", tool_use_id: use.id, content: "A remembered fact." };
        },
      } } : {}),
    });
    const thinkingText = frames.flatMap(frame => frame.type === "stream_chunk" && frame.content_type === "thinking" ? [frame.text] : []).join("");
    expect(thinkingText).toBe(wanted === "summarized" ? summary.repeat(withTools ? 2 : 1) : "");
    expect(result.content).toBe("Here is the answer.");
    expect(mock.requests).toHaveLength(withTools ? 2 : 1);
    for (const sent of mock.requests) {
      if (reasoningOff === true) {
        expect(sent.body.thinking).toEqual({ type: "disabled" });
        continue;
      }
      expect(sent.body.thinking).toMatchObject({ display: wanted });
      expect((sent.body.thinking as { type: string }).type).toBe(model.startsWith("claude-opus") ? "adaptive" : "enabled");
    }
    if (wanted === "summarized") {
      expect(result.content_blocks).toContainEqual({ type: "thinking", thinking: summary, signature: "signed-thinking" });
      if (withTools) expect(recorded).toContainEqual({ type: "thinking", thinking: summary, signature: "signed-thinking" });
    }
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
