import { describe, expect, test } from "bun:test";

import { anyToolEnabled, defaultAppConfig, parseAppConfig } from "../src/config/app.ts";
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
    expect(anyToolEnabled(defaultAppConfig())).toBe(false);
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
    expect(rejected("[triggers]\nenabled = true\nbogus_key = 42\n")).toContain("bogus_key");
  });

});

describe("a section that holds named tables beside its settings", () => {
  test("a table under [tools] that isn't one of its settings holds that tool's own limits, and a mistake inside one is refused", () => {
    const { tools } = parsed('[tools]\nenabled = ["bash"]\n[tools.read]\nmax_result_chars = 9\n[tools.bash]\ntimeout = "1m"\n') as { tools: Record<string, unknown> };
    expect(tools["enabled"]).toEqual(["bash"]);
    expect(tools["per_tool"]).toEqual({ bash: { max_result_chars: null, timeout: "1m" }, read: { max_result_chars: 9, timeout: null } });
    expect(Object.keys(tools["per_tool"] as object)).toEqual(["bash", "read"]);
    expect(rejected("[tools.bash]\nbogus = 1\n")).toBe("unknown field `bogus`, expected one of `max_result_chars`, `max_inline_image_bytes`, `timeout`");
    expect(rejected("[tools]\nbash = 5\n")).toBe("invalid type: integer `5`, expected struct ToolOverride");
  });

  test("a table under [subagents] that isn't one of its settings defines a sub-agent", () => {
    const { subagents } = parsed('[subagents]\nenabled = ["scout"]\n[subagents.scout]\ndescription = "looks"\nprompt = "look"\nmax_tool_rounds = 2\n') as { subagents: Record<string, unknown> };
    expect(subagents).toEqual({
      model: null,
      enabled: ["scout"],
      agents: { scout: { description: "looks", prompt: "look", tools: [], model: null, max_tool_rounds: 2, timeout: null } },
    });
    expect(rejected('[subagents.scout]\ndescription = "looks"\n')).toBe("missing field `prompt`");
  });

  test("a tool, an MCP server or a sub-agent that is on each counts as tools being on", () => {
    const on = (toml: string): boolean => {
      const result = parseAppConfig(parseToml(toml));
      if ("err" in result) throw new Error(result.err);
      return anyToolEnabled(result.ok);
    };
    expect([on('[tools]\nenabled = ["bash"]\n'), on('[tools]\nmcp = ["search"]\n'), on('[subagents]\nenabled = ["scout"]\n'), on('[tools]\ntimeout = "1m"\n')]).toEqual([true, true, true, false]);
  });
});
