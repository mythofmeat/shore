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
import type { WireMessage } from "../src/llm/types.ts";

function identitiesIn(sent: AnthropicRequestRecord): string[] {
  const wire = JSON.stringify(sent.body.messages);
  return [...wire.matchAll(/The exact model ID is ([a-z0-9-]+)\./g)].map(match => required(match[1]));
}

function blocksOf(message: unknown): unknown {
  const { role, content } = message as { role: string; content: unknown };
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return JSON.stringify({ role, blocks }, (key, value: unknown) => key === "cache_control" ? undefined : value);
}

function keepsCachedPrefix(earlier: AnthropicRequestRecord, later: AnthropicRequestRecord): boolean {
  const before = earlier.body.messages.map(blocksOf);
  const after = later.body.messages.map(blocksOf);
  return before.every((message, index) => message === after[index]);
}

test("each turn carries one identity for its model, and same-model turns keep the cached prefix", async () => {
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
  const say = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
  const reply = { role: "assistant" as const, content: [{ type: "text" as const, text: "Here is the answer." }] };
  const turn = (model: string, messages: WireMessage[]) => runGeneration({ ...base, model, messages },
    { providerKey: "claude-code" }, deps, { signal: AbortSignal.timeout(20_000), sink: () => {} });
  try {
    const models = ["opus", "opus", "claude-opus-4-8", "claude-opus-4-8", "claude-opus-5"];
    const history: WireMessage[] = [];
    for (const [index, model] of models.entries()) {
      history.push(say(`turn ${String(index + 1)}`));
      await turn(model, [...history]);
      history.push(reply);
    }

    expect(mock.requests).toHaveLength(models.length);
    const identities = mock.requests.map(identitiesIn);
    const alias = required(identities[0]?.[0]);
    expect(alias).toStartWith("claude-opus-");
    expect(identities).toEqual(models.map(model => [model === "opus" ? alias : model]));
    expect(keepsCachedPrefix(required(mock.requests[0]), required(mock.requests[1]))).toBe(true);
    expect(keepsCachedPrefix(required(mock.requests[2]), required(mock.requests[3]))).toBe(true);
    expect(JSON.stringify(required(mock.requests[1]).body.system)).toContain("YOU ARE QIFEI");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

const identity = (uuid: string, parentUuid: string, modelId: string) =>
  ({ type: "attachment", uuid, parentUuid, attachment: { type: "model", identity: { modelId, marketingName: null, knowledgeCutoff: null } } });

test("withoutStaleModelIdentity keeps only the latest identity, and only while the model is unchanged", () => {
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null },
    { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { type: "environment" } },
    identity("a2", "a1", "claude-opus-5"),
    { type: "assistant", uuid: "s1", parentUuid: "a2" },
    identity("a3", "s1", "claude-opus-4-8"),
    { type: "user", uuid: "u2", parentUuid: "a3" },
  ] as unknown as Parameters<typeof withoutStaleModelIdentity>[0];

  const current = withoutStaleModelIdentity(entries, true) as unknown as { uuid: string; parentUuid: string | null }[];
  expect(current.map(entry => entry.uuid)).toEqual(["u1", "a1", "s1", "a3", "u2"]);
  expect(current.map(entry => entry.parentUuid)).toEqual([null, "u1", "a1", "s1", "a3"]);

  const switched = withoutStaleModelIdentity(entries, false) as unknown as { uuid: string; parentUuid: string | null }[];
  expect(switched.map(entry => entry.uuid)).toEqual(["u1", "a1", "s1", "u2"]);
  expect(switched.map(entry => entry.parentUuid)).toEqual([null, "u1", "a1", "s1"]);
});

test("withoutStaleModelIdentity leaves a transcript with only the latest identity alone", () => {
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null },
    identity("a1", "u1", "claude-opus-5"),
    { type: "assistant", uuid: "s1", parentUuid: "a1" },
  ] as unknown as Parameters<typeof withoutStaleModelIdentity>[0];
  expect(withoutStaleModelIdentity(entries, true)).toBe(entries);
});
