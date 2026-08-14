import { describe, expect, test } from "bun:test";

import fixture from "./config_fixtures/validate.json" with { type: "json" };

import {
  ConfigError,
  parseConfigTable,
  type ConfigErrorKind,
  type ConfigWarn,
  type LoadedConfig,
  type TomlTable,
} from "../src/config/loader.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { compareByCodePoint } from "../src/util/sort.ts";
import { defaultCompactionConfig } from "../src/config/app.ts";

import { pathsSetBy } from "./config_delta.ts";

interface Warning {
  message: string;
  fields: [string, string][];
}

interface Case {
  name: string;
  toml: string;
  warnings: Warning[];
  ok?: {
    chat: { name: string; sdk: string; base_url: string | null }[];
    embedding: string[];
    image_generation: string[];
    providers: { key: string; enabled: boolean }[];
    defaults: Record<string, unknown>;
    raw_table_keys: string[] | null;
    enabled_tools: string[];
    enabled_subagents: string[];
    subagents: string[];
    mcp: string[];
    compaction_enabled: boolean;
  };
  err?: { kind: ConfigErrorKind; message: string };
}

const cases = fixture.cases as unknown as Case[];

const BUN_TOML_NONFINITE = new Set([
  "NaN budget cost_usd passes",
]);

const USES_DELETED_DAEMON_KEYS = new Set(["unified config"]);

const USES_DELETED_SPIKE_WARNINGS = new Set([
  "spike multiplier equal to one is rejected",
  "spike multiplier just above one passes",
  "spike min_cost_usd negative is rejected",
  "spike min_cost_usd zero passes",
  "NaN spike multiplier passes every guard",
  "infinite spike multiplier passes",
  "negative infinite min_cost_usd is rejected",
]);

const replayable = cases.filter(
  (c) =>
    !BUN_TOML_NONFINITE.has(c.name) &&
    !USES_DELETED_DAEMON_KEYS.has(c.name) &&
    !USES_DELETED_SPIKE_WARNINGS.has(c.name),
);

const DIRS: ShoreDirs = {
  config: "/nonexistent/config",
  data: "/nonexistent/data",
  runtime: "/nonexistent/runtime",
  cache: "/nonexistent/cache",
};

function canonicalDefaults(defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] =
      value === undefined
        ? null
        : typeof value === "object" && value !== null
          ? canonicalDefaults(value as Record<string, unknown>)
          : value;
  }
  return out;
}

function okDigest(loaded: LoadedConfig): Case["ok"] {
  return {
    chat: [...loaded.models.chat].map(([name, model]) => ({
      name,
      sdk: model.sdk,
      base_url: model.baseUrl ?? null,
    })),
    embedding: [...loaded.models.embedding.keys()],
    image_generation: [...loaded.models.imageGeneration.keys()],
    providers: loaded.providers
      .entries()
      .map(([key, entry]) => ({ key, enabled: entry.enabled })),
    defaults: canonicalDefaults(loaded.app.defaults as unknown as Record<string, unknown>),
    raw_table_keys: Object.keys(loaded.rawTable ?? {}).sort(compareByCodePoint),
    enabled_tools: loaded.app.tools.enabled_tools,
    enabled_subagents: loaded.app.tools.enabled_subagents,
    subagents: [...loaded.app.subagents.keys()],
    mcp: [...loaded.app.mcp.keys()],
    compaction_enabled: loaded.app.memory.compaction.enabled,
  };
}

function run(src: string): {
  loaded?: LoadedConfig;
  error?: ConfigError;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  const onWarn: ConfigWarn = (message, fields) => {
    warnings.push({ message, fields: fields.map(([k, v]) => [k, v]) });
  };

  const table = Bun.TOML.parse(src) as TomlTable;
  try {
    return { loaded: parseConfigTable(table, { ...DIRS }, onWarn), warnings };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { error: e, warnings };
  }
}

