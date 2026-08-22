import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import rawFixture from "./tools_captures/tool_registry.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import {
  ALL_TOOLS,
  anyEnabled,
  assembleToolSurface,
  availableTools,
  renderToolDefs,
  subagentToolDefs,
  toolPatternMatches,
  type SubagentConfigView,
  type ToolCategory,
  type ToolsConfigView,
} from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/llm/types.ts";

interface FixtureToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
}
interface FixtureToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const fx = fixture as unknown as {
  all_tools: FixtureToolDef[];
  available_tools: Record<
    string,
    { enabled_tools: string[]; offered: string[]; any_enabled: boolean }
  >;
  render_tool_defs: Record<
    string,
    { char_name: string; user_name: string; defs: FixtureToolDefinition[] }
  >;
  subagent_config: { name: string; description: string }[];
  subagent_tool_defs: Record<
    string,
    {
      enabled: string[];
      char_name: string;
      user_name: string;
      defs: FixtureToolDefinition[];
    }
  >;
  assemble_tool_surface: Record<
    string,
    { input: { static: string[]; subagent: string[]; mcp: string[] }; order: string[] }
  >;
};

function cfg(enabledTools: string[], enabledSubagents: string[] = []): ToolsConfigView {
  return { enabled_tools: enabledTools, enabled_subagents: enabledSubagents };
}

const subagentConfig: ReadonlyMap<string, SubagentConfigView> = new Map(
  fx.subagent_config.map((s) => [s.name, { description: s.description }]),
);

function def(name: string): ToolDefinition {
  return { name, description: "", input_schema: { type: "object" } };
}

describe("the registry itself", () => {
  test("offers exactly the tools the Rust did, in the same order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(fx.all_tools.map((t) => t.name));
  });

  test.each(fx.all_tools.map((t): [string, FixtureToolDef] => [t.name, t]))(
    "%s matches the Rust definition exactly",
    (name, expected) => {
      const actual = ALL_TOOLS.find((t) => t.name === name);
      expect(actual).toBeDefined();
      expect(actual?.description).toBe(expected.description);
      expect(actual?.parameters).toEqual(expected.parameters);
      expect(actual?.category).toBe(expected.category);
    },
  );

  test("descriptions carry no trailing newline", () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.endsWith("\n")).toBe(false);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test("every category is one of the two known values", () => {
    for (const t of fx.all_tools) {
      expect(["web", "other"]).toContain(t.category);
    }
  });

  test("names are unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(["write", "list_files", "check_time", "exec", "memory_search", "set_next_wake"])(
    "%s is not offered",
    (name) => {
      expect(ALL_TOOLS.some((t) => t.name === name)).toBe(false);
    },
  );
});

describe("availableTools — the allowlist", () => {
  test.each(Object.entries(fx.available_tools))("%s", (_label, c) => {
    const config = cfg(c.enabled_tools);
    expect(availableTools(config).map((t) => t.name)).toEqual(c.offered);
    expect(anyEnabled(config)).toBe(c.any_enabled);
  });

  test("a sub-agent alone makes tool use active", () => {
    expect(anyEnabled(cfg([], ["music"]))).toBe(true);
    expect(anyEnabled(cfg([], []))).toBe(false);
  });

  test("pattern matching is exact unless it ends in a star", () => {
    expect(toolPatternMatches("read", "read")).toBe(true);
    expect(toolPatternMatches("read", "ready")).toBe(false);
    expect(toolPatternMatches("mcp__hue__*", "mcp__hue__set_light")).toBe(true);
    expect(toolPatternMatches("mcp__hue__*", "mcp__lifx__set")).toBe(false);
    expect(toolPatternMatches("*", "anything")).toBe(true);
    expect(toolPatternMatches("*", "")).toBe(true);
  });
});

