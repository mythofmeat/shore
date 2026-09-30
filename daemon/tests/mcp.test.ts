import { describe, expect, test } from "bun:test";

import fixture from "./tools_captures/mcp.json" with { type: "json" };
import {
  McpRegistry,
  resolveCommand,
  resolveUnder,
  toSpec,
  toToolDef,
  type McpServerConfigView,
  type McpToolDef,
} from "../src/tools/mcp_registry.ts";
import {
  childEnvironment,
  flattenText,
  interpretResult,
  type McpClient,
} from "../src/mcp/client.ts";
import { outcomeOf } from "./support/outcome.ts";

const fx = fixture as unknown as {
  plugins_dir: string;
  resolve_under: { input: string; output: string }[];
  resolve_command: { input: string; output: string }[];
  to_spec: Record<string, Record<string, unknown>>;
  sorted_full_names: string[];
  filtering: Record<
    string,
    { patterns: string[]; tool_defs: string[]; names_matching: string[] }
  >;
  to_tool_def: { name: string; description: string; input_schema: Record<string, unknown> };
};

const PLUGINS = fx.plugins_dir;

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

describe("resolveUnder", () => {
  test.each(fx.resolve_under.map((c): [string, typeof c] => [JSON.stringify(c.input), c]))(
    "%s",
    (_l, c) => {
      expect(resolveUnder(c.input, PLUGINS)).toBe(c.output);
    },
  );

  test("`..` is left for the OS, not collapsed", () => {
    expect(resolveUnder("../sibling", PLUGINS)).toBe(`${PLUGINS}/../sibling`);
    expect(resolveUnder("a/../b", PLUGINS)).toBe(`${PLUGINS}/a/../b`);
  });

  test("absolute paths pass through untouched", () => {
    expect(resolveUnder("/absolute/path", PLUGINS)).toBe("/absolute/path");
    expect(resolveUnder("/", PLUGINS)).toBe("/");
  });

  test("`.` and empty segments are dropped", () => {
    expect(resolveUnder("./hue-mcp", PLUGINS)).toBe(`${PLUGINS}/hue-mcp`);
    expect(resolveUnder("a//b", PLUGINS)).toBe(`${PLUGINS}/a/b`);
    expect(resolveUnder("a/", PLUGINS)).toBe(`${PLUGINS}/a`);
  });

  test("a path with nothing left resolves to the base itself", () => {
    for (const raw of ["", ".", "./"]) {
      expect(resolveUnder(raw, PLUGINS)).toBe(PLUGINS);
    }
  });
});

describe("resolveCommand", () => {
  test.each(fx.resolve_command.map((c): [string, typeof c] => [JSON.stringify(c.input), c]))(
    "%s",
    (_l, c) => {
      expect(resolveCommand(c.input, "/data/plugins/hue")).toBe(c.output);
    },
  );

  test("a bare name stays a PATH lookup", () => {
    for (const bare of ["node", "npx", "python3", "node.js", "a b", "", "."]) {
      expect(resolveCommand(bare, "/base")).toBe(bare);
    }
  });

  test("anything path-shaped resolves against the base", () => {
    expect(resolveCommand("./venv/bin/python", "/base")).toBe("/base/venv/bin/python");
    expect(resolveCommand("venv/bin/python", "/base")).toBe("/base/venv/bin/python");
    expect(resolveCommand("/usr/bin/node", "/base")).toBe("/usr/bin/node");
  });
});

