import { required } from "../src/util/required.ts";

import { renderTemplate } from "../src/engine/prompt.ts";
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
  templateVars,
  toolPatternMatches,
  type SubagentConfigView,
  type ToolsConfigView,
} from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/llm/types.ts";
interface FixtureToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const fx = fixture as unknown as {
  tool_names: string[];
  available_tools: Record<
    string,
    { enabled_tools: string[]; offered: string[]; any_enabled: boolean }
  >;
  render_tool_defs: Record<string, { char_name: string; user_name: string; names: string[] }>;
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
  test("offers exactly these tools, in this order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(fx.tool_names);
  });

  test.each(ALL_TOOLS.map((t): [string, (typeof ALL_TOOLS)[number]] => [t.name, t]))(
    "%s is a definition a model can act on",
    (name, tool) => {
      expect(tool.description.length, `${name} says what it is for`).toBeGreaterThan(0);
      expect(tool.description.endsWith("\n"), `${name} carries no trailing newline`).toBe(false);
      expect(["web", "other"], `${name} is filed under a known category`).toContain(tool.category);

      const schema = tool.parameters as {
        type?: string;
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };
      expect(schema.type, `${name} takes an object`).toBe("object");
      const properties = schema.properties ?? {};
      for (const [argument, spec] of Object.entries(properties)) {
        expect(typeof spec.type, `${name}.${argument} says what type it is`).toBe("string");
        expect(
          (spec.description ?? "").length,
          `${name}.${argument} says what it is for`,
        ).toBeGreaterThan(0);
      }
      for (const argument of schema.required ?? []) {
        expect(
          Object.keys(properties),
          `${name} cannot require ${argument} without declaring it`,
        ).toContain(argument);
      }
    },
  );

  test("a description asks only for names the renderer knows how to fill in", () => {
    const known = new Set(templateVars("c", "u").keys());
    for (const tool of ALL_TOOLS) {
      for (const [, placeholder] of tool.description.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(known, `${tool.name} asks for {{${String(placeholder)}}}`).toContain(
          String(placeholder),
        );
      }
    }
  });

  test("names are unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(["write", "list_files", "check_time", "exec", "memory_search"])(
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

  test("set_next_wake is offered only when the allowlist names it", () => {
    expect(availableTools(cfg(["bash"])).map((t) => t.name)).toEqual(["bash"]);
    expect(availableTools(cfg(["bash", "set_next_wake"])).map((t) => t.name)).toEqual([
      "bash",
      "set_next_wake",
    ]);
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
  test.each(Object.entries(fx.render_tool_defs))("%s", (label, c) => {
    const actual = renderToolDefs(cfg(c.names), c.char_name, c.user_name);
    const vars = templateVars(c.char_name, c.user_name);

    expect(
      actual.map((d) => d.name),
      `${label}: renders the tools that are enabled, in the order the registry lists them`,
    ).toEqual(ALL_TOOLS.filter((t) => c.names.includes(t.name)).map((t) => t.name));

    for (const rendered of actual) {
      const source = required(ALL_TOOLS.find((t) => t.name === rendered.name));
      expect(
        rendered.description,
        `${label}: ${rendered.name}'s description is its template with the names filled in`,
      ).toBe(renderTemplate(source.description, vars));
      expect(
        rendered.input_schema,
        `${label}: ${rendered.name}'s arguments are the registry's, untouched`,
      ).toEqual(source.parameters);
    }
  });

  test("no placeholder survives into a rendered description", () => {
    const all = ALL_TOOLS.map((t) => t.name);
    for (const d of renderToolDefs(cfg(all), "heidi", "eve")) {
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
    expect(renderToolDefs(cfg([]), "heidi", "eve")).toEqual([]);
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

    const actual = subagentToolDefs(subagentConfig, names, "heidi", "eve").map((d) => d.name);
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
      "heidi",
      "eve",
    ).map((d) => d.name);
    expect(order).toEqual(["ask_music", "ask_musicology"]);
  });

  test("{{character_name}} renders as its own variable", () => {
    const [archivist] = subagentToolDefs(subagentConfig, ["archivist"], "heidi", "eve");
    expect(archivist?.description).toBe("Search heidi's archive on behalf of eve.");
  });

  test("every synthesized tool takes one required string query", () => {
    const defs = subagentToolDefs(subagentConfig, ["music", "archivist"], "heidi", "eve");
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
    expect(subagentToolDefs(new Map(), ["music"], "heidi", "eve")).toEqual([]);
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