describe("renderToolDefs — description templating", () => {
  test.each(Object.entries(fx.render_tool_defs))("%s", (_label, c) => {
    const enabled = c.defs.map((d) => d.name);
    const actual = renderToolDefs(cfg(enabled), c.char_name, c.user_name);
    expect(actual).toEqual(c.defs as ToolDefinition[]);
  });

  test("no placeholder survives into a rendered description", () => {
    const all = ALL_TOOLS.map((t) => t.name);
    for (const d of renderToolDefs(cfg(all), "qifei", "ren")) {
      expect(d.description).not.toContain("{{char}}");
      expect(d.description).not.toContain("{{user}}");
      expect(d.description).not.toContain("{{character_name}}");
    }
  });

  test("rendered output is never re-scanned", () => {
    const [def0] = renderToolDefs(cfg(["activity_heatmap"]), "{{user}}", "{{char}}");
    expect(def0?.description.startsWith("View {{char}}'s activity heatmap")).toBe(true);
    expect(def0?.description).not.toContain("{{user}}");
  });

  test("an empty allowlist renders nothing", () => {
    expect(renderToolDefs(cfg([]), "qifei", "ren")).toEqual([]);
  });
});

describe("subagentToolDefs", () => {
  test.each(Object.entries(fx.subagent_tool_defs))("%s", (_label, c) => {
    const actual = subagentToolDefs(subagentConfig, c.enabled, c.char_name, c.user_name);
    expect(actual).toEqual(c.defs as ToolDefinition[]);
  });

  test("sub-agent order follows UTF-8 bytes, not UTF-16 code units", () => {
    const names = ["\u{1F3B5}drum", "ﬀute"];
    const naive = [...names].sort();
    expect(naive).toEqual(["\u{1F3B5}drum", "ﬀute"]);

    const actual = subagentToolDefs(subagentConfig, names, "qifei", "ren").map((d) => d.name);
    expect(actual).toEqual(["ask_ﬀute", "ask_\u{1F3B5}drum"]);
    expect(actual).not.toEqual(naive.map((n) => `ask_${n}`));
  });

  test("the config map arrives unsorted", () => {
    const asGiven = [...subagentConfig.keys()];
    expect(asGiven).not.toEqual([...asGiven].sort());
  });

  test("a name that is a strict prefix of another sorts first", () => {
    const order = subagentToolDefs(
      subagentConfig,
      ["musicology", "music"],
      "qifei",
      "ren",
    ).map((d) => d.name);
    expect(order).toEqual(["ask_music", "ask_musicology"]);
  });

  test("{{character_name}} renders as its own variable", () => {
    const [archivist] = subagentToolDefs(subagentConfig, ["archivist"], "qifei", "ren");
    expect(archivist?.description).toBe("Search qifei's archive on behalf of ren.");
  });

  test("every synthesized tool takes one required string query", () => {
    const defs = subagentToolDefs(subagentConfig, ["music", "archivist"], "qifei", "ren");
    expect(defs.length).toBe(2);
    for (const d of defs) {
      expect(d.input_schema).toEqual({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language request for this sub-agent.",
          },
        },
        required: ["query"],
      });
    }
  });

  test("an empty config offers nothing however many names are enabled", () => {
    expect(subagentToolDefs(new Map(), ["music"], "qifei", "ren")).toEqual([]);
  });
});

describe("assembleToolSurface — group order", () => {
  test.each(Object.entries(fx.assemble_tool_surface))("%s", (_label, c) => {
    const actual = assembleToolSurface(
      c.input.static.map(def),
      c.input.subagent.map(def),
      c.input.mcp.map(def),
    );
    expect(actual.map((d) => d.name)).toEqual(c.order);
  });

  test("enabling a sub-agent leaves the static prefix untouched", () => {
    const statics = [def("read"), def("edit")];
    const mcp = [def("mcp__hue__on")];
    const without = assembleToolSurface(statics, [], mcp);
    const withSub = assembleToolSurface(statics, [def("ask_music")], mcp);

    expect(without.slice(0, 2)).toEqual(withSub.slice(0, 2));
    expect(withSub.map((d) => d.name)).toEqual([
      "read",
      "edit",
      "ask_music",
      "mcp__hue__on",
    ]);
  });

  test("does not mutate its inputs", () => {
    const statics = [def("read")];
    const subs = [def("ask_music")];
    const mcp = [def("mcp__hue__on")];
    assembleToolSurface(statics, subs, mcp);
    expect(statics.map((d) => d.name)).toEqual(["read"]);
    expect(subs.map((d) => d.name)).toEqual(["ask_music"]);
    expect(mcp.map((d) => d.name)).toEqual(["mcp__hue__on"]);
  });
});
