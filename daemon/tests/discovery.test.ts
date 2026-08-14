/**
 * Recorded cases for discovery.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 *
 * What a failure means, by section:
 */

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
import { testTmp } from "./support/tmp.ts";

interface UrlCase {
  base_url: string;
  expect: string;
}

interface TruncCase {
  name: string;
  input: string;
  input_byte_len: number;
  expect: string;
  expect_byte_len: number;
}

interface SdkCase {
  provider_key: string;
  model_id: string;
  default_sdk: string;
  expect: string;
}

interface MapCase {
  name: string;
  provider_key: string;
  base_url: string;
  sdk: string;
  raw: unknown;
  expect: Record<string, unknown> | null;
}

interface ParseCase {
  name: string;
  provider_key: string;
  base_url: string;
  kind: string;
  body: string;
  expect:
    | { ok: { model_id: string; sdk: string; display_name: string | null }[] }
    | { error: string };
}

interface PathCase {
  cache_dir: string;
  provider_key: string;
  expect: string;
}

interface StalenessCase {
  name: string;
  offset_secs?: number;
  fetched_at?: string;
  age_is_known: boolean;
  stale: boolean;
}

interface ReadCase {
  name: string;
  file: string | null;
  expect: Record<string, unknown> | null;
}

interface Fixture {
  cache_version: number;
  refresh_interval_secs: number;
  anthropic_version_header: string;
  build_models_url: UrlCase[];
  build_anthropic_models_url: UrlCase[];
  truncate_for_log: TruncCase[];
  effective_model_sdk: SdkCase[];
  map_entry: { now: string; cases: MapCase[] };
  parse_models_response: ParseCase[];
  cache_path: PathCase[];
  staleness: StalenessCase[];
  write_cache: {
    full: {
      cache: ProviderModelsCache;
      bytes: string;
      tmp_left_behind: boolean;
      round_trips: boolean;
    };
    empty: { cache: ProviderModelsCache; bytes: string };
  };
  read_cache: ReadCase[];
}

const fixture = (await Bun.file(
  new URL("./llm_fixtures/discovery.json", import.meta.url),
).json()) as Fixture;

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

async function scratch(): Promise<string> {
  return await mkdtemp(testTmp("discovery-parity-"));
}

describe("the fixture is real", () => {

  test("the truncation cases actually straddle the byte cap", () => {
    // Every case where the input is longer than the cap but the *character*
    // count is not would pass trivially against a code-unit implementation.
    // At least one case must cut inside a multibyte character.
    const straddling = fixture.truncate_for_log.filter((c) => {
      if (c.input_byte_len <= 512) return false;
      // The kept prefix is shorter than the cap: the cut walked backwards.
      return c.expect_byte_len - byteLen("…") < 512;
    });
    expect(straddling.length).toBeGreaterThan(0);
  });

  test("capabilities are recorded in all three states", () => {
    const states = new Set<string>();
    for (const c of fixture.map_entry.cases) {
      if (c.expect === null) continue;
      const v = c.expect.supports_tools;
      states.add(v === undefined ? "unknown" : String(v));
    }
    expect(states).toEqual(new Set(["unknown", "true", "false"]));
  });

  test("both parse outcomes are represented", () => {
    const ok = fixture.parse_models_response.filter((c) => "ok" in c.expect);
    const err = fixture.parse_models_response.filter((c) => "error" in c.expect);
    expect(ok.length).toBeGreaterThan(0);
    expect(err.length).toBeGreaterThan(0);
  });

  test("staleness is recorded in both directions", () => {
    const fresh = fixture.staleness.filter((c) => !c.stale);
    const stale = fixture.staleness.filter((c) => c.stale);
    expect(fresh.length).toBeGreaterThan(0);
    expect(stale.length).toBeGreaterThan(0);
  });

  test("the written cache exercises both present and absent optionals", () => {
    const models = fixture.write_cache.full.cache.models;
    expect(models.some((m) => m.display_name !== undefined)).toBe(true);
    expect(models.some((m) => m.display_name === undefined)).toBe(true);
  });
});

describe("constants match the Rust", () => {
  test("cache version", () => {
    expect(CACHE_VERSION).toBe(fixture.cache_version);
  });

  test("refresh interval", () => {
    expect(REFRESH_INTERVAL_MS).toBe(fixture.refresh_interval_secs * 1000);
  });
});

describe("buildModelsUrl", () => {
  for (const c of fixture.build_models_url) {
    test(`${c.base_url || "(empty)"} → ${c.expect}`, () => {
      expect(buildModelsUrl(c.base_url)).toBe(c.expect);
    });
  }
});

describe("buildAnthropicModelsUrl", () => {
  for (const c of fixture.build_anthropic_models_url) {
    test(`${c.base_url || "(empty)"} → ${c.expect}`, () => {
      expect(buildAnthropicModelsUrl(c.base_url)).toBe(c.expect);
    });
  }
});

