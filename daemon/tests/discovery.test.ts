import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CACHE_VERSION,
  REFRESH_INTERVAL_MS,
  buildAnthropicModelsUrl,
  buildModelsUrl,
  cacheAgeMs,
  cachePath,
  discoverAnthropic,
  discoverOpenAiCompatible,
  effectiveModelSdk,
  isStale,
  mapEntry,
  parseModelsResponse,
  readCache,
  serializeCache,
  truncateForLog,
  writeCache,
  type DiscoveredModel,
  type ProviderModelsCache,
} from "../src/llm/discovery";
import { requestUrl } from "./support/fetch.ts";
import { testTmp } from "./support/tmp.ts";

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");
const scratch = () => mkdtemp(testTmp("shore-discovery-"));

const NOW = "2026-04-28T10:00:00.000Z";
const cacheOf = (over: Partial<ProviderModelsCache> = {}): ProviderModelsCache => ({
  version: CACHE_VERSION,
  provider_key: "openrouter",
  fetched_at: NOW,
  models: [],
  ...over,
});

describe("the models URL a provider is asked for", () => {
  test("hangs /models off the configured base", () => {
    expect(buildModelsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
  });

  test("does not double the slash when the base has trailing ones", () => {
    for (const base of ["https://x.test/v1/", "https://x.test/v1//", "https://x.test/v1///"]) {
      expect(buildModelsUrl(base), base).toBe("https://x.test/v1/models");
    }
  });

  test("still produces a path when the base is empty, rather than throwing", () => {
    expect(buildModelsUrl("")).toBe("/models");
  });

  test("nano-gpt is asked for the catalog that carries pricing and capabilities", () => {
    expect(buildModelsUrl("https://nano-gpt.com/api/v1", "nanogpt")).toBe(
      "https://nano-gpt.com/api/v1/models?detailed=true",
    );
  });

  test("no other provider is asked for the detailed shape", () => {
    for (const key of ["openrouter", "xai", "opencode-go", undefined]) {
      expect(buildModelsUrl("https://x.test/v1", key), String(key)).toBe("https://x.test/v1/models");
    }
  });

  test("anthropic supplies the /v1 the base is missing", () => {
    expect(buildAnthropicModelsUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(buildAnthropicModelsUrl("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });

  test("anthropic does not repeat a /v1 the base already has", () => {
    expect(buildAnthropicModelsUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(buildAnthropicModelsUrl("https://gw.test/v1//")).toBe("https://gw.test/v1/models");
  });

  test("a base ending in something v1-ish is not mistaken for /v1", () => {
    expect(buildAnthropicModelsUrl("https://gw.test/apiv1")).toBe("https://gw.test/apiv1/v1/models");
  });
});

describe("an error body written to the log", () => {
  test("is left alone when it already fits", () => {
    expect(truncateForLog("short")).toBe("short");
    expect(truncateForLog("x".repeat(512))).toBe("x".repeat(512));
  });

  test("is capped once it does not, and says it was cut", () => {
    const got = truncateForLog("x".repeat(2000));
    expect(got.endsWith("\u2026")).toBe(true);
    expect(byteLen(got)).toBe(512 + byteLen("\u2026"));
  });

  test("never cuts a character in half, however the bytes fall", () => {
    for (let lead = 508; lead <= 514; lead += 1) {
      const body = `${"x".repeat(lead)}\u4E16${"y".repeat(600)}`;
      const got = truncateForLog(body);
      expect(got, `lead ${lead}`).not.toContain("\uFFFD");
      expect(byteLen(got), `lead ${lead}`).toBeLessThanOrEqual(512 + byteLen("\u2026"));
    }
  });

  test("counts bytes, not characters, so a multibyte body still fits the cap", () => {
    expect(byteLen(truncateForLog("\u4E16".repeat(400)))).toBeLessThanOrEqual(
      512 + byteLen("\u2026"),
    );
  });
});

describe("which dialect a discovered model speaks", () => {
  test("is the provider's own, for every provider that serves one", () => {
    expect(effectiveModelSdk("openai", "gpt-4o", "openai")).toBe("openai");
    expect(effectiveModelSdk("anthropic", "claude-opus-4", "anthropic")).toBe("anthropic");
    expect(effectiveModelSdk("openrouter", "qwen/qwen3", "openai")).toBe("openai");
  });

  test("is decided per model on opencode-go, which serves both", () => {
    expect(effectiveModelSdk("opencode-go", "qwen3-coder", "openai")).toBe("anthropic");
    expect(effectiveModelSdk("opencode-go", "minimax-m2", "openai")).toBe("anthropic");
    expect(effectiveModelSdk("opencode-go", "gpt-4o", "openai")).toBe("openai");
  });

  test("reads the model name after any vendor prefix, case-insensitively", () => {
    expect(effectiveModelSdk("opencode-go", "alibaba/Qwen3-Max", "openai")).toBe("anthropic");
    expect(effectiveModelSdk("opencode-go", "MINIMAX-M2", "openai")).toBe("anthropic");
    expect(effectiveModelSdk("opencode-go", "vendor/qwen/gpt-4o", "openai")).toBe("openai");
  });
});

describe("turning a provider's catalog entry into a model", () => {
  const entry = (raw: unknown) => mapEntry("openrouter", "https://or.test/api/v1", "openai", raw, NOW);

  test("needs an id, and rejects anything shaped wrong", () => {
    for (const bad of [null, undefined, 42, "a string", [], {}, { id: 7 }]) {
      expect(entry(bad), JSON.stringify(bad) ?? "undefined").toBeUndefined();
    }
  });

  test("carries the id, the provider and the base url it was found at", () => {
    expect(entry({ id: "qwen/qwen3" })).toMatchObject({
      provider_key: "openrouter",
      model_id: "qwen/qwen3",
      base_url: "https://or.test/api/v1",
      sdk: "openai",
      discovered_at: NOW,
    });
  });

  test("omits what the provider did not say, rather than writing it as undefined", () => {
    const got = entry({ id: "m" });
    expect(Object.hasOwn(got as object, "display_name")).toBe(false);
    expect(Object.hasOwn(got as object, "context_length")).toBe(false);
    expect(Object.hasOwn(got as object, "supports_tools")).toBe(false);
  });

  test("records a capability the provider denies as false, not as absent", () => {
    const off = entry({ id: "m", supported_parameters: [] });
    expect(off?.supports_tools).toBe(false);
    expect(off?.support?.supported_parameters).toEqual([]);
    const on = entry({ id: "m", supported_parameters: ["tools"] });
    expect(on?.supports_tools).toBe(true);
  });

  test("normalizes effort and thinking support without losing false flags or empty levels", () => {
    expect(entry({
      id: "m",
      capabilities: {
        effort: { supported: false },
        thinking: { supported: false },
      },
    })?.support).toEqual({
      effort: { supported: false, levels: [] },
      thinking: { adaptive: false, enabled: false },
    });
    expect(entry({
      id: "m",
      capabilities: {
        effort: { supported: true, low: { supported: true }, high: { supported: true } },
        thinking: { types: { adaptive: { supported: true }, enabled: { supported: false } } },
      },
    })?.support).toEqual({
      effort: { supported: true, levels: ["low", "high"] },
      thinking: { adaptive: true, enabled: false },
    });
  });

  test("reads nano-gpt's flat capability flags, which name nothing the same way", () => {
    const got = mapEntry("nanogpt", "https://nano-gpt.com/api/v1", "nanogpt", {
      id: "inception/mercury-2.5-preview",
      name: "Mercury 2.5 Preview",
      context_length: 260000,
      max_output_tokens: 65536,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      capabilities: { vision: false, reasoning: true, tool_calling: true },
      reasoning_efforts: ["none", "low", "medium", "high"],
    }, NOW);
    expect(got).toMatchObject({
      model_id: "inception/mercury-2.5-preview",
      display_name: "Mercury 2.5 Preview",
      context_length: 260000,
      max_output_tokens: 65536,
      supports_tools: true,
      supports_reasoning: true,
      supports_images: false,
    });
    expect(got?.support?.effort).toEqual({
      supported: true,
      levels: ["low", "medium", "high"],
    });
  });

  test("a nano-gpt model that cannot reason is pinned to off, not left to guess", () => {
    for (const efforts of [{ reasoning_efforts: [] }, {}]) {
      const got = mapEntry("nanogpt", "https://nano-gpt.com/api/v1", "nanogpt", {
        id: "some/plain-model",
        capabilities: { reasoning: false, tool_calling: false },
        ...efforts,
      }, NOW);
      expect(got?.supports_reasoning, JSON.stringify(efforts)).toBe(false);
      expect(got?.support?.effort, JSON.stringify(efforts)).toEqual({
        supported: false,
        levels: [],
      });
    }
  });

  test("a reasoning model with no effort knob keeps the adapter's own levels", () => {
    const got = mapEntry("nanogpt", "https://nano-gpt.com/api/v1", "nanogpt", {
      id: "qwen/qwen3.8-27b",
      capabilities: { reasoning: true },
      reasoning_efforts: [],
    }, NOW);
    expect(got?.support?.effort).toBeUndefined();
  });

  test("takes the sdk from the per-model rule, not the provider default", () => {
    const got = mapEntry("opencode-go", "https://oc.test", "openai", { id: "qwen3" }, NOW);
    expect(got?.sdk).toBe("anthropic");
  });
});

describe("reading a provider's models response", () => {
  const parse = (body: string, kind = "openai") =>
    parseModelsResponse("openrouter", "https://or.test/v1", kind, body, NOW);

  test("returns the models it could read", () => {
    const got = parse('{"data":[{"id":"a"},{"id":"b"}]}');
    expect((got as { ok: DiscoveredModel[] }).ok.map((m) => m.model_id)).toEqual(["a", "b"]);
  });

  test("skips an entry it cannot make sense of instead of failing the batch", () => {
    const got = parse('{"data":[{"id":"a"},{"no_id":true},7,{"id":"b"}]}');
    expect((got as { ok: DiscoveredModel[] }).ok.map((m) => m.model_id)).toEqual(["a", "b"]);
  });

  test("an empty catalog is an empty list, not an error", () => {
    expect((parse('{"data":[]}') as { ok: DiscoveredModel[] }).ok).toEqual([]);
  });

  test("malformed JSON is a parse error", () => {
    expect((parse("{bad json") as { err: { kind: string } }).err.kind).toBe("parse");
  });

  test("a top-level array is a parse error, since the envelope is an object", () => {
    expect((parse("[]") as { err: { kind: string } }).err.kind).toBe("parse");
    expect((parse('"a string"') as { err: { kind: string } }).err.kind).toBe("parse");
  });

  test("a `data` that is not a list is a parse error", () => {
    expect((parse('{"data":{}}') as { err: { kind: string } }).err.kind).toBe("parse");
  });

  test("an envelope with no `data` at all is an empty catalog, not a failure", () => {
    expect((parse('{"models":[]}') as { ok: DiscoveredModel[] }).ok).toEqual([]);
  });
});

describe("where a provider's catalog is cached", () => {
  test("is one file per provider, under the cache dir", () => {
    expect(cachePath("/cache", "openrouter")).toBe("/cache/providers/openrouter/models.json");
  });

  test("keeps providers apart, so refreshing one cannot clobber another", () => {
    expect(cachePath("/cache", "openai")).not.toBe(cachePath("/cache", "anthropic"));
  });
});

describe("when a cached catalog needs refreshing", () => {
  const now = Date.parse(NOW);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  test("a fresh one does not", () => {
    expect(isStale(cacheOf({ fetched_at: at(0) }), now)).toBe(false);
    expect(isStale(cacheOf({ fetched_at: at(60_000) }), now)).toBe(false);
  });

  test("one older than the refresh interval does", () => {
    expect(isStale(cacheOf({ fetched_at: at(REFRESH_INTERVAL_MS * 2) }), now)).toBe(true);
  });

  test("the boundary itself counts as stale, so it cannot sit there forever", () => {
    expect(isStale(cacheOf({ fetched_at: at(REFRESH_INTERVAL_MS) }), now)).toBe(true);
    expect(isStale(cacheOf({ fetched_at: at(REFRESH_INTERVAL_MS - 1000) }), now)).toBe(false);
  });

  test("one stamped in the future refreshes, because the clock cannot be trusted", () => {
    expect(cacheAgeMs(at(-60_000), now)).toBeUndefined();
    expect(isStale(cacheOf({ fetched_at: at(-60_000) }), now)).toBe(true);
  });

  test("an unreadable timestamp is stale, rather than pinned fresh forever", () => {
    for (const bad of ["2026-04-28", "Apr 28 2026", "not-a-timestamp", "", "2026"]) {
      expect(cacheAgeMs(bad), bad).toBeUndefined();
      expect(isStale(cacheOf({ fetched_at: bad }), now), bad).toBe(true);
    }
  });

  test("the refresh interval is a day, not a debugging value someone left in", () => {
    expect(REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("writing the cache", () => {
  const full = cacheOf({
    models: [
      {
        provider_key: "openrouter",
        model_id: "a",
        display_name: "Model A",
        sdk: "openai",
        discovered_at: NOW,
        support: {
          supported_parameters: [],
          effort: { supported: false, levels: [] },
          thinking: { adaptive: false, enabled: true },
        },
      },
      { provider_key: "openrouter", model_id: "b", sdk: "openai", discovered_at: NOW },
    ] as DiscoveredModel[],
  });

  test("omits absent optionals rather than writing them as null", () => {
    const bytes = serializeCache(full);
    expect(bytes).not.toContain("null");
    expect(bytes).toContain('"display_name"');
  });

  test("round-trips through disk unchanged", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, full);
    expect(await readCache(path)).toEqual(full);
  });

  test("version-1 caches reconstruct normalized support from raw provider metadata", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await mkdir(join(dir, "providers", "openrouter"), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      provider_key: "openrouter",
      fetched_at: NOW,
      models: [{
        provider_key: "openrouter",
        model_id: "legacy",
        sdk: "openrouter",
        raw_provider_metadata: {
          id: "legacy",
          supported_parameters: [],
          capabilities: { effort: { supported: false }, thinking: { supported: false } },
        },
        discovered_at: NOW,
      }],
    }));
    expect((await readCache(path))?.models[0]?.support).toEqual({
      supported_parameters: [],
      effort: { supported: false, levels: [] },
      thinking: { adaptive: false, enabled: false },
    });
  });

  test("creates the parent directories it needs", async () => {
    const dir = await scratch();
    const path = cachePath(join(dir, "deep", "nested"), "p");
    await writeCache(path, cacheOf({ models: [] }));
    expect(await readCache(path)).toBeDefined();
  });

  test("leaves no staging file behind", async () => {
    const dir = await scratch();
    await writeCache(cachePath(dir, "openrouter"), full);
    expect(await readdir(join(dir, "providers", "openrouter"))).toEqual(["models.json"]);
  });

  test("a failed write leaves the previous catalog intact and no debris", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, full);
    const before = await readFile(path, "utf8");

    const poisoned = {
      ...full,
      models: [{ provider_key: "p", model_id: "m", sdk: "openai", raw_provider_metadata: { bad: 1n }, discovered_at: NOW }],
    } as unknown as ProviderModelsCache;
    expect(writeCache(path, poisoned)).rejects.toThrow();

    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readdir(join(dir, "providers", "openrouter"))).toEqual(["models.json"]);
  });

  test("the destination is untouched until the staged write has succeeded", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, full);
    const before = await readFile(path, "utf8");

    await mkdir(`${path}.tmp`, { recursive: true });
    expect(writeCache(path, cacheOf({ models: [] }))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("the fetchers", () => {
  function stub(status: number, body: string) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: requestUrl(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("openai-compatible discovery uses a bearer token", async () => {
    const { impl, calls } = stub(200, '{"data":[{"id":"gpt-4o"}]}');
    const got = await discoverOpenAiCompatible("openai", "https://api.openai.com/v1", "sk-x", impl);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-x");
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(got).toHaveProperty("ok");
  });

  test("anthropic discovery uses x-api-key and the version header", async () => {
    const { impl, calls } = stub(200, '{"data":[{"id":"claude-sonnet-4"}]}');
    const got = await discoverAnthropic("anthropic", "https://api.anthropic.com", "sk-a", impl);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-a");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(got).toHaveProperty("ok");
  });

  test("the discovered sdk follows the dialect, not the provider name", async () => {
    const { impl } = stub(200, '{"data":[{"id":"claude-sonnet-4"}]}');
    const got = await discoverAnthropic("my-gateway", "https://gw.test", "k", impl);
    expect((got as { ok: DiscoveredModel[] }).ok[0]?.sdk).toBe("anthropic");
  });

  test("a non-2xx carries the status and a truncated body", async () => {
    const { impl } = stub(429, "e".repeat(2000));
    const got = await discoverOpenAiCompatible("openai", "https://api.openai.com/v1", "k", impl);
    expect(got).toHaveProperty("err");
    const err = (got as { err: { kind: string; status: number; body: string } }).err;
    expect(err.kind).toBe("http_status");
    expect(err.status).toBe(429);
    expect(byteLen(err.body)).toBe(512 + byteLen("…"));
  });

  test("a transport failure is a network error, not a parse error", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const got = await discoverOpenAiCompatible("openai", "https://api.openai.com/v1", "k", impl);
    expect((got as { err: { kind: string } }).err.kind).toBe("network");
  });

  test("a 200 with a malformed body is a parse error", async () => {
    const { impl } = stub(200, "{bad json");
    const got = await discoverOpenAiCompatible("openai", "https://api.openai.com/v1", "k", impl);
    expect((got as { err: { kind: string } }).err.kind).toBe("parse");
  });
});

describe("reading the cache back", () => {
  async function withFile(contents: string | null): Promise<string> {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    if (contents !== null) {
      await mkdir(join(dir, "providers", "openrouter"), { recursive: true });
      await writeFile(path, contents);
    }
    return path;
  }

  test("a missing file is simply no cache, not a failure", async () => {
    expect(await readCache(await withFile(null))).toBeUndefined();
  });

  test("an unreadable file is discarded rather than crashing a refresh", async () => {
    for (const junk of ["", "{bad json", "[]", "null"]) {
      expect(await readCache(await withFile(junk)), junk).toBeUndefined();
    }
  });

  test("one written by a newer build is discarded, since its shape is unknown here", async () => {
    const newer = JSON.stringify({ ...cacheOf(), version: CACHE_VERSION + 1 });
    expect(await readCache(await withFile(newer))).toBeUndefined();
  });

  test("one written by an older build still loads, so an upgrade does not refetch", async () => {
    const older = JSON.stringify({ ...cacheOf(), version: CACHE_VERSION - 1 });
    expect(await readCache(await withFile(older))).toMatchObject({ version: CACHE_VERSION - 1 });
  });

  test("a well-formed cache loads", async () => {
    const path = await withFile(serializeCache(cacheOf()));
    expect(await readCache(path)).toEqual(cacheOf());
  });

  test("a genuine I/O failure is not swallowed", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "providers", "openrouter", "models.json"), { recursive: true });
    expect(readCache(cachePath(dir, "openrouter"))).rejects.toThrow();
  });
});

describe("nano-gpt subscription coverage", () => {
  const NANOGPT_BASE = "https://nano-gpt.com/api/v1";
  const SUB_URL = "https://nano-gpt.com/api/subscription/v1/models?detailed=true";
  const PAID_URL = "https://nano-gpt.com/api/paid/v1/models?detailed=true";

  function roster(ids: string[]): string {
    return JSON.stringify({ data: ids.map((id) => ({ id })) });
  }

  function split(bodies: Record<string, string>) {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const href = requestUrl(url);
      calls.push(href);
      return new Response(bodies[href] ?? '{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  async function discovered(bodies: Record<string, string>): Promise<DiscoveredModel[]> {
    const { impl } = split(bodies);
    const got = await discoverOpenAiCompatible("nanogpt", NANOGPT_BASE, "k", impl);
    return (got as { ok: DiscoveredModel[] }).ok;
  }

  const coverage = (models: readonly DiscoveredModel[]): Record<string, boolean | undefined> =>
    Object.fromEntries(models.map((m) => [m.model_id, m.subscription_included]));

  async function cacheWith(models: unknown[]): Promise<string> {
    const dir = await scratch();
    const path = cachePath(dir, "nanogpt");
    await mkdir(join(dir, "providers", "nanogpt"), { recursive: true });
    await writeFile(path, JSON.stringify({ ...cacheOf({ provider_key: "nanogpt" }), models }));
    return path;
  }

  test("asks both documented endpoints, never the preference-sensitive canonical one", async () => {
    const { impl, calls } = split({});
    await discoverOpenAiCompatible("nanogpt", NANOGPT_BASE, "k", impl);
    expect(calls, "the canonical list silently restricts once a subscription is live").toEqual([
      SUB_URL,
      PAID_URL,
    ]);
  });

  test("the union is the whole catalog, not either half", async () => {
    const models = await discovered({ [SUB_URL]: roster(["a", "b"]), [PAID_URL]: roster(["c"]) });
    expect(models.map((m) => m.model_id).sort()).toEqual(["a", "b", "c"]);
  });

  test("membership follows the endpoint that returned the model", async () => {
    const models = await discovered({
      [SUB_URL]: roster(["covered"]),
      [PAID_URL]: roster(["paygo"]),
    });
    expect(coverage(models)).toEqual({ covered: true, paygo: false });
  });

  test("a model both endpoints claim is not covered, since its route is unknowable", async () => {
    const models = await discovered({
      [SUB_URL]: roster(["auto-model", "covered"]),
      [PAID_URL]: roster(["auto-model", "paygo"]),
    });
    expect(coverage(models)).toEqual({ "auto-model": false, covered: true, paygo: false });
  });

  test("every entry carries an explicit verdict, so none is costed on an absent field", async () => {
    const models = await discovered({ [SUB_URL]: roster(["a"]), [PAID_URL]: roster(["b"]) });
    for (const m of models) expect(typeof m.subscription_included, m.model_id).toBe("boolean");
  });

  test("the input multiplier is read where the payload carries it", async () => {
    const models = await discovered({
      [SUB_URL]: JSON.stringify({
        data: [
          { id: "double", subscription: { included: true, inputTokenMultiplier: 2 } },
          { id: "plain" },
        ],
      }),
    });
    expect(models[0]?.subscription_input_multiplier).toBe(2);
    expect(models[1]?.subscription_input_multiplier).toBeUndefined();
  });

  test("a failure on either half fails the refresh rather than shrinking the roster", async () => {
    for (const failing of [SUB_URL, PAID_URL]) {
      const impl = (async (url: string | URL | Request) => {
        const href = requestUrl(url);
        return new Response(href === failing ? "boom" : '{"data":[]}', {
          status: href === failing ? 500 : 200,
        });
      }) as unknown as typeof fetch;
      const got = await discoverOpenAiCompatible("nanogpt", NANOGPT_BASE, "k", impl);
      expect(got, failing).toHaveProperty("err");
    }
  });

  test("coverage survives the cache round trip", async () => {
    const models = await discovered({
      [SUB_URL]: roster(["covered"]),
      [PAID_URL]: roster(["paygo"]),
    });
    const dir = await scratch();
    const path = cachePath(dir, "nanogpt");
    await writeCache(path, cacheOf({ provider_key: "nanogpt", models }));
    expect(coverage((await readCache(path))?.models ?? [])).toEqual({
      covered: true,
      paygo: false,
    });
  });

  test("a cache written before the field existed falls back to the inline block", async () => {
    const path = await cacheWith([
      {
        provider_key: "nanogpt",
        model_id: "covered",
        sdk: "openai",
        discovered_at: NOW,
        raw_provider_metadata: {
          id: "covered",
          subscription: { included: true, inputTokenMultiplier: 2 },
        },
      },
      {
        provider_key: "nanogpt",
        model_id: "paygo",
        sdk: "openai",
        discovered_at: NOW,
        raw_provider_metadata: { id: "paygo", subscription: { included: false } },
      },
    ]);
    const models = (await readCache(path))?.models ?? [];
    expect(coverage(models), "an old cache must not read as uncovered across the board").toEqual({
      covered: true,
      paygo: false,
    });
    expect(models[0]?.subscription_input_multiplier).toBe(2);
  });

  test("an explicit field wins over a stale inline block", async () => {
    const path = await cacheWith([
      {
        provider_key: "nanogpt",
        model_id: "auto-model",
        sdk: "openai",
        discovered_at: NOW,
        subscription_included: false,
        raw_provider_metadata: { id: "auto-model", subscription: { included: true } },
      },
    ]);
    expect(coverage((await readCache(path))?.models ?? [])).toEqual({ "auto-model": false });
  });
});
