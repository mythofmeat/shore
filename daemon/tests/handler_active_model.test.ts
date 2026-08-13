/**
 * `resolveActiveModelAndOverlay`: the model a chat turn runs on, and the
 * sampler overlay kept beside it rather than folded in.
 *
 * Ported from `resolve_active_model_and_overlay` in
 * `the deleted port`, which had no Rust test of its own — it
 * was only ever reached through a live `MessageHandler`.
 *
 * **Not fixture-derived, and it does not need to be.** Every step of the chain
 * it runs is already pinned by the frozen `preferences.json`
 * (`resolveActiveForCharacter`, `resolveSamplerSettings`,
 * `applySamplerOverlay`) and by `setup.json` (`resolveGenerationModel`).
 * What is unpinned is the composition: which preferences feed the chain, where
 * the legacy file is read from, and the one argument that makes this function
 * different from {@link resolveChatModelForCharacter}. So that is what is
 * asserted here.
 *
 * The last section is the one that matters most: the split into
 * `(model, overlay)` must not change the model a request ends up with. It is
 * checked by running both variants over the same preferences and demanding the
 * same answer.
 */

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

/** Two models, one of which carries sampler values of its own — which is what
 *  makes "the catalog's settings stay out of the overlay" observable. */
const CATALOG = `
[anthropic.opus]
model_id = "claude-opus-4-6"
temperature = 0.3
max_output_tokens = 8000

[anthropic.sonnet]
model_id = "claude-sonnet-4-6"
`;

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface World {
  config: LoadedConfig;
  /** Write `<data>/preferences/models.toml`. */
  globalPrefs(toml: string): void;
  /** Write `<data>/<character>/preferences/models.toml`. */
  charPrefs(toml: string): void;
  /** Write the legacy `<data>/<character>/runtime_state.json`. */
  legacy(model: string): void;
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
    legacy: (model) =>
      write(join(dirs.data, CHARACTER, "runtime_state.json"), `{"active_model": ${JSON.stringify(model)}}`),
  };
}

function resolve(w: World) {
  return resolveActiveModelAndOverlay(configView(w.config), CHARACTER, findEffectiveModel);
}

const selects = (provider: string, modelId: string) =>
  `[selected]\nprovider = ${JSON.stringify(provider)}\nmodel_id = ${JSON.stringify(modelId)}\n`;

describe("which model", () => {
  test("a character selection wins", () => {
    const w = world({ defaultModel: "opus" });
    w.charPrefs(selects("anthropic", "claude-sonnet-4-6"));

    expect(resolve(w).model?.name).toBe("sonnet");
  });

  test("a global selection is used when the character has none", () => {
    const w = world({ defaultModel: "opus" });
    w.globalPrefs(selects("anthropic", "claude-sonnet-4-6"));

    expect(resolve(w).model?.name).toBe("sonnet");
  });

  test("the character's selection outranks the global one", () => {
    const w = world();
    w.globalPrefs(selects("anthropic", "claude-sonnet-4-6"));
    w.charPrefs(selects("anthropic", "claude-opus-4-6"));

    expect(resolve(w).model?.name).toBe("opus");
  });

  test("the legacy runtime_state file is still read, from the character's own directory", () => {
    // Preferences superseded it; it stays as a migration fallback for installs
    // that have not written preferences yet.
    const w = world({ defaultModel: "opus" });
    w.legacy("sonnet");

    expect(resolve(w).model?.name).toBe("sonnet");
  });

  test("the configured default is next", () => {
    const w = world({ defaultModel: "sonnet" });

    expect(resolve(w).model?.name).toBe("sonnet");
  });

  test("and the first chat model last", () => {
    const w = world();

    expect(resolve(w).model?.name).toBe("opus");
  });

  test("an empty catalog resolves to no model and no overlay", () => {
    const w = world({ catalog: "" });
    // Not an error here: `resolveGenerationModel` is what decides whether a
    // turn without a model can proceed, and it has its own fallbacks.
    expect(resolve(w)).toEqual({ model: undefined, overlay: {} });
  });

  test("unreadable preferences warn and resolve on empty defaults", () => {
    const w = world({ defaultModel: "sonnet" });
    w.charPrefs("this is not toml = = =");

    // A file that only holds overrides must not take the character's chat down.
    expect(resolve(w).model?.name).toBe("sonnet");
  });
});