describe("truncateForLog", () => {
  for (const c of fixture.truncate_for_log) {
    test(c.name, () => {
      const got = truncateForLog(c.input);
      expect(got).toBe(c.expect);
      // Pinned separately: an implementation could produce the right string by
      // accident while measuring the wrong thing.
      expect(byteLen(got)).toBe(c.expect_byte_len);
    });
  }

  test("output is always valid UTF-8, never a split character", () => {
    for (const c of fixture.truncate_for_log) {
      const got = truncateForLog(c.input);
      expect(got, c.name).not.toContain("�");
    }
  });
});

describe("effectiveModelSdk", () => {
  for (const c of fixture.effective_model_sdk) {
    test(`${c.provider_key} / ${c.model_id || "(empty)"} / ${c.default_sdk}`, () => {
      expect(effectiveModelSdk(c.provider_key, c.model_id, c.default_sdk)).toBe(c.expect);
    });
  }
});

describe("mapEntry", () => {
  const now = fixture.map_entry.now;

  for (const c of fixture.map_entry.cases) {
    test(c.name, () => {
      const got = mapEntry(c.provider_key, c.base_url, c.sdk, c.raw, now);
      if (c.expect === null) {
        expect(got).toBeUndefined();
        return;
      }
      // Compared through JSON so an explicit `undefined` and an absent key are
      // the same thing here — which is exactly the equivalence the cache file
      // relies on.
      expect(JSON.parse(JSON.stringify(got))).toEqual(c.expect);
    });
  }

  test("keys absent in the Rust are absent here, not present-and-undefined", () => {
    // `JSON.stringify` hides the difference; the cache file does not, and a
    // consumer doing `"supports_tools" in model` would see the wrong answer.
    for (const c of fixture.map_entry.cases) {
      if (c.expect === null) continue;
      const got = mapEntry(c.provider_key, c.base_url, c.sdk, c.raw, now);
      expect(got, c.name).toBeDefined();
      for (const key of Object.keys(got as object)) {
        if (key === "raw_provider_metadata") continue;
        expect(Object.hasOwn(c.expect, key), `${c.name}: extra key ${key}`).toBe(true);
      }
    }
  });
});

describe("parseModelsResponse", () => {
  for (const c of fixture.parse_models_response) {
    test(c.name, () => {
      const got = parseModelsResponse(c.provider_key, c.base_url, c.kind, c.body, "2026-01-01");
      if ("error" in c.expect) {
        expect(got).toHaveProperty("err");
        expect((got as { err: { kind: string } }).err.kind).toBe(c.expect.error);
        return;
      }
      expect(got).toHaveProperty("ok");
      const models = (got as { ok: DiscoveredModel[] }).ok;
      expect(
        models.map((m) => ({
          model_id: m.model_id,
          sdk: m.sdk,
          display_name: m.display_name ?? null,
        })),
      ).toEqual(c.expect.ok);
    });
  }
});

describe("cachePath", () => {
  for (const c of fixture.cache_path) {
    test(`${c.cache_dir} / ${c.provider_key}`, () => {
      expect(cachePath(c.cache_dir, c.provider_key)).toBe(c.expect);
    });
  }
});

describe("staleness", () => {
  for (const c of fixture.staleness) {
    test(c.name, () => {
      // Offset cases rebuild the timestamp against a fixed instant so the case
      // means the same thing whenever it runs; literal cases pass the string
      // through unchanged.
      const now = Date.parse("2026-04-28T10:00:00Z");
      const fetchedAt =
        c.fetched_at ?? new Date(now - (c.offset_secs as number) * 1000).toISOString();

      expect(cacheAgeMs(fetchedAt, now) !== undefined).toBe(c.age_is_known);

      const cache: ProviderModelsCache = {
        version: CACHE_VERSION,
        provider_key: "p",
        fetched_at: fetchedAt,
        models: [],
      };
      expect(isStale(cache, now)).toBe(c.stale);
    });
  }

  test("an unparseable timestamp is stale rather than pinned fresh", () => {
    // The failure this guards: `Date.parse` is looser than chrono, so a shape
    // the Rust rejected could read as a valid — and possibly recent — date.
    for (const bad of ["2026-04-28", "Apr 28 2026", "not-a-timestamp", "", "2026"]) {
      expect(cacheAgeMs(bad), bad).toBeUndefined();
    }
  });

  test("the interval boundary is inclusive", () => {
    const now = Date.parse("2026-04-28T10:00:00Z");
    const at = new Date(now - REFRESH_INTERVAL_MS).toISOString();
    const justUnder = new Date(now - REFRESH_INTERVAL_MS + 1000).toISOString();
    const cache = (fetched_at: string): ProviderModelsCache => ({
      version: CACHE_VERSION,
      provider_key: "p",
      fetched_at,
      models: [],
    });
    expect(isStale(cache(at), now)).toBe(true);
    expect(isStale(cache(justUnder), now)).toBe(false);
  });
});

