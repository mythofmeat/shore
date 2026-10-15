import { describe, expect, test } from "bun:test";

import { anyToolEnabled, defaultAppConfig, defaultToolsConfig, parseAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";

function parseToml(src: string): unknown {
  return Bun.TOML.parse(src);
}

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value as ReadonlyMap<string, unknown>) out[k] = canonical(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = canonical(v);
    return out;
  }
  return value;
}

function parsed(toml: string): unknown {
  const result = parseAppConfig(parseToml(toml));
  if ("err" in result) throw new Error(`expected a config, got: ${result.err}`);
  return canonical(result.ok);
}

function rejected(toml: string): string {
  const result = parseAppConfig(parseToml(toml));
  if ("ok" in result) throw new Error("expected a parse error, got a config");
  return result.err;
}

describe("the shipped defaults", () => {
  test("parse out of an empty document, so a config file is optional", () => {
    expect(parsed("")).toEqual(canonical(defaultAppConfig()));
  });

  test("enable no tools, so a fresh install cannot touch the filesystem", () => {
    expect(anyToolEnabled(defaultToolsConfig())).toBe(false);
  });

  test("round-trip: re-parsing a serialized default config gives the same config", () => {
    expect(parsed("")).toEqual(parsed("\n\n# a comment\n\n"));
  });
});

describe("a config.toml that cannot be honoured is refused, and says what is wrong", () => {

  test("an unknown top-level section is rejected", () => {
    expect(rejected("[bogus_section]\nkey = \"value\"\n")).toContain("bogus_section");
  });

  test("an unknown nested key is rejected", () => {
    expect(rejected("[behavior.autonomy]\nenabled = true\nbogus_key = 42\n")).toContain("bogus_key");
  });

});
