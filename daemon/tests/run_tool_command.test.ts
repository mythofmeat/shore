import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { CommandError } from "../src/commands/errors.ts";
import {
  coercePairs,
  nestedCalls,
  describeTool,
  parseRunToolArgs,
  resolveTool,
  runTool,
  type RunToolContext,
} from "../src/commands/run_tool.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { testTmp } from "./support/tmp.ts";

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    offset: { type: "integer" },
    recursive: { type: "boolean" },
    globs: { type: "array" },
  },
  required: ["path"],
};

interface World {
  config: LoadedConfig;
  ctx: RunToolContext;
  workspace: string;
}

async function world(
  options: {
    enabledTools?: string[];
    enabledSubagents?: string[];
    maxResultChars?: number;
    subagent?: (send: (m: ServerMessage) => void) => Promise<string>;
  } = {},
): Promise<World> {
  const root = await mkdtemp(testTmp("shore-run-tool-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  await mkdir(join(dirs.data, "ada"), { recursive: true });
  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "the tide came in\n");

  const app = defaultAppConfig();
  app.tools.enabled_tools = options.enabledTools ?? [];
  app.tools.enabled_subagents = options.enabledSubagents ?? [];
  if (options.maxResultChars !== undefined) {
    app.tools.max_result_chars = options.maxResultChars;
  }
  if (options.subagent !== undefined) {
    app.subagents.set("librarian", {
      description: "reads the shelves",
      prompt: "you are a librarian",
      tools: ["read"],
      model: undefined,
      max_iterations: undefined,
    });
  }

  const config: LoadedConfig = {
    app,
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };

  const runSubagentImpl = options.subagent;

  return {
    config,
    workspace,
    ctx: {
      config,
      dataDir: dirs.data,
      conversation: [],
      mcpTools: () => [],
      now: () => "2026-08-14T00:00:00Z",
      newMessageId: () => "m_1",
      toolUseId: () => "debug_root",
      tools: (_charName, turn) =>
        runSubagentImpl === undefined
          ? {}
          : {
              runSubagent: (_parent: ToolContext) => async () =>
                await runSubagentImpl(turn.send),
            },
    },
  };
}

describe("parseRunToolArgs", () => {
  test("a call with no tool name is refused", () => {
    expect(() => parseRunToolArgs({})).toThrow(CommandError);
    expect(() => parseRunToolArgs({ tool: "  " })).toThrow("needs a `tool` name");
  });

  test("input must be an object, not an array or a scalar", () => {
    expect(() => parseRunToolArgs({ tool: "read", input: ["notes.md"] })).toThrow(
      "must be a JSON object",
    );
    expect(() => parseRunToolArgs({ tool: "read", input: "notes.md" })).toThrow(
      "must be a JSON object",
    );
  });

  test("pairs arrive as strings and stay strings here", () => {
    const parsed = parseRunToolArgs({
      tool: "read",
      pairs: { path: "notes.md", offset: "3" },
      raw: true,
    });
    expect(parsed).toEqual({
      tool: "read",
      input: {},
      pairs: { path: "notes.md", offset: "3" },
      raw: true,
    });
  });

  test("a non-string pair names the key that was wrong", () => {
    expect(() => parseRunToolArgs({ tool: "read", pairs: { offset: 3 } })).toThrow(
      "`pairs.offset`",
    );
  });
});

describe("resolveTool", () => {
  test("an unknown name lists what does exist", async () => {
    const { config } = await world();
    expect(() => resolveTool("reed", config, [])).toThrow("no tool named 'reed'");
    expect(() => resolveTool("reed", config, [])).toThrow("read");
  });

  test("a built-in resolves with its schema and its enabled state", async () => {
    const { config } = await world({ enabledTools: ["read"] });
    const resolved = resolveTool("read", config, []);
    expect(resolved.kind).toBe("builtin");
    expect(resolved.enabled).toBe(true);
    expect(resolveTool("git", config, []).enabled).toBe(false);
  });

  test("ask_<name> resolves only for a configured sub-agent", async () => {
    const { config } = await world({
      enabledSubagents: ["librarian"],
      subagent: () => Promise.resolve("read the shelves"),
    });
    expect(resolveTool("ask_librarian", config, []).kind).toBe("subagent");
    expect(resolveTool("ask_librarian", config, []).enabled).toBe(true);
    expect(() => resolveTool("ask_ghost", config, [])).toThrow("no sub-agent named 'ghost'");
  });

  test("an mcp tool resolves from the connected servers", async () => {
    const { config } = await world();
    const tools = [{ full_name: "mcp__beets__query", input_schema: { type: "object" } }];
    expect(resolveTool("mcp__beets__query", config, tools).kind).toBe("mcp");
    expect(() => resolveTool("mcp__beets__nope", config, tools)).toThrow(
      "no MCP tool named 'mcp__beets__nope'",
    );
    expect(() => resolveTool("mcp__beets__query", config, [])).toThrow("No MCP tools");
  });
});

describe("describeTool", () => {
  test("a built-in comes back with the description the character is sent", async () => {
    const { ctx } = await world({ enabledTools: ["roll_dice"] });
    const out = describeTool("ada", ctx, { tool: "roll_dice" }) as Record<string, any>;

    expect(out["mode"]).toBe("tool_definition");
    expect(out["tool"]).toBe("roll_dice");
    expect(out["kind"]).toBe("builtin");
    expect(out["enabled"]).toBe(true);
    expect(typeof out["description"]).toBe("string");
    expect(String(out["description"]).length).toBeGreaterThan(0);
    expect(out["input_schema"]?.properties?.notation).toBeDefined();
  });

  test("template variables are rendered, so it is what the model reads", async () => {
    const { ctx } = await world({ enabledTools: ["activity_heatmap"] });
    const out = describeTool("ada", ctx, { tool: "activity_heatmap" }) as Record<string, any>;

    expect(String(out["description"])).not.toContain("{user}");
    expect(String(out["description"])).not.toContain("{char}");
  });

  test("a tool off the surface is described and flagged, not hidden", async () => {
    const { ctx } = await world({ enabledTools: [] });
    const out = describeTool("ada", ctx, { tool: "roll_dice" }) as Record<string, any>;

    expect(out["enabled"]).toBe(false);
    expect(String(out["description"]).length).toBeGreaterThan(0);
  });

  test("a sub-agent is described under its ask_ name", async () => {
    const { ctx } = await world({
      enabledSubagents: ["librarian"],
      subagent: () => Promise.resolve("read the shelves"),
    });
    const out = describeTool("ada", ctx, { tool: "ask_librarian" }) as Record<string, any>;

    expect(out["kind"]).toBe("subagent");
    expect(out["description"]).toBe("reads the shelves");
    expect(out["input_schema"]?.required).toEqual(["query"]);
  });

  test("a name nothing answers to is refused the same way running it is", async () => {
    const { ctx } = await world();
    expect(() => describeTool("ada", ctx, { tool: "reed" })).toThrow("no tool named 'reed'");
    expect(() => describeTool("ada", ctx, { tool: "ask_ghost" })).toThrow("ask_ghost does not exist");
  });
});

describe("coercePairs", () => {
  test("values take the type the tool declared", () => {
    expect(
      coercePairs(
        { path: "notes.md", offset: "3", recursive: "yes", globs: '["*.md"]' },
        READ_SCHEMA,
      ),
    ).toEqual({ path: "notes.md", offset: 3, recursive: true, globs: ["*.md"] });
  });

  test("an id-looking string stays a string when the schema says string", () => {
    expect(coercePairs({ path: "12345" }, READ_SCHEMA)).toEqual({ path: "12345" });
  });

  test("a key the schema does not declare is left alone", () => {
    expect(coercePairs({ mystery: "7" }, READ_SCHEMA)).toEqual({ mystery: "7" });
  });

  test("a value that cannot be the declared type says so by name", () => {
    expect(() => coercePairs({ offset: "soon" }, READ_SCHEMA)).toThrow("`offset` takes a number");
    expect(() => coercePairs({ recursive: "maybe" }, READ_SCHEMA)).toThrow(
      "`recursive` takes true or false",
    );
    expect(() => coercePairs({ globs: "*.md" }, READ_SCHEMA)).toThrow("--json");
  });
});

describe("runTool", () => {
  test("a read returns what the model would have seen, and records a diagnostic", async () => {
    const { ctx } = await world({ enabledTools: ["read"] });
    const result = (await runTool("ada", ctx, {
      tool: "read",
      pairs: { path: "notes.md" },
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["kind"]).toBe("builtin");
    expect(result["enabled"]).toBe(true);
    expect(result["truncated"]).toBe(false);
    expect(String(result["output"])).toContain("the tide came in");
    expect(result["raw"]).toBeNull();
  });

  test("a tool the model cannot reach still runs, and says it is off the surface", async () => {
    const { ctx } = await world({ enabledTools: [] });
    const result = (await runTool("ada", ctx, {
      tool: "read",
      pairs: { path: "notes.md" },
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["enabled"]).toBe(false);
  });

  test("a missing required argument is refused before the tool runs", async () => {
    const { ctx } = await world({ enabledTools: ["roll_dice"] });
    const result = (await runTool("ada", ctx, { tool: "roll_dice" })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(result["rejected"]).toBe(true);
    expect(String(result["output"])).toContain("`notation`");
    expect(String(result["output"])).toContain("Nothing was executed");
  });

  test("a result past the window is truncated like a real turn, and --raw keeps the rest", async () => {
    const { ctx, workspace } = await world({ enabledTools: ["read"], maxResultChars: 120 });
    await writeFile(join(workspace, "long.md"), "tide ".repeat(200));

    const windowed = (await runTool("ada", ctx, {
      tool: "read",
      pairs: { path: "long.md" },
    })) as Record<string, unknown>;
    expect(windowed["truncated"]).toBe(true);
    expect(String(windowed["output"])).toContain("tool_result truncated");
    expect([...String(windowed["output"])].length).toBeLessThan(
      windowed["result_chars"] as number,
    );
    expect(windowed["raw"]).toBeNull();

    const raw = (await runTool("ada", ctx, {
      tool: "read",
      pairs: { path: "long.md" },
      raw: true,
    })) as Record<string, unknown>;
    expect([...String(raw["raw"])].length).toBe(raw["result_chars"] as number);
  });

  test("a sub-agent run reports its own nested tool calls", async () => {
    const { ctx } = await world({
      enabledSubagents: ["librarian"],
      subagent: (send) => {
        send({
          type: "tool_call",
          tool_id: "t1",
          tool_name: "read",
          input: { path: "notes.md" },
          subagent: "librarian",
        });
        send({
          type: "tool_result",
          tool_id: "t1",
          tool_name: "read",
          output: "the tide came in",
          is_error: false,
          subagent: "librarian",
        });
        return Promise.resolve("the tide came in, and then it went out");
      },
    });

    const result = (await runTool("ada", ctx, {
      tool: "ask_librarian",
      pairs: { query: "what happened to the tide" },
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["kind"]).toBe("subagent");
    expect(String(result["output"])).toContain("went out");
    expect(result["calls"]).toEqual([
      {
        tool: "read",
        subagent: "librarian",
        ok: true,
        input: '{"path":"notes.md"}',
        output: "the tide came in",
      },
    ]);
  });

  test("ask_<name> without a query is refused by the sub-agent schema", async () => {
    const { ctx } = await world({
      enabledSubagents: ["librarian"],
      subagent: () => Promise.reject(new Error("the sub-agent should not have been reached")),
    });

    const result = (await runTool("ada", ctx, { tool: "ask_librarian" })) as Record<
      string,
      unknown
    >;
    expect(result["rejected"]).toBe(true);
    expect(String(result["output"])).toContain("`query`");
  });
});

describe("nestedCalls", () => {
  const frames: ServerMessage[] = [
    { type: "tool_call", tool_id: "debug_root", tool_name: "ask_librarian", input: {} },
    { type: "tool_call", tool_id: "t1", tool_name: "read", input: { path: "a.md" } },
    { type: "tool_result", tool_id: "t1", tool_name: "read", output: "body", is_error: false },
    { type: "tool_result", tool_id: "debug_root", tool_name: "ask_librarian", output: "done", is_error: false },
  ];

  test("the call being debugged is not listed as one of its own nested calls", () => {
    const calls = nestedCalls(frames, "debug_root", false);
    expect(calls.map((c) => c.tool)).toEqual(["read"]);
  });

  test("nested output is clipped unless raw was asked for", () => {
    const long = "x".repeat(2_000);
    const noisy: ServerMessage[] = [
      { type: "tool_call", tool_id: "t1", tool_name: "read", input: {} },
      { type: "tool_result", tool_id: "t1", tool_name: "read", output: long, is_error: false },
    ];
    expect(nestedCalls(noisy, "debug_root", false)[0]?.output.length).toBeLessThan(long.length);
    expect(nestedCalls(noisy, "debug_root", true)[0]?.output).toBe(long);
  });

  test("a failed nested call keeps its error flag", () => {
    const failed: ServerMessage[] = [
      { type: "tool_call", tool_id: "t1", tool_name: "read", input: {} },
      { type: "tool_result", tool_id: "t1", tool_name: "read", output: "no such file", is_error: true },
    ];
    expect(nestedCalls(failed, "debug_root", false)[0]?.ok).toBe(false);
  });
});