describe("toSpec", () => {
  const cfg = (
    command?: string,
    cwd?: string,
    url?: string,
  ): McpServerConfigView => ({
    ...(command === undefined ? {} : { command }),
    args: ["--serve"],
    env: { TOKEN: "x" },
    ...(cwd === undefined ? {} : { cwd }),
    ...(url === undefined ? {} : { url }),
  });

  const cases: [string, McpServerConfigView][] = [
    ["stdio_bare_command_no_cwd", cfg("node")],
    ["stdio_bare_command_with_cwd", cfg("node", "hue-mcp")],
    ["stdio_relative_command_with_cwd", cfg("./bin/server", "hue-mcp")],
    ["stdio_relative_command_no_cwd", cfg("./bin/server")],
    ["stdio_absolute_command", cfg("/usr/bin/node")],
    ["stdio_absolute_cwd", cfg("node", "/srv/hue")],
    ["http", cfg(undefined, undefined, "https://example.com/mcp")],
    ["both_command_and_url", cfg("node", undefined, "https://example.com/mcp")],
    ["neither", cfg()],
  ];

  test.each(cases)("%s", (label, c) => {
    const expected = fx.to_spec[label] as Record<string, unknown>;
    const spec = toSpec("hue", c, PLUGINS);

    if (expected["none"] === true) {
      expect(spec).toBeUndefined();
      return;
    }
    expect(spec).toBeDefined();
    expect(spec?.name).toBe(expected["name"] as string);

    const stdio = expected["stdio"] as Record<string, unknown> | undefined;
    if (stdio !== undefined) {
      expect(spec?.transport.kind).toBe("stdio");
      if (spec?.transport.kind !== "stdio") throw new Error("unreachable");
      expect(spec.transport.command).toBe(stdio["command"] as string);
      expect(spec.transport.args).toEqual(stdio["args"] as string[]);
      expect(spec.transport.env).toEqual(stdio["env"] as Record<string, string>);
      expect(spec.transport.cwd ?? null).toBe((stdio["cwd"] ?? null) as string | null);
    } else {
      const http = expected["http"] as Record<string, unknown>;
      expect(spec?.transport.kind).toBe("http");
      if (spec?.transport.kind !== "http") throw new Error("unreachable");
      expect(spec.transport.url).toBe(http["url"] as string);
    }
  });

  test("a relative command follows the resolved cwd", () => {
    const spec = toSpec("hue", cfg("./bin/server", "hue-mcp"), PLUGINS);
    if (spec?.transport.kind !== "stdio") throw new Error("expected stdio");
    expect(spec.transport.command).toBe(`${PLUGINS}/hue-mcp/bin/server`);
    expect(spec.transport.cwd).toBe(`${PLUGINS}/hue-mcp`);
  });

  test("command wins over url when both are set", () => {
    const spec = toSpec("hue", cfg("node", undefined, "https://x/mcp"), PLUGINS);
    expect(spec?.transport.kind).toBe("stdio");
  });
});

describe("the pinned sort", () => {
  test("lists every tool it knows, in byte order", () => {
    expect(registry.allTools().map((t) => t.full_name)).toEqual(fx.sorted_full_names);
  });

  test("order follows UTF-8 bytes, not UTF-16 code units", () => {
    const names = registry.allTools().map((t) => t.full_name);
    const flute = names.indexOf("mcp__\u{FB00}ute__play");
    const drum = names.indexOf("mcp__\u{1F3B5}drum__play");
    expect(flute).toBeGreaterThan(-1);
    expect(drum).toBeGreaterThan(-1);
    expect(flute).toBeLessThan(drum);
    expect([...names].sort()).not.toEqual(names);
  });

  test("a strict prefix sorts before the longer name", () => {
    const names = registry.allTools().map((t) => t.full_name);
    expect(names.indexOf("mcp__hue__set")).toBeLessThan(names.indexOf("mcp__hue__set_light"));
  });
});

describe("filtering", () => {
  test.each(Object.entries(fx.filtering))("%s", (_label, c) => {
    expect(registry.toolDefsFiltered(c.patterns).map((d) => d.name)).toEqual(c.tool_defs);
    expect(registry.namesMatching(c.patterns).map((t) => t.full_name)).toEqual(
      c.names_matching,
    );
  });

  test("pattern order does not reorder the surface", () => {
    const a = registry.toolDefsFiltered(["mcp__hue__set_light", "mcp__alpha__a"]);
    const b = registry.toolDefsFiltered(["mcp__alpha__a", "mcp__hue__set_light"]);
    expect(a.map((d) => d.name)).toEqual(b.map((d) => d.name));
  });

  test("overlapping patterns offer a tool once", () => {
    const names = registry
      .toolDefsFiltered(["mcp__hue__*", "mcp__hue__set_light", "*"])
      .map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no patterns offers nothing", () => {
    expect(registry.toolDefsFiltered([])).toEqual([]);
  });
});

