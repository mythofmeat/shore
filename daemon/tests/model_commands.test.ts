import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import rawFixture from "./command_captures/model_commands.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import { CommandError } from "../src/commands/errors.ts";
import {
  changeThreadModel,
  listModels,
  modelRoles,
  modelInfo,
  modelSettings,
  resetModel,
  setModelSetting,
  switchModel,
  type ModelsContext,
} from "../src/commands/models.ts";
import { defaultAppConfig, parseAppConfig, type AppConfig } from "../src/config/app.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  catalogFromSections,
  emptyCatalog,
  type ModelCatalog,
} from "../src/config/models.ts";
import {
  characterPreferencesPath,
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
  discovery: {
    provider: string;
    models: {
      model_id: string;
      visible: boolean;
      supported_parameters?: string[];
      effort_levels?: string[];
    }[];
  }[];
  character: string | null;
  global_prefs: string | null;
  character_prefs: string | null;
  active_model: string | null;
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
  err?: WireError;
  prefs_changed?: Record<string, unknown>;
}

interface Scenario {
  name: string;
  note?: string;
  setup: Setup;
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
    const parsed = parseAppConfig(parseToml(setup.defaults));
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
      version: 2,
      provider_key: d.provider,
      fetched_at: "2026-07-01T00:00:00Z",
      models: d.models.map((m) => ({
        provider_key: d.provider,
        model_id: m.model_id,
        sdk: "anthropic",
        discovered_at: "2026-07-01T00:00:00Z",
        context_length: 250_000,
        max_output_tokens: 32_000,
        support: {
          ...(m.supported_parameters === undefined
            ? {}
            : { supported_parameters: m.supported_parameters }),
          ...(m.effort_levels === undefined
            ? {}
            : { effort: { supported: true, levels: m.effort_levels } }),
        },
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
    cache_keepalive_max: s.cacheKeepaliveMax?.toString() ?? null,
    sdk: s.sdk ?? null,
    replay_prior_thinking: s.replayPriorThinking ?? null,
    max_tool_iterations: s.maxToolIterations ?? null,
    openrouter_provider: s.openrouterProvider ?? null,
    gemini_generation: s.geminiGeneration ?? null,
    zai_clear_thinking: s.zaiClearThinking ?? null,
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

function readPrefs(ctx: ModelsContext): Prefs {
  const globalPath = globalPreferencesPath(ctx.dataDir);
  const out: Prefs = {
    global_exists: existsSync(globalPath),
    global: prefsWire(loadPreferences(globalPath)),
  };
  if (ctx.characterName !== undefined) {
    const path = characterPreferencesPath(ctx.dataDir, ctx.characterName);
    out.character_exists = existsSync(path);
    out.character = prefsWire(loadPreferences(path));
  }
  return out;
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = value;
  return out;
}

function runStep(ctx: ModelsContext, step: Step): unknown {
  switch (step.op) {
    case "list_models":
      return listModels(ctx, step.args);
    case "model_info":
      return modelInfo(ctx, step.args);
    case "model_settings":
      return modelSettings(ctx, step.args);
    case "model_roles":
      return modelRoles(ctx);
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

function expectShapeOf(op: string, result: unknown, label: string): void {
  const row = (result ?? {}) as Record<string, unknown>;

  switch (op) {
    case "list_models": {
      const byProvider = (row["models"] ?? {}) as Record<string, { qualified_name: string; hidden: boolean }[]>;
      const models = Object.values(byProvider).flat();
      const names = models.map((m) => m.qualified_name);
      expect(new Set(names).size, `${label}: every model is listed once`).toBe(names.length);

      for (const [provider, entries] of Object.entries(byProvider)) {
        for (const m of entries) {
          expect(
            m.qualified_name,
            `${label}: a model listed under ${provider} is named for it`,
          ).toContain(provider);
        }
      }

      const listedHidden = models.filter((m) => m.hidden).length;
      if (row["include_hidden"] === true) {
        expect(
          row["hidden_count"],
          `${label}: asked for the hidden ones, so the count is what is listed`,
        ).toBe(listedHidden);
      } else {
        expect(listedHidden, `${label}: a hidden model is withheld unless asked for`).toBe(0);
        expect(
          typeof row["hidden_count"],
          `${label}: and the count says how many were withheld`,
        ).toBe("number");
      }

      const active = row["active"];
      if (typeof active === "string" && active !== "" && row["include_hidden"] === true) {
        expect(
          names,
          `${label}: with nothing withheld, the active model is one of the listed ones`,
        ).toContain(active);
      }

      const roles = (row["roles"] ?? []) as { role: string; model: string | null }[];
      expect(new Set(roles.map((r) => r.role)).size, `${label}: each role answered once`).toBe(
        roles.length,
      );
      break;
    }

    case "model_info": {
      expect(row["qualified_name"], `${label}: a model is named`).toBeTruthy();
      expect(row["model_id"], `${label}: and carries the id sent on the wire`).toBeTruthy();
      expect(row["provider_key"], `${label}: and the provider it is reached through`).toBeTruthy();
      expect(row["sdk"], `${label}: and the dialect it speaks`).toBeTruthy();
      expect(
        String(row["qualified_name"]),
        `${label}: the qualified name carries the provider`,
      ).toContain(String(row["provider_key"]));
      break;
    }

    case "model_settings": {
      const schema = row["setting_schema"] as Array<Record<string, unknown>> | undefined;
      const sampler = row["effective_sampler"] as Record<string, unknown> | undefined;
      expect(schema, `${label}: every setting carries its daemon schema`).toBeDefined();
      expect(sampler, `${label}: and what it currently resolves to`).toBeDefined();

      const applicability = new Map(
        (schema ?? []).flatMap((entry) => {
          const key = entry["key"];
          const verdict = entry["applicability"];
          return typeof key === "string" && typeof verdict === "string"
            ? [[key, verdict] as const]
            : [];
        }),
      );
      for (const [field, verdict] of applicability) {
        expect(["honored", "ignored", "rejected", "always"], `${label}: ${field}`).toContain(verdict);
      }
      for (const field of Object.keys(sampler ?? {})) {
        expect(
          applicability.has(field),
          `${label}: ${field} resolves to a value, so it must say whether it applies`,
        ).toBe(true);
      }

      const scopes = row["scopes"] as string[] | undefined;
      expect(scopes, `${label}: a setting is written somewhere nameable`).toBeDefined();
      break;
    }

    case "model_roles": {
      const roles = row as unknown as { role: string; model: string | null; source: string | null }[];
      expect(Array.isArray(roles), `${label}: roles come back as a list`).toBe(true);
      const named = roles.map((r) => r.role);
      expect(new Set(named).size, `${label}: each role is answered once`).toBe(named.length);
      for (const r of roles) {
        expect(
          r.model === null ? r.source === null : typeof r.source === "string",
          `${label}: ${r.role} says where its model came from, or has none`,
        ).toBe(true);
      }
      break;
    }

    case "switch_model":
    case "reset_model":
    case "set_model_setting":
      break;

    default:
      throw new Error(`${label}: no shape stated for ${op}`);
  }
}

describe("model commands", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const ctx = await buildContext(scenario.setup);

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
          expectShapeOf(step.op, result, label);
        }

        if (step.prefs_changed !== undefined) {
          const after = flatten(readPrefs(ctx));
          for (const [path, want] of Object.entries(step.prefs_changed)) {
            expect(after[path], `${label} — ${path}`).toEqual(want as never);
          }
        }
      }
    });
  }
});

