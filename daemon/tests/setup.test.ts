import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fixture from "./handler_fixtures/setup.json" with { type: "json" };

import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { characterDataDir, characterWorkspaceDir } from "../src/config/dirs.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  catalogFromSections,
  emptyCatalog,
  NO_CHAT_MODELS_MESSAGE,
  type ModelCatalog,
  type ResolvedModel,
} from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { cachePath } from "../src/llm/discovery.ts";
import type { SamplerSettings } from "../src/config/preferences.ts";
import type { Message } from "../src/engine/types.ts";
import { McpRegistry } from "../src/tools/mcp_registry.ts";
import {
  buildGenerationRequest,
  resolveGenerationModel,
  type SetupEngine,
} from "../src/handler/setup.ts";
import { testTmp } from "./support/tmp.ts";

const ZONE = fixture.timezone as string;

interface WireModel {
  name: string;
  qualified_name: string;
  category: string;
  provider_key: string;
  sdk: string;
  model_id: string;
  api_key_env: string | null;
  base_url: string | null;
  max_context_tokens: number | null;
  max_output_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  reasoning_effort: string | null;
  budget_tokens: number | null;
  cache_ttl: string | null;
  cache_keepalive: string | null;
  openrouter_provider: unknown;
  gemini_generation: number | null;
  zai_clear_thinking: boolean | null;
  zai_subscription: boolean | null;
  replay_prior_thinking: string | null;
  max_tool_iterations: number | null;
}

interface ResolveCase {
  name: string;
  note: string;
  input: {
    active_model: WireModel | null;
    default_model: string | null;
    with_catalog: boolean;
    discovery: {
      provider: string;
      models: { model_id: string; visible: boolean }[];
    } | null;
    overlay: Record<string, unknown>;
  };
  result: { ok: WireModel } | { err: string };
}

interface BuildCase {
  name: string;
  note: string;
  input: {
    history: Message[];
    with_segments: boolean;
    regen: boolean;
    enabled_tools: string[];
    mcp_tools: { server: string; tool: string }[];
    sdk: string;
    timestamps: "never" | "always" | "auto";
    rich_model: boolean;
    max_context_tokens: number;
    max_output_tokens: number;
    temperature: number;
  };
  request: Record<string, unknown>;
}

const RUST_NO_MODEL = "No model configured";

function expectedFailure(err: string): string {
  return err === RUST_NO_MODEL ? NO_CHAT_MODELS_MESSAGE : err;
}

const resolveCases = fixture.resolve_generation_model as unknown as ResolveCase[];
const buildCases = fixture.build_generation_request as unknown as BuildCase[];

const CATALOG_TOML = {
  anthropic: {
    alpha: { model_id: "alpha-id", sdk: "anthropic", temperature: 0.1 },
    beta: { model_id: "beta-id", sdk: "anthropic", temperature: 0.2 },
  },
};

function some<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function toModel(w: WireModel): ResolvedModel {
  return {
    name: w.name,
    qualifiedName: w.qualified_name,
    category: w.category,
    providerKey: w.provider_key,
    sdk: w.sdk as ResolvedModel["sdk"],
    modelId: w.model_id,
    ...opt("apiKeyEnv", w.api_key_env),
    ...opt("baseUrl", w.base_url),
    ...opt("maxContextTokens", w.max_context_tokens),
    ...opt("maxOutputTokens", w.max_output_tokens),
    ...opt("temperature", w.temperature),
    ...opt("topP", w.top_p),
    ...opt("reasoningEffort", w.reasoning_effort),
    ...opt("budgetTokens", w.budget_tokens),
    ...opt("cacheTtl", w.cache_ttl),
    ...opt("openrouterProvider", w.openrouter_provider),
    ...opt("geminiGeneration", w.gemini_generation),
    ...opt("zaiClearThinking", w.zai_clear_thinking),
    ...opt("zaiSubscription", w.zai_subscription),
    ...opt("replayPriorThinking", w.replay_prior_thinking as ResolvedModel["replayPriorThinking"]),
    ...opt("maxToolIterations", w.max_tool_iterations),
    ...(() => {
      expect(w.cache_keepalive).toBeNull();
      return {};
    })(),
  };
}

function fromModel(m: ResolvedModel): WireModel {
  return {
    name: m.name,
    qualified_name: m.qualifiedName,
    category: m.category,
    provider_key: m.providerKey,
    sdk: m.sdk,
    model_id: m.modelId,
    api_key_env: m.apiKeyEnv ?? null,
    base_url: m.baseUrl ?? null,
    max_context_tokens: m.maxContextTokens ?? null,
    max_output_tokens: m.maxOutputTokens ?? null,
    temperature: m.temperature ?? null,
    top_p: m.topP ?? null,
    reasoning_effort: m.reasoningEffort ?? null,
    budget_tokens: m.budgetTokens ?? null,
    cache_ttl: m.cacheTtl ?? null,
    cache_keepalive:
      m.cacheKeepalive === undefined
        ? null
        : m.cacheKeepalive.kind === "off"
          ? "off"
          : m.cacheKeepalive.interval.toString(),
    openrouter_provider: m.openrouterProvider ?? null,
    gemini_generation: m.geminiGeneration ?? null,
    zai_clear_thinking: m.zaiClearThinking ?? null,
    zai_subscription: m.zaiSubscription ?? null,
    replay_prior_thinking: m.replayPriorThinking ?? null,
    max_tool_iterations: m.maxToolIterations ?? null,
  };
}

