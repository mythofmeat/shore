import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fixture from "./commands_fixtures/model_commands.json" with { type: "json" };

import { CommandError } from "../src/commands/errors.ts";
import {
  backgroundModels,
  listModels,
  modelInfo,
  modelSettings,
  resetModel,
  setModelSetting,
  switchModel,
  type ModelsContext,
} from "../src/commands/models.ts";
import { defaultAppConfig, parseAppConfig, type AppConfig } from "../src/config/app.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  catalogFromSections,
  emptyCatalog,
  resolvedModelToWire,
  type ModelCatalog,
} from "../src/config/models.ts";
import {
  characterPreferencesPath,
  configView,
  globalPreferencesPath,
  loadPreferences,
  type ModelPreferences,
  type SamplerSettings,
} from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { cachePath } from "../src/llm/discovery.ts";
import { testTmp } from "./support/tmp.ts";

interface WireError {
  code: string;
  message: string;
}

interface Setup {
  catalog: string;
  defaults: string;
  discovery: { provider: string; models: { model_id: string; visible: boolean }[] }[];
  character: string | null;
  global_prefs: string | null;
  character_prefs: string | null;
  active_model: string | null;
  pre_resolved: string | null;
}

interface Session {
  active_model: string | null;
  active_resolved_model: Record<string, unknown> | null;
}

interface Prefs {
  global_exists: boolean;
  global: unknown;
  character_exists?: boolean;
  character?: unknown;
}

interface Step {
  op: string;
  args: Record<string, unknown>;
  ok?: unknown;
  err?: WireError;
  session: Session;
  prefs: Prefs;
}

interface Scenario {
  name: string;
  note: string;
  setup: Setup;
  initial: { session: Session; prefs: Prefs };
  steps: Step[];
}

const scenarios = fixture.scenarios as unknown as Scenario[];

const parseToml = (src: string): unknown => Bun.TOML.parse(src);

async function buildContext(setup: Setup): Promise<ModelsContext> {
  const root = await mkdtemp(testTmp("shore-modelcmd-"));
  const dirs: ShoreDirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  await mkdir(dirs.cache, { recursive: true });
  await mkdir(dirs.data, { recursive: true });

  let app: AppConfig = defaultAppConfig();
  if (setup.defaults.trim() !== "") {
    const parsed = parseAppConfig(parseToml(setup.defaults) as never);
    if ("err" in parsed) throw new Error(`fixture defaults do not parse: ${parsed.err}`);
    app = parsed.ok;
  }

  const models: ModelCatalog =
    setup.catalog === ""
      ? emptyCatalog()
      : catalogFromSections(
          (parseToml(setup.catalog) as Record<string, unknown>)["chat"] as Record<string, unknown>,
          undefined,
          undefined,
        );

  let providers = ProviderRegistry.empty();
  let sectionText = "";
  for (const d of setup.discovery) {
    const hidden = d.models.filter((m) => !m.visible).map((m) => `"${m.model_id}"`);
    sectionText +=
      `[${d.provider}]\nsdk = "anthropic"\napi_key_env = "TEST_KEY"\n` +
      `[${d.provider}.discovery]\nenabled = true\nignore = [${hidden.join(", ")}]\n`;

    const cache = {
      version: 1,
      provider_key: d.provider,
      fetched_at: "2026-07-01T00:00:00Z",
      models: d.models.map((m) => ({
        provider_key: d.provider,
        model_id: m.model_id,
        sdk: "anthropic",
        discovered_at: "2026-07-01T00:00:00Z",
        context_length: 250_000,
        max_output_tokens: 32_000,
      })),
    };
    const path = cachePath(dirs.cache, d.provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache, null, 2));
  }
  if (sectionText !== "") {
    providers = ProviderRegistry.fromSection(parseToml(sectionText) as Record<string, unknown>);
  }

  const config = { app, models, providers, dirs } as LoadedConfig;

  if (setup.global_prefs !== null) {
    const path = globalPreferencesPath(dirs.data);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, setup.global_prefs);
  }
  if (setup.character_prefs !== null && setup.character !== null) {
    const path = characterPreferencesPath(dirs.data, setup.character);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, setup.character_prefs);
  }

  return {
    config,
    dataDir: dirs.data,
    characterName: setup.character ?? undefined,
    activeModel: setup.active_model ?? undefined,
    activeResolvedModel:
      setup.pre_resolved === null
        ? undefined
        : findEffectiveModel(configView(config), dirs.cache, setup.pre_resolved, true),
  };
}

