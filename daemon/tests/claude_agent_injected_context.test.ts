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
import { withoutStaleModelIdentity } from "../src/llm/providers/claude_agent_history.ts";
import type { AnthropicRequestRecord } from "../src/testing/mock_anthropic.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";

function identitiesIn(sent: AnthropicRequestRecord): string[] {
  const wire = JSON.stringify(sent.body.messages);
  return [...wire.matchAll(/The exact model ID is ([a-z0-9-]+)\./g)].map(match => required(match[1]));
}

test("a mid-conversation model switch leaves one model identity in context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-injected-"));
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Here is the answer." }) });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
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
  const base = {
    sdk: "claude_agent" as const, api_key: "", base_url: mock.url,
    system: [{ label: "soul", text: "# YOU ARE QIFEI\nYou are a companion, not a coding agent." }],
    context: { character: "qifei", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
    max_tokens: 1024, replay_prior_thinking: "all" as const,
  };
  try {
    await runGeneration({ ...base, model: "claude-opus-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }, { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(20_000), sink: () => {} });

    await runGeneration({ ...base, model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] },
        { role: "user", content: [{ type: "text", text: "how are you?" }] },
      ],
    }, { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(20_000), sink: () => {} });

    expect(mock.requests).toHaveLength(2);
    expect(identitiesIn(required(mock.requests[0]))).toEqual(["claude-opus-5"]);
    expect(identitiesIn(required(mock.requests[1]))).toEqual(["claude-opus-4-8"]);
    expect(JSON.stringify(required(mock.requests[1]).body.system)).toContain("YOU ARE QIFEI");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("withoutStaleModelIdentity drops identity entries and relinks the chain", () => {
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null },
    { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { type: "environment" } },
    { type: "attachment", uuid: "a2", parentUuid: "a1", attachment: { type: "model" } },
    { type: "assistant", uuid: "s1", parentUuid: "a2" },
    { type: "attachment", uuid: "a3", parentUuid: "s1", attachment: { type: "model" } },
    { type: "user", uuid: "u2", parentUuid: "a3" },
  ] as unknown as Parameters<typeof withoutStaleModelIdentity>[0];

  const kept = withoutStaleModelIdentity(entries) as unknown as { uuid: string; parentUuid: string | null }[];
  expect(kept.map(entry => entry.uuid)).toEqual(["u1", "a1", "s1", "u2"]);
  expect(kept.map(entry => entry.parentUuid)).toEqual([null, "u1", "a1", "s1"]);
});

test("withoutStaleModelIdentity leaves an untouched transcript alone", () => {
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null },
    { type: "assistant", uuid: "s1", parentUuid: "u1" },
  ] as unknown as Parameters<typeof withoutStaleModelIdentity>[0];
  expect(withoutStaleModelIdentity(entries)).toBe(entries);
});
