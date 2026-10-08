import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { readBook } from "../src/llm/providers/agent_sessions.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";

test("a retry after a cancelled reply resumes from the last reply Shore kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-cancelled-"));
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Here is the answer." }) });
  const book = join(dir, "sessions.json");
  const provider = new ClaudeAgentProvider({
    bookPath: () => book,
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "test-key",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const say = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
  const reply: WireMessage = { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] };
  const turn = (messages: WireMessage[]) => runGeneration({
    sdk: "claude_agent", model: "claude-opus-5", api_key: "", base_url: mock.url, messages,
    context: { character: "heidi", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
    max_tokens: 1024, replay_prior_thinking: "all",
  }, { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(20_000), sink: () => {} });
  try {
    await turn([say("first")]);

    const [key, record] = required(Object.entries(readBook(book))[0]);
    const leaf = required(record.pendingAssistantUuids?.at(-1));
    const retried = randomUUID();
    const cancelled = randomUUID();
    await nativeHistoryStore(book, key).append({ projectKey: "", sessionId: record.sessionId }, [
      { type: "user", uuid: retried, parentUuid: leaf, sessionId: record.sessionId, isSidechain: false,
        userType: "external", cwd: dir, timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "second" }] } },
      { type: "assistant", uuid: cancelled, parentUuid: retried, sessionId: record.sessionId, isSidechain: false,
        userType: "external", cwd: dir, timestamp: new Date().toISOString(),
        message: { id: "msg_cancelled", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "CANCELLED REPLY" }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "last-prompt", lastPrompt: "second", leafUuid: cancelled, sessionId: record.sessionId },
    ]);

    await turn([say("first"), reply, say("second")]);

    const sent = JSON.stringify(required(mock.requests.at(-1)).body.messages);
    expect(sent).not.toContain("CANCELLED REPLY");
    expect(sent.split("second").length - 1).toBe(1);
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