describe("the cache file is byte-identical to the Rust's", () => {
  test("a full cache", () => {
    expect(serializeCache(fixture.write_cache.full.cache)).toBe(fixture.write_cache.full.bytes);
  });

  test("an empty cache", () => {
    expect(serializeCache(fixture.write_cache.empty.cache)).toBe(fixture.write_cache.empty.bytes);
  });

  test("absent optionals are omitted, not written as null", () => {
    expect(fixture.write_cache.full.bytes).not.toContain("null");
  });

  test("writeCache lands those exact bytes on disk", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, fixture.write_cache.full.cache);
    expect(await readFile(path, "utf8")).toBe(fixture.write_cache.full.bytes);
  });

  test("writeCache leaves no tmp sibling behind", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, fixture.write_cache.full.cache);
    expect(fixture.write_cache.full.tmp_left_behind).toBe(false);
    const entries = await readdir(join(dir, "providers", "openrouter"));
    expect(entries).toEqual(["models.json"]);
  });

  test("writeCache creates missing parent directories", async () => {
    const dir = await scratch();
    const path = cachePath(join(dir, "deep", "nested"), "p");
    await writeCache(path, fixture.write_cache.empty.cache);
    expect(await readFile(path, "utf8")).toBe(fixture.write_cache.empty.bytes);
  });

  test("a failed write leaves the previous catalog intact", async () => {
    // The reason the tmp-then-rename dance exists. A cache that cannot be
    // serialized must not take the last good one down with it — the user would
    // lose their discovered models with no way to tell why.
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, fixture.write_cache.full.cache);

    const poisoned = {
      ...fixture.write_cache.empty.cache,
      models: [
        {
          provider_key: "p",
          model_id: "m",
          sdk: "openai",
          // `JSON.stringify` throws on a BigInt rather than encoding it, and
          // `raw_provider_metadata` is the one field that carries whatever the
          // provider sent through to the file unexamined.
          raw_provider_metadata: { bad: 1n },
          discovered_at: "t",
        },
      ],
    } as unknown as ProviderModelsCache;
    await expect(writeCache(path, poisoned)).rejects.toThrow();

    expect(await readFile(path, "utf8")).toBe(fixture.write_cache.full.bytes);
    const entries = await readdir(join(dir, "providers", "openrouter"));
    expect(entries, "no half-written tmp file left behind").toEqual(["models.json"]);
  });

  test("the destination is untouched until the staged write has succeeded", async () => {
    // The previous case only proves serialization is checked before anything is
    // written — an in-place `writeFile` would pass it too. This one fails the
    // write itself: a directory sits where the tmp sibling goes, so staging
    // cannot succeed. Writing straight to the destination would open it with
    // O_TRUNC and leave the user with an empty or half-written catalog; staging
    // first means the destination is never opened at all.
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, fixture.write_cache.full.cache);

    await mkdir(`${path}.tmp`, { recursive: true });
    await expect(writeCache(path, fixture.write_cache.empty.cache)).rejects.toThrow();

    expect(await readFile(path, "utf8")).toBe(fixture.write_cache.full.bytes);
  });

  test("a written cache reads back equal", async () => {
    const dir = await scratch();
    const path = cachePath(dir, "openrouter");
    await writeCache(path, fixture.write_cache.full.cache);
    expect(fixture.write_cache.full.round_trips).toBe(true);
    expect(await readCache(path)).toEqual(fixture.write_cache.full.cache);
  });
});

describe("the fetchers", () => {
  // Not fixture-driven — the Rust's HTTP calls could not be recorded without a
  // live provider. What is pinned here is the part a port gets wrong silently:
  // the two dialects authenticate differently, and sending the wrong header
  // fails as a 401 that looks exactly like a bad key.
  function stub(status: number, body: string) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
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
    expect(calls[0]?.headers["anthropic-version"]).toBe(fixture.anthropic_version_header);
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

describe("readCache", () => {
  for (const c of fixture.read_cache) {
    test(c.name, async () => {
      const dir = await scratch();
      const path = cachePath(dir, "openrouter");
      if (c.file !== null) {
        await mkdir(join(dir, "providers", "openrouter"), { recursive: true });
        await writeFile(path, c.file);
      }
      const got = await readCache(path);
      if (c.expect === null) {
        expect(got).toBeUndefined();
        return;
      }
      expect(JSON.parse(JSON.stringify(got))).toEqual(c.expect);
    });
  }

  test("a genuine I/O failure is not swallowed", async () => {
    // Only the file's *contents* resolve to "no cache". Reading a directory as
    // a file is EISDIR, and a caller that cannot tell that apart from an empty
    // cache would refetch forever without ever reporting the problem.
    const dir = await scratch();
    await mkdir(join(dir, "providers", "openrouter", "models.json"), { recursive: true });
    await expect(readCache(cachePath(dir, "openrouter"))).rejects.toThrow();
  });
});