describe("toToolDef", () => {
  test("renders the provider-neutral shape", () => {
    expect(toToolDef(toolDef("hue", "set_light"))).toEqual({
      name: fx.to_tool_def.name,
      description: fx.to_tool_def.description,
      input_schema: fx.to_tool_def.input_schema,
    });
  });
});

describe("MCP schema registration", () => {
  test("an invalid tool is omitted without hiding valid tools from the same server", () => {
    const valid = toolDef("mixed", "valid");
    const invalid = {
      ...toolDef("mixed", "invalid"),
      input_schema: { type: "object", unsupportedFutureKeyword: true },
    };

    const mixed = McpRegistry.fromTools([valid, invalid]);
    expect(mixed.allTools().map((tool) => tool.full_name)).toEqual([valid.full_name]);
  });

  test("a duplicate tool cannot replace the first registered contract", () => {
    const first = toolDef("duplicate", "query");
    const duplicate = {
      ...first,
      input_schema: { type: "object", required: ["different"] },
    };
    const tools = McpRegistry.fromTools([first, duplicate]).allTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.input_schema).toBe(first.input_schema);
  });
});

describe("call routing", () => {
  test("an unknown name is reported, not dispatched", async () => {
    expect(await outcomeOf(registry.call("mcp__nope__x", {}))).toThrow("not yet implemented");
  });

  test("a known name with no live client is reported as unavailable", async () => {
    expect(await outcomeOf(registry.call("mcp__hue__set_light", {}))).toThrow("is unavailable");
  });

  test("a name with `__` inside both halves routes to the right tool", async () => {
    const calls: [string, unknown][] = [];
    const fake = {
      async call(tool: string, args: unknown) {
        calls.push([tool, args]);
        return "ok";
      },
      async listTools() {
        return [];
      },
      async shutdown() {
      },
      get server() {
        return "multi__part";
      },
    } as unknown as McpClient;

    const wired = McpRegistry.fromTools(
      [toolDef("multi__part", "tool__name"), toolDef("hue", "set_light")],
      new Map([
        ["multi__part", fake],
        ["hue", fake],
      ]),
    );

    expect(await wired.call("mcp__multi__part__tool__name", { a: 1 })).toBe("ok");
    expect(calls).toEqual([["tool__name", { a: 1 }]]);

    expect(await wired.call("mcp__hue__set_light", {})).toBe("ok");
    expect(calls[1]).toEqual(["set_light", {}]);
  });
});

