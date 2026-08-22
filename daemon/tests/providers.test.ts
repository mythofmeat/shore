import { required } from "../src/util/required.ts";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fixture from "./command_captures/providers.json" with { type: "json" };

import { CommandError } from "../src/commands/errors.ts";
import {
  listProviderModels,
  listProviders,
  refreshAllProviderModels,
  refreshProviderModels,
  type ProvidersContext,
} from "../src/commands/providers.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { catalogFromSections, emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { cachePath } from "../src/llm/discovery.ts";
import { testTmp } from "./support/tmp.ts";

interface WireError {
  code: string;
  message: string;
}

interface Row {
  name: string;
  note?: string;
  ok?: unknown;
  err?: WireError;
  caches_after?: Record<string, unknown>;
  listed_after?: unknown;
}

const env = fixture.env as unknown as Record<string, string | null>;

const OPENAI_BODY = JSON.stringify({
  data: [
    { id: "vendor/one", owned_by: "vendor" },
    { id: "vendor/two", owned_by: "vendor" },
  ],
});
const ANTHROPIC_BODY = JSON.stringify({
  data: [{ id: "claude-fixture-1", display_name: "Claude Fixture 1" }],
});

function upstream(
  kind: "openai" | "anthropic" | "broken",
  requiredKey?: string,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    if (!url.includes("<upstream>") && !url.includes("<broken-upstream>")) {
      return new Response(JSON.stringify({ error: "wrong base url" }), { status: 502 });
    }
    if (requiredKey !== undefined) {
      const headers = JSON.stringify(init?.headers ?? {});
      if (!headers.includes(requiredKey.toLowerCase())) {
        return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
      }
    }
    if (kind === "broken") {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(kind === "anthropic" ? ANTHROPIC_BODY : OPENAI_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function byProviderGuarded(
  map: Record<string, "openai" | "anthropic" | "broken">,
  requiredKey: string,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    for (const [marker, kind] of Object.entries(map)) {
      if (url.includes(marker)) return await upstream(kind)(url, init);
    }
    return await upstream("openai", requiredKey)(url, init);
  }) as typeof fetch;
}

interface World {
  ctx: ProvidersContext;
  cacheDir: string;
}

async function build(
  providersToml: string,
  catalogToml: string,
  caches: [string, unknown][],
  fetchImpl?: typeof fetch,
): Promise<World> {
  const root = await mkdtemp(testTmp("shore-providers-"));
  const dirs: ShoreDirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  await mkdir(dirs.cache, { recursive: true });
  await mkdir(dirs.data, { recursive: true });

  const models =
    catalogToml === ""
      ? emptyCatalog()
      : catalogFromSections(
          (Bun.TOML.parse(catalogToml) as Record<string, unknown>)["chat"] as Record<
            string,
            unknown
          >,
          undefined,
          undefined,
        );
  const providers =
    providersToml === ""
      ? ProviderRegistry.empty()
      : ProviderRegistry.fromSection(Bun.TOML.parse(providersToml) as Record<string, unknown>);

  for (const [provider, cache] of caches) {
    const path = cachePath(dirs.cache, provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache, null, 2));
  }

  const config = { app: defaultAppConfig(), models, providers, dirs } as LoadedConfig;
  return { ctx: { config, ...(fetchImpl === undefined ? {} : { fetchImpl }) }, cacheDir: dirs.cache };
}

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?\+00:00$/;

function scrub(value: unknown, cacheDir: string, stamps: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, cacheDir, stamps));
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? value.replaceAll(cacheDir, "<cache>") : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "fetched_at" || key === "discovered_at") &&
      typeof v === "string" &&
      v.startsWith("202")
    ) {
      stamps.push(v);
      out[key] = "<utc-now>";
    } else {
      out[key] = scrub(v, cacheDir, stamps);
    }
  }
  return out;
}

async function readCaches(cacheDir: string, providers: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const provider of providers) {
    const file = Bun.file(cachePath(cacheDir, provider));
    out[provider] = (await file.exists()) ? await file.json() : null;
  }
  return out;
}

