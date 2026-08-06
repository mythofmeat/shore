/**
 * The provider auto-discovery loop.
 *
 * `refreshOne` is tested where it lives; what is left for here is the loop's
 * three decisions, each of which is silent when it is wrong:
 *
 * - **Who.** Enabled *and* `discovery.enabled`. Discovery is off unless asked
 *   for, so a loop that ignored either flag would make unrequested outbound
 *   requests on the user's credentials.
 * - **When.** A cache inside its TTL is left alone. Without that check a
 *   daemon that restarts often makes one request per provider per restart and
 *   gains nothing.
 * - **What a failure costs.** Nothing. The previous cache stands, and the other
 *   providers still get their turn — which is the difference between a
 *   transient outage at one provider and a daemon with no model lists.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshPass, startAutoDiscovery } from "../src/daemon/auto_discovery.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { cachePath, CACHE_VERSION, writeCache } from "../src/llm/discovery.ts";

/** A config whose `[providers]` section is the given table. */
async function configWith(
  providers: Record<string, unknown>,
): Promise<{ config: LoadedConfig; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "shore-discovery-"));
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

/** A `/v1/models` responder that counts what it was asked for. */
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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

    // `gamma` has no `[discovery]` block at all, which leaves it off — an
    // omitted block is not an opt-in.
    expect(asked).toEqual([]);
    // Skipped, not attempted-and-refused. `refreshOne` would reject each of
    // these on its own, so without the check here the only symptom would be a
    // warning per provider per pass — forever, about a state the user chose.
    expect(warnings).toEqual([]);
  });

  test("an enabled provider with discovery on is fetched and cached", async () => {
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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

    // A transient outage at one provider must not stop the others, and must
    // not lose what was already known about the one that failed.
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
    const asked: string[] = [];
    const { config } = await configWith({
      upstream: {
        base_url: "https://example.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    // An interval no test could wait for, so only the boot pass can fire. A
    // daemon restarted after a long gap should not wait a day for a list it
    // already knows is stale.
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
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
    const asked: string[] = [];
    const { config } = await configWith({
      slow: {
        base_url: "https://slow.test/v1",
        api_key_env: "SHORE_DISCOVERY_TEST_KEY",
        discovery: { enabled: true },
      },
    });

    // Fails slowly, so nothing is ever cached and every tick is eligible.
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

    // Serialized, so roughly one per 100ms rather than one per 20ms. Two
    // concurrent passes would both fetch and both write the same cache file.
    expect(asked.length).toBeLessThanOrEqual(4);
  });

  test("stopping ends the schedule", async () => {
    process.env["SHORE_DISCOVERY_TEST_KEY"] = "sk-test";
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

    // The boot pass wrote a fresh cache, which later ticks would skip; break it
    // so a tick that still ran would be visible.
    await writeFile(cachePath(cacheDir, "upstream"), "");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(asked).toHaveLength(1);
  });
});
