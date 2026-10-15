import { describe, expect, test } from "bun:test";
import { McpRegistry, type McpToolDef } from "../src/tools/mcp_registry.ts";
import { childEnvironment } from "../src/mcp/client.ts";
import { outcomeOf } from "./support/outcome.ts";

function toolDef(server: string, tool: string): McpToolDef {
  return {
    full_name: `mcp__${server}__${tool}`,
    description: `${tool} tool`,
    input_schema: { type: "object" },
    server,
    tool,
    repeatable: false,
  };
}

const registry = McpRegistry.fromTools([
  toolDef("hue", "set_light"),
  toolDef("hue", "get_light"),
  toolDef("alpha", "z"),
  toolDef("alpha", "a"),
  toolDef("multi__part", "tool__name"),
  toolDef("\u{1F3B5}drum", "play"),
  toolDef("\u{FB00}ute", "play"),
  toolDef("hue", "set"),
]);

describe("call routing", () => {
  test("an unknown name is reported, not dispatched", async () => {
    expect(await outcomeOf(registry.call("mcp__nope__x", {}))).toThrow("not yet implemented");
  });
});

describe("childEnvironment", () => {
  test("only PATH and HOME are inherited", () => {
    const env = childEnvironment(
      {},
      { PATH: "/bin", HOME: "/root", ANTHROPIC_API_KEY: "sk-secret", TAVILY_KEY: "t" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/root" });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  test("configured env is added, and wins over the inherited pair", () => {
    const env = childEnvironment({ TOKEN: "x", PATH: "/custom" }, { PATH: "/bin", HOME: "/root" });
    expect(env).toEqual({ PATH: "/custom", HOME: "/root", TOKEN: "x" });
  });

  test("an absent PATH or HOME is simply not set", () => {
    expect(childEnvironment({}, {})).toEqual({});
  });
});