async function check(row: Row, world: World, run: () => unknown): Promise<void> {
  const stamps: string[] = [];
  let result: unknown;
  let thrown: unknown;
  try {
    result = await run();
  } catch (e) {
    thrown = e;
  }

  if (row.err !== undefined) {
    expect(thrown, row.name).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code, row.name).toBe(row.err.code as never);
    expect((thrown as CommandError).message, row.name).toBe(row.err.message);
  } else {
    expect(thrown, row.name).toBeUndefined();
    expect(scrub(result, world.cacheDir, stamps), row.name).toEqual(row.ok as never);
  }

  if (row.caches_after !== undefined) {
    const providers = Object.keys(row.caches_after);
    const actual = await readCaches(world.cacheDir, providers);
    expect(scrub(actual, world.cacheDir, stamps), `${row.name} — caches`).toEqual(
      row.caches_after as never,
    );
  }

  for (const stamp of stamps) expect(stamp, `${row.name} — timestamp shape`).toMatch(UTC_RE);
}

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const KEY_SET = "SHORE_FIXTURE_KEY_SET";
const KEY_BLANK = "SHORE_FIXTURE_KEY_BLANK";
const KEY_UNSET = "SHORE_FIXTURE_KEY_UNSET";
const KEY_SECOND = "SHORE_FIXTURE_KEY_SECOND";

const RICH_PROVIDERS = `
[alpha]
sdk = "anthropic"
base_url = "https://alpha.example"
api_key_env = "${KEY_SET}"

[beta]
enabled = false
api_key_env = "${KEY_UNSET}"

[beta.discovery]
enabled = false

[gamma]
[[gamma.keys]]
name = "primary"
env = "${KEY_SET}"
warn_on_fallback = true
[[gamma.keys]]
name = "spare"
env = "${KEY_UNSET}"
enabled = false
[[gamma.keys]]
name = "blank"
env = "${KEY_BLANK}"
[gamma.discovery]
enabled = true
ignore = ["vendor/two"]
`;

const CATALOG = `
[chat.alpha.one]
model_id = "static-one"
sdk = "anthropic"
max_output_tokens = 1024

[chat.other.two]
model_id = "static-two"
sdk = "openai"

[chat.alpha.shadowed]
model_id = "vendor/two"
sdk = "anthropic"
`;

const REFRESH_GUARDS = `
[disabled]
enabled = false
api_key_env = "${KEY_SET}"

[nodiscovery]
api_key_env = "${KEY_SET}"
[nodiscovery.discovery]
enabled = false

[nourl]
api_key_env = "${KEY_SET}"
[nourl.discovery]
enabled = true

[nokey]
base_url = "https://nokey.example"
api_key_env = "${KEY_UNSET}"
[nokey.discovery]
enabled = true

[blankkey]
base_url = "https://blank.example"
api_key_env = "${KEY_BLANK}"
[blankkey.discovery]
enabled = true

[anthropic]
api_key_env = "${KEY_UNSET}"
[anthropic.discovery]
enabled = true
`;

function cacheJson(provider: string, models: [string, string][]): unknown {
  return {
    version: 1,
    provider_key: provider,
    fetched_at: "1999-01-01T00:00:00Z",
    base_url: null,
    models: models.map(([id, owner]) => ({
      provider_key: provider,
      model_id: id,
      display_name: null,
      sdk: "openai",
      owned_by: owner,
      context_length: 128_000,
      max_output_tokens: 4096,
      supports_tools: true,
      supports_images: false,
      supports_reasoning: null,
      supports_prompt_cache: null,
      discovered_at: "1999-01-01T00:00:00Z",
    })),
  };
}

const row = (section: keyof typeof fixture, name: string): Row =>
  required((fixture[section] as unknown as Row[]).find((r) => r.name === name));