test("a hidden model stays selected without being advertised", async () => {
  const ctx = await buildContext({
    catalog: "",
    defaults: "",
    discovery: [
      {
        provider: "openrouter",
        models: [
          { model_id: "vendor/visible", visible: true },
          { model_id: "vendor/hidden", visible: false },
        ],
      },
    ] as never,
    character: "ada",
    global_prefs: null,
    character_prefs: '[selected]\nprovider = "openrouter"\nmodel_id = "vendor/hidden"\n',
    active_model: null,
  });

  const listed = listModels(ctx, {}) as {
    active: string;
    models: Record<string, { qualified_name: string }[]>;
  };
  const names = Object.values(listed.models).flat().map((m) => m.qualified_name);

  expect(listed.active, "the selection is honoured").toBe("openrouter:vendor/hidden");
  expect(names, "but a hidden model is not offered in the list").not.toContain(listed.active);

  const withHidden = listModels(ctx, { include_hidden: true }) as {
    models: Record<string, { qualified_name: string }[]>;
  };
  expect(
    Object.values(withHidden.models).flat().map((m) => m.qualified_name),
    "asking for the hidden ones shows it",
  ).toContain("openrouter:vendor/hidden");
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
  });

  expect((listModels(ctx, {}) as { active: string }).active).toBe("chat.anthropic.beta");
  expect((modelInfo(ctx, {}) as { qualified_name: string }).qualified_name).toBe(
    "chat.anthropic.beta",
  );
});

