import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { favoriteModel, listModels, type ModelsContext } from "../src/commands/models.ts";
import { CommandError } from "../src/commands/errors.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { globalPreferencesPath, loadPreferences } from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { cachePath } from "../src/llm/discovery.ts";
import { testTmp } from "./support/tmp.ts";

interface Discovered {
  provider: string;
  models: { model_id: string; visible: boolean }[];
}

async function buildContext(discovery: Discovered[]): Promise<ModelsContext> {
  const root = await mkdtemp(testTmp("shore-favorites-"));
  const dirs: ShoreDirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  await mkdir(dirs.cache, { recursive: true });
  await mkdir(dirs.data, { recursive: true });

  let sectionText = "";
  for (const d of discovery) {
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
        support: {},
      })),
    };
    const path = cachePath(dirs.cache, d.provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache, null, 2));
  }

  const providers =
    sectionText === ""
      ? ProviderRegistry.empty()
      : ProviderRegistry.fromSection(Bun.TOML.parse(sectionText) as Record<string, unknown>);

  return {
    config: {
      app: defaultAppConfig(),
      models: emptyCatalog(),
      providers,
      dirs,
    } as LoadedConfig,
    dataDir: dirs.data,
    characterName: "ada",
    activeModel: undefined,
  };
}

const oneProvider = (): Discovered[] => [
  {
    provider: "nanogpt",
    models: [
      { model_id: "kimi-k3", visible: true },
      { model_id: "junk-7b", visible: false },
      { model_id: "zephyr-1", visible: true },
    ],
  },
];

interface ListedModel {
  name: string;
  qualified_name: string;
  favorite: boolean;
}

function listed(result: unknown): ListedModel[] {
  const groups = (result as { models: Record<string, ListedModel[]> }).models;
  return Object.values(groups).flat();
}

function qualified(result: unknown): string[] {
  return listed(result)
    .map((e) => e.qualified_name)
    .sort();
}

describe("favoriteModel", () => {
  test("writes the qualified name to the global preferences file", async () => {
    const ctx = await buildContext(oneProvider());
    const result = favoriteModel(ctx, { name: "kimi-k3", favorite: true }) as Record<
      string,
      unknown
    >;

    expect(result["qualified_name"]).toBe("nanogpt:kimi-k3");
    expect(result["favorite"]).toBe(true);
    expect(result["changed"]).toBe(true);

    const prefs = loadPreferences(globalPreferencesPath(ctx.dataDir));
    expect(prefs.favorites).toEqual(["nanogpt:kimi-k3"]);
  });

  test("is global, so it never touches the character's preferences", async () => {
    const ctx = await buildContext(oneProvider());
    favoriteModel(ctx, { name: "kimi-k3", favorite: true });

    const text = await readFile(globalPreferencesPath(ctx.dataDir), "utf8");
    expect(text).toContain('favorites = ["nanogpt:kimi-k3"]');
    expect(text.indexOf("favorites =")).toBeLessThan(text.indexOf("["));
  });

  test("toggles when the caller does not say which direction", async () => {
    const ctx = await buildContext(oneProvider());
    expect((favoriteModel(ctx, { name: "kimi-k3" }) as Record<string, unknown>)["favorite"]).toBe(
      true,
    );
    expect((favoriteModel(ctx, { name: "kimi-k3" }) as Record<string, unknown>)["favorite"]).toBe(
      false,
    );
    expect(loadPreferences(globalPreferencesPath(ctx.dataDir)).favorites).toEqual([]);
  });

  test("favoriting twice is not an error and writes nothing the second time", async () => {
    const ctx = await buildContext(oneProvider());
    favoriteModel(ctx, { name: "kimi-k3", favorite: true });
    const again = favoriteModel(ctx, { name: "kimi-k3", favorite: true }) as Record<
      string,
      unknown
    >;

    expect(again["favorite"]).toBe(true);
    expect(again["changed"]).toBe(false);
    expect(loadPreferences(globalPreferencesPath(ctx.dataDir)).favorites).toEqual([
      "nanogpt:kimi-k3",
    ]);
  });

  test("can favorite a model an ignore glob hides", async () => {
    const ctx = await buildContext(oneProvider());
    const result = favoriteModel(ctx, { name: "junk-7b", favorite: true }) as Record<
      string,
      unknown
    >;
    expect(result["qualified_name"]).toBe("nanogpt:junk-7b");
  });

  test("refuses a name that resolves to nothing", async () => {
    const ctx = await buildContext(oneProvider());
    expect(() => favoriteModel(ctx, { name: "no-such-model", favorite: true })).toThrow(
      CommandError,
    );
  });
});