describe("the fixture is real", () => {
  test("it covers both outcomes, and warnings on both sides of them", () => {
    const errs = replayable.filter((c) => c.err !== undefined);
    expect(replayable.filter((c) => c.err === undefined).length).toBeGreaterThan(30);
    expect(errs.filter((c) => c.err?.kind === "validation").length).toBeGreaterThan(35);
    expect(replayable.filter((c) => c.warnings.length > 0).length).toBeGreaterThan(15);
    expect(
      errs.filter((c) => c.warnings.length > 0).length,
    ).toBeGreaterThan(0);
    expect(replayable.filter((c) => c.warnings.length > 1).length).toBeGreaterThan(0);
  });
});

describe("the deleted [daemon] keys", () => {
  test("a config that still sets them is rejected, naming the key", () => {
    for (const name of USES_DELETED_DAEMON_KEYS) {
      const c = cases.find((x) => x.name === name);
      expect(c, name).toBeDefined();
      const { error } = run(c!.toml);
      expect(error?.kind, name).toBe("parse_app");
      expect(error?.message, name).toContain("allowed_hosts");
    }
  });
});

describe("the deleted [usage.spike_warnings] field", () => {
  test("old configs are rejected by name", () => {
    for (const name of USES_DELETED_SPIKE_WARNINGS) {
      const c = cases.find((x) => x.name === name);
      expect(c, name).toBeDefined();
      const { error } = run(c!.toml);
      expect(error?.kind, name).toBe("parse_app");
      expect(error?.message, name).toContain("spike_warnings");
    }
  });
});

const RECORDED_DEFAULT_MAX_TURNS = 16;

function withCurrentCompactionDefaults(message: string, toml: string): string {
  if (pathsSetBy(Bun.TOML.parse(toml)).has("memory.compaction.max_turns")) return message;
  return message.replace(
    `max_turns (${RECORDED_DEFAULT_MAX_TURNS})`,
    `max_turns (${defaultCompactionConfig().max_turns})`,
  );
}

describe("parseConfigTable + validateConfig", () => {
  for (const c of replayable) {
    test(c.name, () => {
      const { loaded, error, warnings } = run(c.toml);

      if (c.err === undefined) {
        expect(error, "expected a successful load").toBeUndefined();
        expect(loaded).toBeDefined();
        if (loaded !== undefined) expect(okDigest(loaded)).toEqual(c.ok);
      } else {
        expect(loaded, "expected a rejection").toBeUndefined();
        expect(error?.kind).toBe(c.err.kind);
        if (c.err.kind === "validation") {
          expect(error?.message).toBe(withCurrentCompactionDefaults(c.err.message, c.toml));
        }
      }

      expect(warnings).toEqual(c.warnings);
    });
  }
});

describe("Bun.TOML.parse non-finite floats", () => {
  test("decodes them wrongly, in these specific ways", () => {
    const decode = (src: string): unknown => (Bun.TOML.parse(src) as { a: unknown }).a;

    expect(decode("a = nan")).toBe("nan");
    expect(decode("a = inf")).toBe("inf");
    expect(decode("a = [nan]")).toEqual(["nan"]);

    expect(Object.is(decode("a = -inf"), -0)).toBe(true);
    expect(Object.is(decode("a = +inf"), 0)).toBe(true);
    expect(Object.is(decode("a = +nan"), 0)).toBe(true);

    expect(() => Bun.TOML.parse("a = 1e400")).toThrow();

    expect(Object.is(decode("a = -0.0"), -0)).toBe(true);
    expect(decode("a = 1.5")).toBe(1.5);
  });
});

describe("warning sink", () => {
  test("renders message then fields", async () => {
    const { consoleConfigWarn } = await import("../src/config/loader.ts");
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      consoleConfigWarn("something is off", [
        ["field", "defaults.model"],
        ["name", "ghost"],
      ]);
      consoleConfigWarn("no fields here", []);
    } finally {
      console.warn = real;
    }

    expect(lines).toEqual([
      "shore: something is off field=defaults.model name=ghost",
      "shore: no fields here",
    ]);
  });
});