test("a thread's pin is the active model, and switching the character's does not unseat it", async () => {
  const ctx = {
    ...(await buildContext({
      catalog: '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n' +
        '[chat.anthropic.beta]\nmodel_id = "beta-id"\n',
      defaults: "",
      discovery: [],
      character: "ada",
      global_prefs: null,
      character_prefs: '[selected]\nprovider = "anthropic"\nmodel_id = "beta-id"\n',
      active_model: null,
    })),
    thread: "eval",
    threadModel: "chat.anthropic.alpha",
  };

  const listed = listModels(ctx, {}) as {
    active: string;
    roles: { role: string; model: string | null; source: string | null }[];
  };
  expect(listed.active).toBe("chat.anthropic.alpha");
  expect(listed.roles.find((r) => r.role === "chat")).toEqual({
    role: "chat",
    model: "chat.anthropic.alpha",
    source: "thread eval",
  });
  expect((modelInfo(ctx, {}) as { qualified_name: string }).qualified_name).toBe(
    "chat.anthropic.alpha",
  );
  expect(modelInfo(ctx, { background_task: "compaction" })).toMatchObject({
    qualified_name: "chat.anthropic.alpha",
  });
  expect(modelSettings(ctx, { background_task: "compaction" })).toMatchObject({
    model: "chat.anthropic.alpha", model_id: "alpha-id",
  });

  const switched = switchModel(ctx, { name: "chat.anthropic.beta" }) as Record<string, unknown>;
  expect(switched["shadowed_by_thread"]).toBe("eval");
  expect((listModels(ctx, {}) as { active: string }).active).toBe("chat.anthropic.alpha");
});

test("with no pin the character's own pick is active and no shadow is reported", async () => {
  const ctx = await buildContext({
    catalog: '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n' +
      '[chat.anthropic.beta]\nmodel_id = "beta-id"\n',
    defaults: "",
    discovery: [],
    character: "ada",
    global_prefs: null,
    character_prefs: '[selected]\nprovider = "anthropic"\nmodel_id = "beta-id"\n',
    active_model: null,
  });

  const listed = listModels(ctx, {}) as {
    active: string;
    roles: { role: string; model: string | null; source: string | null }[];
  };
  expect(listed.active).toBe("chat.anthropic.beta");
  expect(listed.roles.find((r) => r.role === "chat")?.source).toBe("character");
  expect(switchModel(ctx, { name: "chat.anthropic.alpha" })).not.toHaveProperty(
    "shadowed_by_thread",
  );
  expect((switchModel(ctx, {}) as { active: string }).active).toBe("chat.anthropic.alpha");
});

