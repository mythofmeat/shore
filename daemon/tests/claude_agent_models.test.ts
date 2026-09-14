import { expect, spyOn, test } from "bun:test";
import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProviders, refreshAllProviderModels, refreshProviderModels } from "../src/commands/providers.ts";
import { changeThreadModel, effectiveChatModel, favoriteModel, listModels, setModelSetting, switchModel } from "../src/commands/models.ts";
import { parseConfigTable, type TomlTable } from "../src/config/loader.ts";
import { toRequestModel } from "../src/config/models.ts";
import { buildRequestWithProviderKeys } from "../src/llm/request.ts";
import { cachePath, readCache } from "../src/llm/discovery.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";
import { refreshPass } from "../src/daemon/auto_discovery.ts";
import { discoverClaudeAgent, type ClaudeAgentModelQuery } from "../src/llm/providers/claude_agent_models.ts";

test("provider-only Claude Agent configuration discovers, selects, and uses SDK models without API keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-models-"));
  const mock = await startMockAnthropic({ script: [{ text: "Reply from the selected SDK model." }] });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const env = {
    HOME: dir, CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: mock.url,
  };
  try {
    const config = parseConfigTable(Bun.TOML.parse(`
[providers.claude_agent]
[providers.claude_agent.discovery]
enabled = true
ignore = ["haiku"]
[providers.claude_agent.defaults]
max_output_tokens = 256
[defaults]
model = "claude_agent:default"
`) as TomlTable, { config: dir, data: dir, cache: dir, runtime: dir });
    await refreshProviderModels({ config, runClaudeAgentQuery: params => {
      expect(params.options?.persistSession).toBe(false);
      return query({ ...params, options: { ...params.options, env: { ...params.options?.env, ...env } } });
    } }, { provider: "claude_agent" });
    expect(mock.requests).toHaveLength(0);
    const cache = required(await readCache(cachePath(dir, "claude_agent")));
    const sonnet = required(cache.models.find(model => model.model_id === "sonnet"));
    expect(sonnet.sdk).toBe("claude_agent");
    expect(sonnet.display_name).toBeString();
    const metadata = sonnet.raw_provider_metadata as ModelInfo;
    expect(sonnet.support?.effort?.levels).toEqual(metadata.supportedEffortLevels);
    const ctx = { config, dataDir: dir, characterName: "test", activeModel: undefined };
    const listed = JSON.stringify(listModels(ctx, {}));
    expect(listed).toContain("claude_agent:sonnet");
    expect(listed).not.toContain("claude_agent:haiku");
    expect(JSON.stringify(listModels(ctx, { include_hidden: true }))).toContain("claude_agent:haiku");
    expect(() => switchModel(ctx, { name: "claude_agent:haiku" })).toThrow("hidden");
    let threadModel: string | undefined;
    expect(await changeThreadModel(ctx, { name: "claude_agent:sonnet" }, async selected => {
      threadModel = selected;
    })).toMatchObject({
      qualified_name: "claude_agent:sonnet", provider: "claude_agent", model_id: "sonnet",
    });
    setModelSetting(ctx, { name: "claude_agent:sonnet", key: "reasoning_effort", value: "low" });
    expect(threadModel).toBe("claude_agent:sonnet");
    const selected = required(effectiveChatModel(config, "test", threadModel));
    expect(selected.sdk).toBe("claude_agent");
    expect(selected.reasoningEffort).toBe("low");
    const { request } = buildRequestWithProviderKeys(toRequestModel(selected), undefined, {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], replay: "all",
    }, {});
    expect(request.api_key).toBe("");
    request.context = { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" };
    const provider = new ClaudeAgentProvider({
      bookPath: () => join(dir, "sessions.json"),
      runQuery: params => query({ ...params, options: {
        ...params.options, env: { ...params.options.env, ...env },
      } }),
    });
    const { result } = await runGeneration(request, { providerKey: selected.providerKey }, {
      config, providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, { signal: AbortSignal.timeout(20_000) });
    expect(result.content).toBe("Reply from the selected SDK model.");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body.model).toBe(metadata.resolvedModel);
    expect(warnings.mock.calls.flat().some(value => String(value).includes("deprecated"))).toBe(false);
  } finally {
    warnings.mockRestore();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("custom SDK providers auto-discover, preserve capabilities and old caches on failure, and accept explicit IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-custom-models-"));
  try {
    const config = parseConfigTable(Bun.TOML.parse(`
[providers.subscription]
sdk = "claude_agent"
base_url = "http://local-model-endpoint.invalid"
[providers.subscription.discovery]
enabled = true
[providers.subscription.defaults]
max_context_tokens = 123456
`) as TomlTable, { config: dir, data: dir, cache: dir, runtime: dir });
    const models: ModelInfo[] = [
      { value: "sonnet", displayName: "Sonnet", description: "SDK alias",
        resolvedModel: "claude-sonnet-test", supportsEffort: true,
        supportedEffortLevels: ["low", "high"], supportsAdaptiveThinking: true },
      { value: "haiku", displayName: "Haiku", description: "No effort",
        supportsEffort: false, supportsAdaptiveThinking: false },
      { value: "unknown", displayName: "Unknown", description: "Unreported capabilities" },
    ];
    let opened = 0;
    let closed = 0;
    const runClaudeAgentQuery: ClaudeAgentModelQuery = params => {
      opened++;
      expect(params.options?.env?.ANTHROPIC_BASE_URL).toBe("http://local-model-endpoint.invalid");
      expect(params.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(params.options?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "",
      );
      return { supportedModels: async () => models, close: () => { closed++; } };
    };
    const ctx = { config, dataDir: dir, characterName: "test", activeModel: undefined };
    const discovery = { config: () => config, runClaudeAgentQuery };
    await refreshPass(discovery);
    await refreshPass(discovery);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    const cacheFile = cachePath(dir, "subscription");
    const saved = await readFile(cacheFile, "utf8");
    const cache = required(await readCache(cacheFile));
    expect(cache.base_url).toBe("http://local-model-endpoint.invalid");
    expect(cache.models[1]?.support).toEqual({
      effort: { supported: false, levels: [] }, thinking: { adaptive: false },
    });
    expect(cache.models[2]?.support).toBeUndefined();
    expect(listProviders({ config })).toMatchObject({ providers: [{ sdk: "claude_agent", keys: [] }] });
    switchModel(ctx, { name: "subscription:sonnet" });
    expect(effectiveChatModel(config, "test")?.maxContextTokens).toBe(123456);
    expect(() => setModelSetting(ctx, { name: "subscription:sonnet", key: "reasoning_effort", value: "max" }))
      .toThrow();
    const explicit = "subscription:claude-opus-4-8";
    switchModel(ctx, { name: explicit });
    favoriteModel(ctx, { name: explicit });
    expect(effectiveChatModel(config, "test")).toMatchObject({ sdk: "claude_agent", modelId: "claude-opus-4-8" });
    expect(JSON.stringify(listModels(ctx, {}))).toContain(explicit);
    const failed = await refreshAllProviderModels({ config, runClaudeAgentQuery: () => ({
      supportedModels: async () => { throw new Error("SDK initialization failed"); },
      close: () => { closed++; },
    }) });
    expect(failed).toMatchObject({ results: [{ provider: "subscription", ok: false }] });
    expect(JSON.stringify(failed)).toContain("SDK initialization failed");
    expect(closed).toBe(2);
    expect(await readFile(cacheFile, "utf8")).toBe(saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK discovery reports a launch failure", async () => {
  expect(await discoverClaudeAgent("claude_agent", undefined, () => {
    throw new Error("SDK executable unavailable");
  })).toMatchObject({ err: { provider: "claude_agent", message: "SDK executable unavailable" } });
});