describe("the overlay", () => {
  test("is empty when preferences set nothing", () => {
    const w = world({ defaultModel: "opus" });

    expect(resolve(w).overlay).toEqual({});
  });

  test("carries what preferences set", () => {
    const w = world({ defaultModel: "opus" });
    w.charPrefs("[defaults.sampler]\ntemperature = 0.9\nmax_tool_iterations = 4\n");

    expect(resolve(w).overlay).toEqual({ temperature: 0.9, maxToolIterations: 4 });
  });

  test("layers global under character, as everywhere else", () => {
    const w = world({ defaultModel: "opus" });
    w.globalPrefs("[defaults.sampler]\ntemperature = 0.1\nmax_output_tokens = 2000\n");
    w.charPrefs("[defaults.sampler]\ntemperature = 0.9\n");

    expect(resolve(w).overlay).toEqual({ temperature: 0.9, maxOutputTokens: 2000 });
  });

  test("is keyed by the resolved model, not by some other one", () => {
    const w = world({ defaultModel: "opus" });
    w.charPrefs(
      '[models."anthropic:claude-opus-4-6"]\ntemperature = 0.9\n\n' +
        '[models."claude-opus-4-6:anthropic"]\ntemperature = 0.1\n',
    );

    expect(resolve(w).overlay).toEqual({ temperature: 0.9 });
  });

  test("a model-scoped preference outranks the defaults", () => {
    const w = world({ defaultModel: "opus" });
    w.globalPrefs('[models."anthropic:claude-opus-4-6"]\nmax_output_tokens = 2000\n');
    w.charPrefs("[defaults.sampler]\nmax_output_tokens = 100\ntemperature = 0.9\n");

    expect(resolve(w).overlay).toEqual({ maxOutputTokens: 2000, temperature: 0.9 });
  });

  test("leaves the catalog's own settings out of it", () => {
    // The load-bearing difference from `resolveChatModelForCharacter`, which
    // passes the resolved model as the static default and so gets an overlay
    // holding the catalog's `temperature`, `max_output_tokens` and `sdk` too.
    // Those change no field — they are the model's own values, at the lowest
    // layer, going back onto the model — but they would make the overlay
    // permanently non-empty, and emptiness is what the next test is about.
    const w = world({ defaultModel: "opus" });
    w.charPrefs("[defaults.sampler]\nmax_tool_iterations = 4\n");

    const { model, overlay } = resolve(w);
    expect(model?.temperature).toBe(0.3);
    expect(overlay).toEqual({ maxToolIterations: 4 });
  });

  test("an empty overlay leaves the catalog entry itself as the request's model", () => {
    // `resolveGenerationModel` skips the patch when nothing is set, so the
    // model a request runs on is the catalog's own object. This is the reason
    // the static default is left out: `samplerFromResolvedModel` always
    // contributes `sdk`, so folding it in would make the overlay non-empty
    // every time, and every turn would copy the entry for nothing.
    const w = world({ defaultModel: "opus" });

    const { model, overlay } = resolve(w);
    expect(resolveGenerationModel(model, w.config, overlay)).toBe(model!);
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
          `${selects("anthropic", "claude-opus-4-6")}\n[defaults.sampler]\nmax_tool_iterations = 4\n`,
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
      const w = world({ defaultModel: "opus" });
      setup(w);

      const { model, overlay } = resolve(w);
      // The heartbeat's variant of the same chain, which merges instead of
      // splitting. Both must land on the same model, or the cold rebuild it
      // exists for would miss chat's cache prefix.
      const merged = resolveChatModelForCharacter(
        configView(w.config),
        CHARACTER,
        findEffectiveModel,
      );

      expect(resolveGenerationModel(model, w.config, overlay)).toEqual(merged!);
    });
  }
});