function samplerWire(s: SamplerSettings): Record<string, unknown> {
  const keepalive = s.cacheKeepalive;
  return {
    temperature: s.temperature ?? null,
    top_p: s.topP ?? null,
    reasoning_effort: s.reasoningEffort ?? null,
    budget_tokens: s.budgetTokens ?? null,
    max_output_tokens: s.maxOutputTokens ?? null,
    cache_ttl: s.cacheTtl ?? null,
    cache_keepalive:
      keepalive === undefined
        ? null
        : keepalive.kind === "off"
          ? "off"
          : keepalive.interval.toString(),
    sdk: s.sdk ?? null,
    replay_prior_thinking: s.replayPriorThinking ?? null,
    max_tool_iterations: s.maxToolIterations ?? null,
    openrouter_provider: s.openrouterProvider ?? null,
    gemini_generation: s.geminiGeneration ?? null,
    zai_clear_thinking: s.zaiClearThinking ?? null,
    zai_subscription: s.zaiSubscription ?? null,
  };
}

function prefsWire(prefs: ModelPreferences): unknown {
  return {
    selected: {
      provider: prefs.selected.provider ?? null,
      model_id: prefs.selected.modelId ?? null,
    },
    defaults: { sampler: samplerWire(prefs.defaults.sampler) },
    models: Object.fromEntries(
      [...prefs.models.entries()].map(([key, entry]) => [key, samplerWire(entry.sampler)]),
    ),
  };
}

function readPrefs(ctx: ModelsContext, expected: Prefs): Prefs {
  const globalPath = globalPreferencesPath(ctx.dataDir);
  const out: Prefs = {
    global_exists: existsSync(globalPath),
    global: prefsWire(loadPreferences(globalPath)),
  };
  if (expected.character_exists !== undefined && ctx.characterName !== undefined) {
    const path = characterPreferencesPath(ctx.dataDir, ctx.characterName);
    out.character_exists = existsSync(path);
    out.character = prefsWire(loadPreferences(path));
  }
  return out;
}

function readSession(ctx: ModelsContext): Session {
  return {
    active_model: ctx.activeModel ?? null,
    active_resolved_model:
      ctx.activeResolvedModel === undefined ? null : resolvedModelToWire(ctx.activeResolvedModel),
  };
}

function runStep(ctx: ModelsContext, step: Step): unknown {
  switch (step.op) {
    case "list_models":
      return listModels(ctx, step.args);
    case "model_info":
      return modelInfo(ctx, step.args);
    case "model_settings":
      return modelSettings(ctx, step.args);
    case "background_models":
      return backgroundModels(ctx);
    case "switch_model":
      return switchModel(ctx, step.args);
    case "reset_model":
      return resetModel(ctx);
    case "set_model_setting":
      return setModelSetting(ctx, step.args);
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

describe("model commands", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const ctx = await buildContext(scenario.setup);

      expect(readSession(ctx), "initial session").toEqual(
        scenario.initial.session as never,
      );
      expect(readPrefs(ctx, scenario.initial.prefs), "initial prefs").toEqual(
        scenario.initial.prefs as never,
      );

      for (const step of scenario.steps) {
        const label = `${step.op} ${JSON.stringify(step.args)}`;
        let result: unknown;
        let thrown: unknown;
        try {
          result = runStep(ctx, step);
        } catch (e) {
          thrown = e;
        }

        if (step.err !== undefined) {
          expect(thrown, label).toBeInstanceOf(CommandError);
          expect((thrown as CommandError).code, label).toBe(step.err.code as never);
          expect((thrown as CommandError).message, label).toBe(step.err.message);
        } else {
          expect(thrown, label).toBeUndefined();
          expect(result, label).toEqual(step.ok as never);
        }

        expect(readSession(ctx), `${label} — session`).toEqual(
          step.session as never,
        );
        expect(readPrefs(ctx, step.prefs), `${label} — prefs`).toEqual(
          step.prefs as never,
        );
      }
    });
  }
});

test("the active model is the one generation resolves, not the session's", async () => {
  const ctx = await buildContext({
    catalog: '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n' +
      '[chat.anthropic.beta]\nmodel_id = "beta-id"\n',
    defaults: "",
    discovery: [],
    character: "ada",
    global_prefs: null,
    character_prefs: '[selected]\nprovider = "anthropic"\nmodel_id = "beta-id"\n',
    active_model: "chat.anthropic.alpha",
    pre_resolved: null,
  });

  expect((listModels(ctx, {}) as { active: string }).active).toBe("chat.anthropic.beta");
  expect((modelInfo(ctx, {}) as { qualified_name: string }).qualified_name).toBe(
    "chat.anthropic.beta",
  );
});
