import { required } from "../src/util/required.ts";

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { catalogFromSections, emptyCatalog } from "../src/config/models.ts";
import {
  configView,
  resolveActiveModelAndOverlay,
  resolveChatModelForCharacter,
} from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { resolveGenerationModel } from "../src/handler/setup.ts";

const CHARACTER = "ashe";

const CATALOG = `
["anthropic:claude-opus-4-6"]
temperature = 0.3
max_output_tokens = 8000

["anthropic:claude-sonnet-4-6"]`;

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface World {
  config: LoadedConfig;
  globalPrefs(toml: string): void;
  charPrefs(toml: string): void;
}

function world(opts: { catalog?: string; defaultModel?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "active-model-"));
  roots.push(root);
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  mkdirSync(dirs.cache, { recursive: true });
  mkdirSync(join(dirs.data, CHARACTER), { recursive: true });

  const app = defaultAppConfig();
  if (opts.defaultModel !== undefined) app.defaults.model = opts.defaultModel;
  const chat = opts.catalog ?? CATALOG;

  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  return {
    config: {
      app,
      models:
        chat === ""
          ? emptyCatalog()
          : catalogFromSections(Bun.TOML.parse(chat) as Record<string, unknown>, undefined, undefined),
      providers: ProviderRegistry.empty(),
      dirs,
      rawTable: undefined,
    },
    globalPrefs: (toml) => write(join(dirs.data, "preferences", "models.toml"), toml),
    charPrefs: (toml) =>
      write(join(dirs.data, CHARACTER, "preferences", "models.toml"), toml),
  };
}

function resolve(w: World) {
  return resolveActiveModelAndOverlay(configView(w.config), CHARACTER, findEffectiveModel);
}

const selects = (provider: string, modelId: string) =>
  `[selected]\nprovider = ${JSON.stringify(provider)}\nmodel_id = ${JSON.stringify(modelId)}\n`;

describe("a thread's pin", () => {
  test("a provider pair resolves as a saved selection of it does, past the effective catalog", () => {
    const w = world({ catalog: '["openrouter:anthropic/claude-opus-4-6"]\n\n["anthropic:claude-sonnet-4-6"]', defaultModel: "anthropic:claude-sonnet-4-6" });
    w.config.providers = ProviderRegistry.fromSection({ openrouter: { enabled: false } });
    const pinned = "openrouter:anthropic/claude-opus-4-6";

    const viaPin = resolveChatModelForCharacter(configView(w.config), CHARACTER, findEffectiveModel, pinned);
    w.charPrefs(selects("openrouter", "anthropic/claude-opus-4-6"));
    const viaSelection = resolveChatModelForCharacter(configView(w.config), CHARACTER, findEffectiveModel);

    expect(viaPin?.qualifiedName).toBe(pinned);
    expect(viaSelection?.qualifiedName).toBe(pinned);
  });
});

describe("which model", () => {
  test("a character selection wins", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.charPrefs(selects("anthropic", "claude-sonnet-4-6"));

    expect(resolve(w).model?.name).toBe("claude-sonnet-4-6");
  });

  test("a global selection is used when the character has none", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.globalPrefs(selects("anthropic", "claude-sonnet-4-6"));

    expect(resolve(w).model?.name).toBe("claude-sonnet-4-6");
  });

  test("the character's selection outranks the global one", () => {
    const w = world();
    w.globalPrefs(selects("anthropic", "claude-sonnet-4-6"));
    w.charPrefs(selects("anthropic", "claude-opus-4-6"));

    expect(resolve(w).model?.name).toBe("claude-opus-4-6");
  });

  test("the configured default is next", () => {
    const w = world({ defaultModel: "claude-sonnet-4-6" });

    expect(resolve(w).model?.name).toBe("claude-sonnet-4-6");
  });

  test("and the first chat model last", () => {
    const w = world();

    expect(resolve(w).model?.name).toBe("claude-opus-4-6");
  });

  test("an empty catalog resolves to no model and no overlay", () => {
    const w = world({ catalog: "" });
    expect(resolve(w)).toEqual({ model: undefined, overlay: {} });
  });

  test("unreadable preferences warn and resolve on empty defaults", () => {
    const w = world({ defaultModel: "claude-sonnet-4-6" });
    w.charPrefs("this is not toml = = =");

    expect(resolve(w).model?.name).toBe("claude-sonnet-4-6");
  });
});

