import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshPass, startAutoDiscovery } from "../src/daemon/auto_discovery.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { cachePath, CACHE_VERSION, writeCache } from "../src/llm/discovery.ts";

afterAll(restoreTestEnv);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function configWith(
  providers: Record<string, unknown>,
): Promise<{ config: LoadedConfig; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "shore-discovery-"));
  roots.push(root);
  return {
    cacheDir: root,
    config: {
      app: defaultAppConfig(),
      models: emptyCatalog(),
      providers: ProviderRegistry.fromSection(providers),
      dirs: { config: join(root, "config"), data: root, cache: root, runtime: join(root, "rt") },
      rawTable: undefined,
    },
  };
}

function modelsFetch(asked: string[]): typeof fetch {
  return ((url: string | URL) => {
    asked.push(url.toString());
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

describe("who gets refreshed", () => {
  test("a disabled provider, and one with discovery off, are both skipped", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const warnings: string[] = [];
    const { config } = await configWith({
      alpha: { enabled: false, api_key_env: "SHORE_DISCOVERY_TEST_KEY", discovery: { enabled: true } },
      beta: { api_key_env: "SHORE_DISCOVERY_TEST_KEY", discovery: { enabled: false } },
      gamma: { api_key_env: "SHORE_DISCOVERY_TEST_KEY" },
    });

    await refreshPass({
      config: () => config,
      fetchImpl: modelsFetch(asked),
      log: { warn: (msg) => warnings.push(msg) },
    });

    expect(asked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("an enabled provider with discovery on is fetched and cached", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config, cacheDir } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    await refreshPass({ config: () => config, fetchImpl: modelsFetch(asked) });

    expect(asked).toEqual(["https://example.test/v1/models"]);
    const written = JSON.parse(await readFile(cachePath(cacheDir, "upstream"), "utf8")) as {
      models: unknown[];
    };
    expect(written.models).toHaveLength(2);
  });
});

describe("when", () => {
  test("a cache inside its TTL is not refetched", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config, cacheDir } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });
    await writeCache(cachePath(cacheDir, "upstream"), {
      version: CACHE_VERSION,
      provider_key: "upstream",
      fetched_at: new Date().toISOString(),
      base_url: "https://example.test/v1",
      models: [],
    });

    await refreshPass({ config: () => config, fetchImpl: modelsFetch(asked) });

    expect(asked).toEqual([]);
  });

  test("a cache past its TTL is refetched", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config, cacheDir } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });
    await writeCache(cachePath(cacheDir, "upstream"), {
      version: CACHE_VERSION,
      provider_key: "upstream",
      fetched_at: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
      base_url: "https://example.test/v1",
      models: [],
    });

    await refreshPass({ config: () => config, fetchImpl: modelsFetch(asked) });

    expect(asked).toEqual(["https://example.test/v1/models"]);
  });
});

describe("what a failure costs", () => {
  test("the previous cache stands, and the next provider still gets its turn", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const { config, cacheDir } = await configWith({
      broken: {
        base_url: "https://broken.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
      working: {
        base_url: "https://working.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });
    await writeCache(cachePath(cacheDir, "broken"), {
      version: CACHE_VERSION,
      provider_key: "broken",
      fetched_at: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
      base_url: "https://broken.test/v1",
      models: [
        {
          provider_key: "broken",
          model_id: "kept",
          sdk: "openrouter",
          discovered_at: new Date().toISOString(),
        },
      ],
    });

    const warnings: string[] = [];
    await refreshPass({
      config: () => config,
      fetchImpl: ((url: string | URL) => {
        if (url.toString().includes("broken")) return Promise.reject(new Error("connection reset"));
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: "fresh" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch,
      log: { warn: (msg) => warnings.push(msg) },
    });

    expect(warnings).toEqual(["Auto-refresh failed; previous cache preserved"]);
    const kept = JSON.parse(await readFile(cachePath(cacheDir, "broken"), "utf8")) as {
      models: { model_id: string }[];
    };
    expect(kept.models.map((m) => m.model_id)).toEqual(["kept"]);
    const fresh = JSON.parse(await readFile(cachePath(cacheDir, "working"), "utf8")) as {
      models: { model_id: string }[];
    };
    expect(fresh.models.map((m) => m.model_id)).toEqual(["fresh"]);
  });

  test("a provider with no key configured is a warning, not a throw", async () => {
    delete process.env["SHORE_DISCOVERY_MISSING_KEY"];
    const { config } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_MISSING_KEY",
        discovery: { enabled: true },
      },
    });

    const warnings: string[] = [];
    await refreshPass({
      config: () => config,
      fetchImpl: (() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch,
      log: { warn: (msg) => warnings.push(msg) },
    });

    expect(warnings).toEqual(["Auto-refresh failed; previous cache preserved"]);
  });
});

describe("the loop", () => {
  test("the first pass runs at once, not one interval later", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    const loop = startAutoDiscovery({
      config: () => config,
      intervalMs: 60_000,
      fetchImpl: modelsFetch(asked),
    });
    try {
      const deadline = Date.now() + 2_000;
      while (asked.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(asked).toHaveLength(1);
    } finally {
      loop.stop();
    }
  });

  test("a pass that overruns the interval is not joined by a second", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config } = await configWith({
      slow: {
        base_url: "https://slow.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    const loop = startAutoDiscovery({
      config: () => config,
      intervalMs: 20,
      fetchImpl: (async (url: string | URL) => {
        asked.push(url.toString());
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error("still going");
      }) as unknown as typeof fetch,
      log: { warn: () => {} },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 260));
    } finally {
      loop.stop();
    }

    expect(asked.length).toBeLessThanOrEqual(4);
  });

  test("stopping ends the schedule", async () => {
    setTestEnv("SHORE_DISCOVERY_TEST_KEY", "sk-test");
    const asked: string[] = [];
    const { config, cacheDir } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    const loop = startAutoDiscovery({
      config: () => config,
      intervalMs: 30,
      fetchImpl: modelsFetch(asked),
    });
    const deadline = Date.now() + 2_000;
    while (asked.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    loop.stop();

    await writeFile(cachePath(cacheDir, "upstream"), "");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(asked).toHaveLength(1);
  });
});
