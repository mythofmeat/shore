/**
 * Recorded cases for mcp.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";

import fixture from "./tools_fixtures/mcp.json" with { type: "json" };
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
  flattenResult,
  flattenText,
  type McpClient,
} from "../src/mcp/client.ts";

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

/** The generator's `new_for_test`, so the replay builds the same surface. */
function toolDef(server: string, tool: string): McpToolDef {
  return {
    full_name: `mcp__${server}__${tool}`,
    description: `${tool} tool`,
    input_schema: { type: "object" },
    server,
    tool,
  };
}

const registry = McpRegistry.fromTools([
  toolDef("hue", "set_light"),
  toolDef("hue", "get_light"),
  toolDef("alpha", "z"),
  toolDef("alpha", "a"),
  toolDef("multi__part", "tool__name"),
  toolDef("\u{1f3b5}drum", "play"),
  toolDef("\u{fb00}ute", "play"),
  toolDef("hue", "set"),
]);

describe("resolveUnder", () => {
  test.each(fx.resolve_under.map((c): [string, typeof c] => [JSON.stringify(c.input), c]))(
    "%s",
    (_l, c) => {
      expect(resolveUnder(c.input, PLUGINS)).toBe(c.output);
    },
  );

  // `path.join` normalizes and this must not: the difference decides which
  // directory a server is launched in.
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
      // The fixture spells an absent cwd as JSON null.
      expect(spec.transport.cwd ?? null).toBe((stdio["cwd"] ?? null) as string | null);
    } else {
      const http = expected["http"] as Record<string, unknown>;
      expect(spec?.transport.kind).toBe("http");
      if (spec?.transport.kind !== "http") throw new Error("unreachable");
      expect(spec.transport.url).toBe(http["url"] as string);
    }
  });

  // The command resolves against the *resolved* cwd, not the raw config value
  // and not the plugins directory.
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
  test("matches the Rust's order exactly", () => {
    expect(registry.allTools().map((t) => t.full_name)).toEqual(fx.sorted_full_names);
  });

  // Same trap as the sub-agent sort: JavaScript's default compares UTF-16 code
  // units, Rust's `String::cmp` compares UTF-8 bytes, and they disagree across
  // the BMP boundary.
  test("order follows UTF-8 bytes, not UTF-16 code units", () => {
    const names = registry.allTools().map((t) => t.full_name);
    const flute = names.indexOf("mcp__\u{fb00}ute__play");
    const drum = names.indexOf("mcp__\u{1f3b5}drum__play");
    expect(flute).toBeGreaterThan(-1);
    expect(drum).toBeGreaterThan(-1);
    expect(flute).toBeLessThan(drum);
    // A naive sort would put them the other way round.
    expect([...names].sort()).not.toEqual(names);
  });

  // `mcp__hue__set` is a strict prefix of `mcp__hue__set_light`, so a
  // comparator without its length tiebreak is observable here.
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

describe("call routing", () => {
  test("an unknown name is reported, not dispatched", async () => {
    await expect(registry.call("mcp__nope__x", {})).rejects.toThrow("not yet implemented");
  });

  // A registry built from tool defs alone has no clients, so even a known name
  // has nowhere to go — the same arm the Rust used for a missing client.
  test("a known name with no live client is reported the same way", async () => {
    await expect(registry.call("mcp__hue__set_light", {})).rejects.toThrow(
      "not yet implemented",
    );
  });

  // Both the config key and the server-side tool name may contain `__`, so the
  // full name is not parseable — only lookup-able. Splitting `mcp__a__b` on
  // `__` and taking [1] and [2] gets `multi`/`part` for a tool whose real
  // server is `multi__part` and whose real tool is `tool__name`, and routes to
  // nothing. This is why routing goes through the pinned list.
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
        /* nothing to close */
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

    await expect(wired.call("mcp__multi__part__tool__name", { a: 1 })).resolves.toBe("ok");
    // The *bare* server-side name reaches the client, not the namespaced one.
    expect(calls).toEqual([["tool__name", { a: 1 }]]);

    await expect(wired.call("mcp__hue__set_light", {})).resolves.toBe("ok");
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
  // MCP servers are third-party code and the daemon's environment holds every
  // provider API key. This is the guard that keeps them apart.
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

describe("result flattening", () => {
  test("structured content wins when present", () => {
    expect(
      flattenResult({ structuredContent: { ok: true }, content: [{ type: "text", text: "x" }] }),
    ).toEqual({ ok: true });
  });

  test("text blocks are joined with newlines", () => {
    expect(
      flattenResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  // Non-text blocks are dropped rather than described, so an image-only result
  // reads to the model as a tool that returned nothing.
  test("non-text blocks are dropped", () => {
    expect(
      flattenText({
        content: [
          { type: "image", data: "…", mimeType: "image/png" },
          { type: "text", text: "caption" },
        ],
      }),
    ).toBe("caption");
    expect(flattenText({ content: [{ type: "image", data: "…" }] })).toBe("");
  });

  // A block can carry a `text` field and still not be a text block — an
  // embedded `resource` is the common case. The discriminator is `type`, so a
  // filter that only checked for a string `text` would leak resource bodies
  // into the model's view of the result.
  test("a non-text block carrying text is still dropped", () => {
    expect(
      flattenText({
        content: [
          { type: "resource", text: "internal resource body", uri: "file:///x" },
          { type: "text", text: "the answer" },
        ],
      }),
    ).toBe("the answer");
  });

  test("a missing or non-array content is empty, not a throw", () => {
    expect(flattenText({})).toBe("");
    expect(flattenText({ content: "not an array" })).toBe("");
  });

  // `structuredContent` of `null` is still present, and the Rust's
  // `Option::Some(Value::Null)` returned it rather than falling through.
  test("a null structured content is still structured", () => {
    expect(flattenResult({ structuredContent: null, content: [] })).toBe(null);
  });
});