async function rolesFor(defaults: string) {
  const ctx = await buildContext({
    catalog: '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n' +
      '[chat.anthropic.beta]\nmodel_id = "beta-id"\n',
    defaults,
    discovery: [],
    character: "ada",
    global_prefs: null,
    character_prefs: '[selected]\nprovider = "anthropic"\nmodel_id = "alpha-id"\n',
    active_model: null,
  });
  const byRole = new Map(modelRoles(ctx).map((r) => [r.role, r]));
  return byRole;
}

test("every model role reports where it came from", async () => {
  const roles = await rolesFor(
    '[defaults]\nsubagent_model = "chat.anthropic.beta"\n' +
      'embedding = "some:embedder"\nimage_generation = "some:painter"\n',
  );

  expect(roles.get("sub-agents")).toEqual({
    role: "sub-agents",
    model: "chat.anthropic.beta",
    source: "defaults.subagent_model",
  });
  expect(roles.get("embedding")).toEqual({
    role: "embedding",
    model: "some:embedder",
    source: "defaults.embedding",
  });
  expect(roles.get("images")).toEqual({
    role: "images",
    model: "some:painter",
    source: "defaults.image_generation",
  });
});

test("a role nobody configured reports nothing rather than guessing", async () => {
  const roles = await rolesFor("");
  for (const role of ["embedding", "images"]) {
    expect(roles.get(role), role).toEqual({ role, model: null, source: null });
  }
});

test("background tasks name the chat model they inherit", async () => {
  const roles = await rolesFor("");
  const chat = required(roles.get("chat"));
  expect(chat.model).toBe("chat.anthropic.alpha");
  for (const task of ["heartbeat", "compaction"]) {
    expect(roles.get(task), task).toEqual({
      role: task,
      model: chat.model,
      source: "inherits chat",
    });
  }
});

test("sub-agents that pin their own model are counted, not hidden", async () => {
  const roles = await rolesFor(
    '[defaults]\nsubagent_model = "chat.anthropic.beta"\n' +
      '[subagents.plain]\ndescription = "d"\nprompt = "p"\ntools = []\n' +
      '[subagents.picky]\ndescription = "d"\nprompt = "p"\ntools = []\n' +
      'model = "chat.anthropic.alpha"\n',
  );
  expect(roles.get("sub-agents")?.source).toBe("defaults.subagent_model · 1 override");
});