describe("listProviders", () => {
  test("no providers configured", async () => {
    const world = await build("", "", []);
    await check(row("list_providers", "no providers configured"), world, () =>
      listProviders(world.ctx),
    );
  });

  test("keys, env probes, ignore rules and a cache", async () => {
    const world = await build(RICH_PROVIDERS, "", [
      ["gamma", cacheJson("gamma", [["vendor/one", "v"], ["vendor/two", "v"], ["vendor/three", "v"]])],
    ]);
    await check(
      row("list_providers", "keys, env probes, ignore rules and a cache"),
      world,
      () => listProviders(world.ctx),
    );
  });

  test("an unreadable cache file reads as absent", async () => {
    const world = await build(`[alpha]\napi_key_env = "${KEY_SET}"\n`, "", [
      ["alpha", { not: "a cache" }],
    ]);
    await check(
      row("list_providers", "an unreadable cache file reads as absent"),
      world,
      () => listProviders(world.ctx),
    );
  });
});

describe("listProviderModels", () => {
  const withCache = async (): Promise<World> =>
    await build(
      `[alpha]\napi_key_env = "${KEY_SET}"\n[alpha.discovery]\nenabled = true\nignore = ["vendor/two"]\n`,
      CATALOG,
      [
        ["alpha", cacheJson("alpha", [["vendor/one", "v"], ["vendor/two", "v"]])],
        ["other", cacheJson("other", [["other/one", "v"]])],
      ],
    );

  const cases: [string, Record<string, unknown>][] = [
    ["discovered plus static, hidden split out", { provider: "alpha" }],
    ["include_hidden folds the ignored model back in", { provider: "alpha", include_hidden: true }],
    ["missing provider argument", {}],
    ["empty provider argument", { provider: "" }],
    ["a provider known only through a static entry", { provider: "other" }],
    ["a truthy-but-not-true include_hidden", { provider: "alpha", include_hidden: 1 }],
    ["a stringly include_hidden", { provider: "alpha", include_hidden: "true" }],
    ["a provider nothing references", { provider: "ghost" }],
  ];

  for (const [name, args] of cases) {
    test(name, async () => {
      const world = await withCache();
      await check(row("list_provider_models", name), world, () =>
        listProviderModels(world.ctx, args),
      );
    });
  }

  test("no cache at all, static entries still returned", async () => {
    const world = await build(`[alpha]\napi_key_env = "${KEY_SET}"\n`, CATALOG, []);
    await check(
      row("list_provider_models", "no cache at all, static entries still returned"),
      world,
      () => listProviderModels(world.ctx, { provider: "alpha" }),
    );
  });
});

describe("refreshProviderModels guards", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["missing provider argument", {}],
    ["a provider that is not configured", { provider: "ghost" }],
    ["a disabled provider", { provider: "disabled" }],
    ["discovery switched off", { provider: "nodiscovery" }],
    ["no base_url and no built-in default", { provider: "nourl" }],
    ["no key whose env var is set", { provider: "nokey" }],
    ["a key whose env var holds only whitespace", { provider: "blankkey" }],
    ["a provider with a built-in base url and no configured one", { provider: "anthropic" }],
  ];

  for (const [name, args] of cases) {
    test(name, async () => {
      const world = await build(REFRESH_GUARDS, "", [], upstream("openai"));
      await check(row("refresh_provider_models", name), world, async () =>
        await refreshProviderModels(world.ctx, args),
      );
    });
  }
});