function toOverlay(raw: Record<string, unknown>): SamplerSettings {
  return {
    ...opt("temperature", raw["temperature"] as number | null),
    ...opt("topP", raw["top_p"] as number | null),
    ...opt("reasoningEffort", raw["reasoning_effort"] as string | null),
    ...opt("budgetTokens", raw["budget_tokens"] as number | null),
    ...opt("maxOutputTokens", raw["max_output_tokens"] as number | null),
    ...opt("maxToolIterations", raw["max_tool_iterations"] as number | null),
  };
}

function baseConfig(dirs: ShoreDirs, app: AppConfig, models: ModelCatalog): LoadedConfig {
  return { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
}

describe("resolveGenerationModel", () => {
  for (const c of resolveCases) {
    test(c.name, async () => {
      const root = await mkdtemp(testTmp("shore-resolve-"));
      const dirs: ShoreDirs = {
        config: join(root, "config"),
        data: join(root, "data"),
        cache: join(root, "cache"),
        runtime: join(root, "run"),
      };
      await mkdir(dirs.cache, { recursive: true });

      const app = defaultAppConfig();
      const defaultModel = some(c.input.default_model);
      if (defaultModel !== undefined) app.defaults.model = defaultModel;
      const models = c.input.with_catalog
        ? catalogFromSections(CATALOG_TOML, undefined, undefined, undefined)
        : emptyCatalog();

      let providers = ProviderRegistry.empty();
      const discovery = c.input.discovery;
      if (discovery !== null) {
        providers = ProviderRegistry.fromSection({
          [discovery.provider]: {
            sdk: "anthropic",
            api_key_env: "TEST_KEY",
            discovery: {
              enabled: true,
              ignore: discovery.models.filter((m) => !m.visible).map((m) => m.model_id),
            },
          },
        });
        const path = cachePath(dirs.cache, discovery.provider);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          JSON.stringify({
            version: 1,
            provider_key: discovery.provider,
            fetched_at: "2026-07-01T00:00:00Z",
            models: discovery.models.map((m) => ({
              provider_key: discovery.provider,
              model_id: m.model_id,
              sdk: "anthropic",
              discovered_at: "2026-07-01T00:00:00Z",
              context_length: 250000,
              max_output_tokens: 32000,
            })),
          }),
        );
      }

      const config = { ...baseConfig(dirs, app, models), providers };
      const active = c.input.active_model === null ? undefined : toModel(c.input.active_model);
      const overlay = toOverlay(c.input.overlay);

      if ("err" in c.result) {
        expect(() => resolveGenerationModel(active, config, overlay)).toThrow(
          expectedFailure(c.result.err),
        );
        return;
      }
      expect(fromModel(resolveGenerationModel(active, config, overlay))).toEqual(
        c.result.ok,
      );
    });
  }
});

function engineFor(c: BuildCase): SetupEngine {
  const history = c.input.history;
  return {
    messages: () => history,
    messagesThroughLastUserTurn: () => {
      const last = history.findLastIndex((m) => m.role === "user");
      return last < 0 ? [] : history.slice(0, last + 1);
    },
    segmentCount: () => (c.input.with_segments ? 1 : 0),
  };
}

describe("buildGenerationRequest", () => {
  for (const c of buildCases) {
    test(c.name, async () => {
      const root = await mkdtemp(testTmp("shore-build-"));
      const dirs: ShoreDirs = {
        config: join(root, "config"),
        data: join(root, "data"),
        cache: join(root, "cache"),
        runtime: join(root, "run"),
      };
      const workspace = characterWorkspaceDir(dirs.config, "qifei");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "SOUL.md"), "I am qifei.\n");
      const activePrompt = join(characterDataDir(dirs.data, "qifei"), "active_prompt");
      await mkdir(activePrompt, { recursive: true });
      await writeFile(join(activePrompt, "AGENTS.md"), "Answer as qifei, tersely.\n");
      await mkdir(dirs.cache, { recursive: true });

      const app = defaultAppConfig();
      app.defaults.display_name = "Ash";
      app.behavior.user_message_timestamps = c.input.timestamps;
      app.tools.enabled_tools = c.input.enabled_tools;

      const resolved: ResolvedModel = {
        name: "opus",
        qualifiedName: "chat.anthropic.opus",
        category: "chat",
        providerKey: "anthropic",
        sdk: c.input.sdk as ResolvedModel["sdk"],
        modelId: "opus-id",
        apiKeyEnv: "TEST_KEY",
        maxContextTokens: c.input.max_context_tokens,
        maxOutputTokens: c.input.max_output_tokens,
        temperature: c.input.temperature,
        ...(c.input.rich_model ? { topP: 0.77, reasoningEffort: "high" } : {}),
      };

      const registry = McpRegistry.fromTools(
        c.input.mcp_tools.map((t) => ({
          server: t.server,
          tool: t.tool,
          full_name: `mcp__${t.server}__${t.tool}`,
          description: `${t.tool} tool`,
          input_schema: { type: "object" },
        })),
      );

      const built = await buildGenerationRequest({
        engine: engineFor(c),
        dataDir: dirs.data,
        charName: "qifei",
        config: baseConfig(dirs, app, emptyCatalog()),
        resolved,
        regen: c.input.regen,
        mcpRegistry: registry,
        timeZone: ZONE,
      });

      expect(JSON.parse(JSON.stringify(built.request))).toEqual(c.request);
    });
  }
});