describe("targeting a sub-agent's own settings", () => {
  const CATALOG =
    '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\nsdk = "anthropic"\ntemperature = 0.5\n\n' +
    '[chat.anthropic.beta]\nmodel_id = "beta-id"\nsdk = "anthropic"\ntemperature = 0.2\n';

  const DEFAULTS =
    '[defaults]\nmodel = "alpha"\n\n' +
    '[subagents.librarian]\ndescription = "looks things up"\nprompt = "you look things up"\n' +
    'model = "beta"\n\n' +
    '[subagents.sharer]\ndescription = "shares the chat model"\nprompt = "you share"\n';

  const setup = (overrides: Partial<Setup> = {}): Setup => ({
    catalog: CATALOG,
    defaults: DEFAULTS,
    discovery: [],
    character: "Tester",
    global_prefs: null,
    character_prefs: null,
    active_model: null,
    ...overrides,
  });

  const character = (ctx: ModelsContext): ModelPreferences =>
    loadPreferences(characterPreferencesPath(ctx.dataDir, ctx.characterName as string));

  test("a value lands in the sub-agent's slot, not the model's", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, { subagent: "librarian", key: "temperature", value: 0.25 });

    const prefs = character(ctx);
    expect(prefs.subagents.get("librarian")?.sampler.temperature).toBe(0.25);
    expect(prefs.models.size).toBe(0);
  });

  test("tuning the chat model leaves the sub-agent alone", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, { key: "temperature", value: 0.9 });

    const shown = modelSettings(ctx, { subagent: "sharer" }) as Record<string, unknown>;
    const sampler = shown["effective_sampler"] as Record<string, unknown>;
    expect(sampler["temperature"]).toBe(0.5);
  });

  test("tuning the sub-agent leaves the chat model alone", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, { subagent: "sharer", key: "temperature", value: 0.1 });

    const shown = modelSettings(ctx, {}) as Record<string, unknown>;
    const sampler = shown["effective_sampler"] as Record<string, unknown>;
    expect(sampler["temperature"]).toBe(0.5);
  });

  test("the shown target is the sub-agent's own model", async () => {
    const ctx = await buildContext(setup());
    const shown = modelSettings(ctx, { subagent: "librarian" }) as Record<string, unknown>;
    expect(shown["subagent"]).toBe("librarian");
    expect(shown["model_id"]).toBe("beta-id");
  });

  test("a sub-agent with no model of its own falls back to the default", async () => {
    const ctx = await buildContext(setup());
    const shown = modelSettings(ctx, { subagent: "sharer" }) as Record<string, unknown>;
    expect(shown["model_id"]).toBe("alpha-id");
  });

  test("clearing the last value drops the sub-agent's slot", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, { subagent: "librarian", key: "temperature", value: 0.25 });
    setModelSetting(ctx, { subagent: "librarian", key: "temperature", value: null });
    expect(character(ctx).subagents.size).toBe(0);
  });

  test("an unknown sub-agent is a not-found, and says which exist", async () => {
    const ctx = await buildContext(setup());
    let caught: CommandError | undefined;
    try {
      setModelSetting(ctx, { subagent: "ghost", key: "temperature", value: 0.25 });
    } catch (e) {
      caught = e as CommandError;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect(caught?.message).toContain("ghost");
    expect(caught?.message).toContain("librarian");
  });

  test("the removed Z.ai endpoint toggle points at the provider split", async () => {
    const ctx = await buildContext(setup());
    let caught: CommandError | undefined;
    try {
      setModelSetting(ctx, { key: "zai_subscription", value: true });
    } catch (e) {
      caught = e as CommandError;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect(caught?.message).toContain("select `zai-sub:<model_id>`");
  });

  test("--global writes the sub-agent slot in the global file", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, {
      subagent: "librarian",
      key: "temperature",
      value: 0.25,
      scope: "global",
    });

    const global = loadPreferences(globalPreferencesPath(ctx.dataDir));
    expect(global.subagents.get("librarian")?.sampler.temperature).toBe(0.25);
    expect(character(ctx).subagents.size).toBe(0);
  });

  test("naming a model targets it without switching the active one", async () => {
    const ctx = await buildContext(setup());
    setModelSetting(ctx, { name: "beta", key: "temperature", value: 0.15 });

    const prefs = character(ctx);
    expect(prefs.models.get("anthropic:beta-id")?.sampler.temperature).toBe(0.15);
    expect(ctx.activeModel).toBeUndefined();
    expect(prefs.selected.modelId).toBeUndefined();
  });
});