describe("refreshProviderModels over the wire", () => {
  test("a successful refresh writes the cache", async () => {
    const world = await build(
      `[alpha]\nbase_url = "<upstream>"\n` +
        `[[alpha.keys]]\nname = "first"\nenv = "${KEY_UNSET}"\n` +
        `[[alpha.keys]]\nname = "second"\nenv = "${KEY_SECOND}"\n` +
        `[alpha.discovery]\nenabled = true\nignore = ["vendor/two"]\n`,
      "",
      [],
      upstream("openai", "sk-second"),
    );
    const r = row("refresh_provider_models", "a successful refresh writes the cache");
    await check(r, world, async () => await refreshProviderModels(world.ctx, { provider: "alpha" }));

    const stamps: string[] = [];
    expect(
      scrub(listProviderModels(world.ctx, { provider: "alpha" }), world.cacheDir, stamps),
      "listed after refresh",
    ).toEqual(r.listed_after as never);
  });

  test("the first usable key is used, not the last", async () => {
    const world = await build(
      `[twokeys]\nbase_url = "<upstream>"\n` +
        `[[twokeys.keys]]\nname = "first"\nenv = "${KEY_SECOND}"\n` +
        `[[twokeys.keys]]\nname = "second"\nenv = "${KEY_SET}"\n` +
        `[twokeys.discovery]\nenabled = true\n`,
      "",
      [],
      upstream("openai", "sk-second"),
    );
    await check(
      row("refresh_provider_models", "the first usable key is used, not the last"),
      world,
      async () => await refreshProviderModels(world.ctx, { provider: "twokeys" }),
    );
  });

  test("a provider whose sdk comes from its built-in default", async () => {
    const world = await build(
      `[anthropic]\nbase_url = "<upstream>"\napi_key_env = "${KEY_SET}"\n` +
        `[anthropic.discovery]\nenabled = true\n`,
      "",
      [],
      upstream("anthropic", "x-api-key"),
    );
    await check(
      row("refresh_provider_models", "a provider whose sdk comes from its built-in default"),
      world,
      async () => await refreshProviderModels(world.ctx, { provider: "anthropic" }),
    );
  });

  test("a disabled key holding a usable value is skipped", async () => {
    const world = await build(
      `[disabledkey]\nbase_url = "<upstream>"\n` +
        `[[disabledkey.keys]]\nname = "skipped"\nenv = "${KEY_SET}"\nenabled = false\n` +
        `[[disabledkey.keys]]\nname = "used"\nenv = "${KEY_SECOND}"\n` +
        `[disabledkey.discovery]\nenabled = true\n`,
      "",
      [],
      upstream("openai", "sk-second"),
    );
    await check(
      row("refresh_provider_models", "a disabled key holding a usable value is skipped"),
      world,
      async () => await refreshProviderModels(world.ctx, { provider: "disabledkey" }),
    );
  });

  test("the anthropic sdk takes a different endpoint and auth header", async () => {
    const world = await build(
      `[anth]\nsdk = "anthropic"\nbase_url = "<upstream>"\n` +
        `api_key_env = "${KEY_SET}"\n[anth.discovery]\nenabled = true\n`,
      "",
      [],
      upstream("anthropic"),
    );
    await check(
      row("refresh_provider_models", "the anthropic sdk takes a different endpoint and auth header"),
      world,
      async () => await refreshProviderModels(world.ctx, { provider: "anth" }),
    );
  });

  test("a failing upstream preserves the previous cache", async () => {
    const world = await build(
      `[alpha]\nbase_url = "<upstream>"\napi_key_env = "${KEY_SET}"\n` +
        `[alpha.discovery]\nenabled = true\n`,
      "",
      [["alpha", cacheJson("alpha", [["previous/model", "v"]])]],
      upstream("broken"),
    );
    await check(
      row("refresh_provider_models", "a failing upstream preserves the previous cache"),
      world,
      async () => await refreshProviderModels(world.ctx, { provider: "alpha" }),
    );
  });
});

test("refreshAllProviderModels: one succeeds, one fails, two are skipped", async () => {
  const world = await build(
    `[good]\nbase_url = "<upstream>"\napi_key_env = "${KEY_SECOND}"\n` +
      `[good.discovery]\nenabled = true\n` +
      `[broken]\nbase_url = "<broken-upstream>"\napi_key_env = "${KEY_SET}"\n` +
      `[broken.discovery]\nenabled = true\n` +
      `[off]\nenabled = false\napi_key_env = "${KEY_SET}"\n` +
      `[nodisc]\nbase_url = "<upstream>"\napi_key_env = "${KEY_SET}"\n` +
      `[nodisc.discovery]\nenabled = false\n`,
    "",
    [],
    byProviderGuarded({ "<broken-upstream>": "broken" }, "sk-second"),
  );
  await check(
    row("refresh_all_provider_models", "one succeeds, one fails, two are skipped"),
    world,
    async () => await refreshAllProviderModels(world.ctx),
  );
});