describe("listModels with favorites", () => {
  test("marks favorites without dropping anything else", async () => {
    const ctx = await buildContext(oneProvider());
    favoriteModel(ctx, { name: "kimi-k3", favorite: true });

    const result = listModels(ctx, {});
    expect(qualified(result)).toEqual(["nanogpt:kimi-k3", "nanogpt:zephyr-1"]);

    const entries = listed(result);
    expect(entries.find((e) => e.name === "kimi-k3")?.favorite).toBe(true);
    expect(entries.find((e) => e.name === "zephyr-1")?.favorite).toBe(false);
  });

  test("surfaces a favorited model that an ignore glob would otherwise hide", async () => {
    const ctx = await buildContext(oneProvider());
    favoriteModel(ctx, { name: "junk-7b", favorite: true });

    expect(qualified(listModels(ctx, {}))).toEqual([
      "nanogpt:junk-7b",
      "nanogpt:kimi-k3",
      "nanogpt:zephyr-1",
    ]);
  });

  test("does not count a favorited model against the hidden footer", async () => {
    const ctx = await buildContext(oneProvider());
    expect((listModels(ctx, {}) as Record<string, unknown>)["hidden_count"]).toBe(1);

    favoriteModel(ctx, { name: "junk-7b", favorite: true });
    expect((listModels(ctx, {}) as Record<string, unknown>)["hidden_count"]).toBe(0);
  });

  test("favorites_only narrows to favorites", async () => {
    const ctx = await buildContext(oneProvider());
    favoriteModel(ctx, { name: "kimi-k3", favorite: true });

    const result = listModels(ctx, { favorites_only: true }) as Record<string, unknown>;
    expect(qualified(result)).toEqual(["nanogpt:kimi-k3"]);
    expect(result["favorites_only"]).toBe(true);
    expect(result["favorite_count"]).toBe(1);
  });

  test("favorites_only with nothing favorited is empty, not everything", async () => {
    const ctx = await buildContext(oneProvider());
    const result = listModels(ctx, { favorites_only: true }) as Record<string, unknown>;
    expect(listed(result)).toEqual([]);
    expect(result["favorite_count"]).toBe(0);
  });

  test("lists a favorite on a provider whose discovery is switched off", async () => {
    const ctx = await buildContext(oneProvider());
    const providers = ctx.config.providers.get("nanogpt");
    if (providers !== undefined) providers.discovery.enabled = false;

    const path = globalPreferencesPath(ctx.dataDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'favorites = ["nanogpt:kimi-k3"]\n');

    const result = listModels(ctx, {});
    expect(qualified(result)).toEqual(["nanogpt:kimi-k3"]);
    expect(listed(result)[0]?.favorite).toBe(true);
  });

  test("a favorite that resolves nowhere at all is dropped, not surfaced as a ghost", async () => {
    const ctx = await buildContext(oneProvider());
    const path = globalPreferencesPath(ctx.dataDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'favorites = ["no-such-provider:gone-forever"]\n');

    const result = listModels(ctx, {}) as Record<string, unknown>;
    expect(qualified(result)).toEqual(["nanogpt:kimi-k3", "nanogpt:zephyr-1"]);
    expect(result["favorite_count"]).toBe(1);
  });
});