describe("targeting every sub-agent at once", () => {
  const CATALOG =
    '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\nsdk = "anthropic"\ntemperature = 0.5\n\n' +
    '[chat.anthropic.beta]\nmodel_id = "beta-id"\nsdk = "anthropic"\ntemperature = 0.2\n';

  const sharedSetup = (): Setup => ({
    catalog: CATALOG,
    defaults:
      '[defaults]\nmodel = "alpha"\nsubagent_model = "beta"\n\n' +
      '[subagents.internet]\ndescription = "d"\nprompt = "p"\n\n' +
      '[subagents.memory]\ndescription = "d"\nprompt = "p"\n\n' +
      '[subagents.music]\ndescription = "d"\nprompt = "p"\n',
    discovery: [],
    character: "Tester",
    global_prefs: null,
    character_prefs: null,
    active_model: null,
  });

  const character = (ctx: ModelsContext): ModelPreferences =>
    loadPreferences(characterPreferencesPath(ctx.dataDir, ctx.characterName as string));

  test("one write covers every sub-agent sharing the model", async () => {
    const ctx = await buildContext(sharedSetup());
    setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });

    expect(character(ctx).subagentModels.get("anthropic:beta-id")?.sampler.temperature).toBe(0.3);
    for (const name of ["internet", "memory", "music"]) {
      const shown = modelSettings(ctx, { subagent: name }) as Record<string, unknown>;
      const sampler = shown["effective_sampler"] as Record<string, unknown>;
      expect(sampler["temperature"]).toBe(0.3);
    }
  });

  test("it targets the sub-agent model, not the chat model", async () => {
    const ctx = await buildContext(sharedSetup());
    setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });

    const chat = modelSettings(ctx, {}) as Record<string, unknown>;
    expect((chat["effective_sampler"] as Record<string, unknown>)["temperature"]).toBe(0.5);
    expect(character(ctx).models.size).toBe(0);
  });

  test("a per-name setting still wins over it", async () => {
    const ctx = await buildContext(sharedSetup());
    setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });
    setModelSetting(ctx, { subagent: "music", key: "temperature", value: 0.9 });

    const music = modelSettings(ctx, { subagent: "music" }) as Record<string, unknown>;
    const memory = modelSettings(ctx, { subagent: "memory" }) as Record<string, unknown>;
    expect((music["effective_sampler"] as Record<string, unknown>)["temperature"]).toBe(0.9);
    expect((memory["effective_sampler"] as Record<string, unknown>)["temperature"]).toBe(0.3);
  });

  test("sub-agents on different models refuse `all` and name the split", async () => {
    const setup = sharedSetup();
    setup.defaults = setup.defaults.replace(
      '[subagents.music]\ndescription = "d"\nprompt = "p"\n',
      '[subagents.music]\ndescription = "d"\nprompt = "p"\nmodel = "alpha"\n',
    );
    const ctx = await buildContext(setup);

    let caught: CommandError | undefined;
    try {
      setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });
    } catch (e) {
      caught = e as CommandError;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect(caught?.message).toContain("music");
    expect(caught?.message).toContain("target one by name");
  });

  test("only the sub-agents enabled for the character are considered", async () => {
    const setup = sharedSetup();
    setup.defaults =
      setup.defaults.replace(
        '[subagents.music]\ndescription = "d"\nprompt = "p"\n',
        '[subagents.music]\ndescription = "d"\nprompt = "p"\nmodel = "alpha"\n',
      ) + '\n[tools]\nenabled_subagents = ["internet", "memory"]\n';
    const ctx = await buildContext(setup);

    setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });
    expect(character(ctx).subagentModels.get("anthropic:beta-id")?.sampler.temperature).toBe(0.3);
  });

  test("clearing the last value drops the shared slot", async () => {
    const ctx = await buildContext(sharedSetup());
    setModelSetting(ctx, { subagent: "all", key: "temperature", value: 0.3 });
    setModelSetting(ctx, { subagent: "all", key: "temperature", value: null });
    expect(character(ctx).subagentModels.size).toBe(0);
  });

  test("showing `all` reports the shared model it resolved to", async () => {
    const ctx = await buildContext(sharedSetup());
    const shown = modelSettings(ctx, { subagent: "all" }) as Record<string, unknown>;
    expect(shown["model_id"]).toBe("beta-id");
    expect(shown["subagent"]).toBe("all");
  });
});