describe("the overlay", () => {
  test("is empty when preferences set nothing", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });

    expect(resolve(w).overlay).toEqual({});
  });

  test("carries what preferences set", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.charPrefs("[defaults.sampler]\ntemperature = 0.9\nmax_tool_rounds = 4\n");

    expect(resolve(w).overlay).toEqual({ temperature: 0.9, maxToolIterations: 4 });
  });

  test("layers global under character, as everywhere else", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.globalPrefs("[defaults.sampler]\ntemperature = 0.1\nmax_output_tokens = 2000\n");
    w.charPrefs("[defaults.sampler]\ntemperature = 0.9\n");

    expect(resolve(w).overlay).toEqual({ temperature: 0.9, maxOutputTokens: 2000 });
  });

  test("is keyed by the resolved model, not by some other one", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.charPrefs(
      '[models."anthropic:claude-opus-4-6"]\ntemperature = 0.9\n\n' +
        '[models."claude-opus-4-6:anthropic"]\ntemperature = 0.1\n',
    );

    expect(resolve(w).overlay).toEqual({ temperature: 0.9 });
  });

  test("a model-scoped preference outranks the defaults", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.globalPrefs('[models."anthropic:claude-opus-4-6"]\nmax_output_tokens = 2000\n');
    w.charPrefs("[defaults.sampler]\nmax_output_tokens = 100\ntemperature = 0.9\n");

    expect(resolve(w).overlay).toEqual({ maxOutputTokens: 2000, temperature: 0.9 });
  });

  test("leaves the catalog's own settings out of it", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });
    w.charPrefs("[defaults.sampler]\nmax_tool_rounds = 4\n");

    const { model, overlay } = resolve(w);
    expect(model?.temperature).toBe(0.3);
    expect(overlay).toEqual({ maxToolIterations: 4 });
  });

  test("an empty overlay leaves the catalog entry itself as the request's model", () => {
    const w = world({ defaultModel: "claude-opus-4-6" });

    const { model, overlay } = resolve(w);
    expect(resolveGenerationModel(model, w.config, overlay)).toBe(required(model));
  });
});

describe("the split does not change the answer", () => {
  const cases: Array<[string, (w: World) => void]> = [
    ["no preferences at all", () => {}],
    ["a selection", (w) => w.charPrefs(selects("anthropic", "claude-sonnet-4-6"))],
    ["a sampler overlay", (w) => w.charPrefs("[defaults.sampler]\ntemperature = 0.9\n")],
    [
      "an overlay on a model that has settings of its own",
      (w) => {
        w.charPrefs(
          `${selects("anthropic", "claude-opus-4-6")}
[defaults.sampler]
max_tool_rounds = 4
`,
        );
      },
    ],
    [
      "both layers, one overriding the catalog",
      (w) => {
        w.globalPrefs("[defaults.sampler]\nmax_output_tokens = 2000\n");
        w.charPrefs("[defaults.sampler]\ntemperature = 0.9\n");
      },
    ],
  ];

  for (const [name, setup] of cases) {
    test(name, () => {
      const w = world({ defaultModel: "claude-opus-4-6" });
      setup(w);

      const { model, overlay } = resolve(w);
      const merged = resolveChatModelForCharacter(
        configView(w.config),
        CHARACTER,
        findEffectiveModel,
      );

      expect(resolveGenerationModel(model, w.config, overlay)).toEqual(required(merged));
    });
  }
});