describe("matchesConfig", () => {
  const source = { hue: { command: "node", args: ["--serve"], env: { TOKEN: "x" } } };
  const built = McpRegistry.fromTools([], new Map(), source);

  test("an unchanged section matches", () => {
    expect(built.matchesConfig({ ...source })).toBe(true);
  });

  test("a changed section does not", () => {
    expect(built.matchesConfig({ hue: { command: "node", args: [] } })).toBe(false);
    expect(built.matchesConfig({})).toBe(false);
    expect(
      built.matchesConfig({ ...source, other: { url: "https://x/mcp" } }),
    ).toBe(false);
  });

  test("key order is not a change", () => {
    const two = { a: { command: "x" }, b: { command: "y" } };
    const reg = McpRegistry.fromTools([], new Map(), two);
    expect(reg.matchesConfig({ b: { command: "y" }, a: { command: "x" } })).toBe(true);
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

describe("result interpretation", () => {
  test("structured content wins, and its mirrored text is not repeated", () => {
    const mirrored = interpretResult({
      structuredContent: { ok: true },
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });
    expect(mirrored.value).toEqual({ ok: true });
    expect(mirrored.extra).toEqual([]);
    expect(mirrored.media).toEqual([]);
  });

  test("structured content keeps text that says something different", () => {
    const both = interpretResult({
      structuredContent: { ok: true },
      content: [{ type: "text", text: "the deploy finished" }],
    });
    expect(both.value).toEqual({ ok: true });
    expect(both.extra).toEqual(["the deploy finished"]);
  });

  test("a mirror with reordered keys is still recognised as a mirror", () => {
    const reordered = interpretResult({
      structuredContent: { a: 1, b: 2 },
      content: [{ type: "text", text: '{"b":2,"a":1}' }],
    });
    expect(reordered.extra).toEqual([]);
  });

  test("text blocks are joined with newlines", () => {
    expect(
      interpretResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }).value,
    ).toBe("a\nb");
  });

  test("an image-only result is media, never an empty success", () => {
    const result = interpretResult({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
    expect(result.value).toBe("");
    expect(result.media).toEqual([
      { mime_type: "image/png", data: "aGVsbG8=", label: "image/png, 5 bytes" },
    ]);
    expect(flattenText({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }))
      .toBe("[image/png, 5 bytes returned, not included here]");
  });

  test("mixed text and image keeps both", () => {
    const result = interpretResult({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "caption" },
      ],
    });
    expect(result.value).toBe("caption");
    expect(result.media).toHaveLength(1);
  });

  test("an unsupported image format is an explicit omission", () => {
    const result = interpretResult({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/tiff" }],
    });
    expect(result.media).toEqual([]);
    expect(result.extra).toEqual(["[image omitted: image/tiff is not a supported format]"]);
  });

  test("audio is named and sized rather than dropped", () => {
    const result = interpretResult({
      content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
    });
    expect(result.media).toEqual([]);
    expect(result.extra).toEqual([
      "[audio omitted: audio/wav, 5 bytes \u2014 shore cannot send audio to a model]",
    ]);
  });

  test("an embedded text resource is inlined", () => {
    const nested = interpretResult({
      content: [
        { type: "resource", resource: { uri: "file:///x", text: "internal resource body" } },
        { type: "text", text: "the answer" },
      ],
    });
    expect(nested.value).toBe("the answer");
    expect(nested.extra).toEqual(["[resource file:///x]\ninternal resource body"]);
  });

  test("a flat resource shape is inlined too", () => {
    expect(
      interpretResult({
        content: [{ type: "resource", text: "internal resource body", uri: "file:///x" }],
      }).extra,
    ).toEqual(["[resource file:///x]\ninternal resource body"]);
  });

  test("an embedded image resource becomes media", () => {
    const result = interpretResult({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///shot.png", mimeType: "image/png", blob: "aGVsbG8=" },
        },
      ],
    });
    expect(result.media).toEqual([
      {
        mime_type: "image/png",
        data: "aGVsbG8=",
        label: "file:///shot.png (image/png, 5 bytes)",
      },
    ]);
  });

  test("a binary resource shore cannot render is named, not dropped", () => {
    expect(
      interpretResult({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///a.zip", mimeType: "application/zip", blob: "aGVsbG8=" },
          },
        ],
      }).extra,
    ).toEqual([
      "[resource file:///a.zip omitted: application/zip, 5 bytes \u2014 shore cannot render it]",
    ]);
  });

  test("a resource link is described", () => {
    expect(
      interpretResult({
        content: [
          { type: "resource_link", uri: "file:///r", name: "notes", mimeType: "text/plain" },
        ],
      }).extra,
    ).toEqual(["[resource link: notes: file:///r (text/plain)]"]);
  });

  test("an unknown block type is reported rather than silently dropped", () => {
    expect(
      interpretResult({ content: [{ type: "hologram", frames: 3 }] }).extra,
    ).toEqual(["[hologram content omitted: shore cannot render it]"]);
  });

  test("a missing or non-array content is empty, not a throw", () => {
    expect(flattenText({})).toBe("");
    expect(flattenText({ content: "not an array" })).toBe("");
  });

  test("a null structured content is still structured", () => {
    expect(interpretResult({ structuredContent: null, content: [] }).value).toBe(null);
  });
});