describe("a session with no character falls back to the configured default", () => {
  const twoModels =
    '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n' +
    '[chat.anthropic.beta]\nmodel_id = "beta-id"\n';

  const characterless = (defaults: string): Setup => ({
    catalog: twoModels,
    defaults,
    discovery: [],
    character: null,
    global_prefs: null,
    character_prefs: null,
    active_model: null,
  });

  test("the default is preferred over the first catalog entry", async () => {
    const ctx = await buildContext(characterless('[defaults]\nmodel = "beta"\n'));

    expect((listModels(ctx, {}) as { active: string }).active).toBe("chat.anthropic.beta");
    expect((modelInfo(ctx, {}) as { qualified_name: string }).qualified_name).toBe(
      "chat.anthropic.beta",
    );
  });

  test("the first catalog entry answers only when no default is configured", async () => {
    const ctx = await buildContext(characterless("[defaults]\n"));

    expect((listModels(ctx, {}) as { active: string }).active).toBe("chat.anthropic.alpha");
  });

  test("a default that resolves nowhere is reported as written", async () => {
    const ctx = await buildContext(characterless('[defaults]\nmodel = "ghost"\n'));

    expect((listModels(ctx, {}) as { active: string }).active).toBe("ghost");
  });

  test("a hidden default still resolves", async () => {
    const ctx = await buildContext({
      catalog: twoModels,
      defaults: '[defaults]\nmodel = "vendor/hidden"\n',
      discovery: [
        {
          provider: "openrouter",
          models: [
            { model_id: "vendor/hidden", visible: false },
            { model_id: "vendor/shown", visible: true },
          ],
        },
      ],
      character: null,
      global_prefs: null,
      character_prefs: null,
      active_model: null,
    });

    expect((modelInfo(ctx, {}) as { qualified_name: string }).qualified_name).toBe(
      "openrouter:vendor/hidden",
    );
  });
});

describe("a discovered model's capabilities reach the settings table", () => {
  const discovered = async (): Promise<ModelsContext> =>
    await buildContext({
      catalog: '[chat.anthropic.alpha]\nmodel_id = "alpha-id"\n',
      defaults: "[defaults]\n",
      discovery: [
        {
          provider: "openrouter",
          models: [
            {
              model_id: "vendor/narrow",
              visible: true,
              supported_parameters: ["top_p"],
              effort_levels: ["low", "high"],
            },
          ],
        },
      ],
      character: "Tester",
      global_prefs: null,
      character_prefs: null,
      active_model: null,
    });

  test("supported_parameters decides which samplers are honored", async () => {
    const ctx = await discovered();
    const shown = modelSettings(ctx, { name: "vendor/narrow" }) as Record<string, unknown>;
    const schema = shown["setting_schema"] as Array<Record<string, unknown>>;
    const applicability = new Map(
      schema.flatMap((entry) => {
        const key = entry["key"];
        const verdict = entry["applicability"];
        return typeof key === "string" && typeof verdict === "string"
          ? [[key, verdict] as const]
          : [];
      }),
    );

    expect(applicability.get("top_p")).toBe("honored");
    expect(applicability.get("temperature")).toBe("rejected");
  });

  test("effort_levels narrows the reasoning effort domain", async () => {
    const ctx = await discovered();
    const shown = modelSettings(ctx, { name: "vendor/narrow" }) as Record<string, unknown>;

    const schema = shown["setting_schema"] as Array<Record<string, unknown>>;
    expect(schema.find((entry) => entry["key"] === "reasoning_effort")?.["suggestions"])
      .toEqual(["low", "high", "off"]);
  });
});

test("normal model selection pins only the thread, replaces its pin, and reset inherits", async () => {
  const ctx = await buildContext(required(scenarios[0]).setup);
  const pins: Array<string | undefined> = [];
  const persist = async (model: string | undefined) => { pins.push(model); };
  expect(await changeThreadModel(ctx, { name: "alpha" }, persist)).toMatchObject({
    qualified_name: "chat.anthropic.alpha", changed: true,
  });
  ctx.threadModel = "chat.anthropic.alpha";
  expect(await changeThreadModel(ctx, { name: "beta" }, persist)).toMatchObject({
    qualified_name: "chat.anthropic.beta", changed: true,
  });
  expect(await changeThreadModel(ctx, {}, persist, true)).toMatchObject({
    active: "chat.anthropic.beta", reset_to: "character default",
  });
  expect(pins).toEqual(["chat.anthropic.alpha", "chat.anthropic.beta", undefined]);
  expect(existsSync(characterPreferencesPath(ctx.dataDir, "Tester"))).toBe(false);
  try {
    await changeThreadModel(ctx, { name: "missing-model" }, persist);
    throw new Error("unknown model was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
  }
  expect(pins).toHaveLength(3);
});
