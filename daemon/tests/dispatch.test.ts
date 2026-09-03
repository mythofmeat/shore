import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

import fixture from "./tools_captures/dispatch.json" with { type: "json" };

import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  annotateDeferredEdit,
  applyDefaultSearchMode,
  deferEditTo,
  dispatchTool,
  dispatchWithinDeadline,
  resultCharsFor,
  timeoutFor,
  toolLimitsFrom,
  truncateToolResult,
  windowToolResult,
  type RetrievalMode,
  type ToolContext,
  type ToolLimitsView,
} from "../src/tools/dispatch.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { defaultToolsConfig, type SubagentConfig } from "../src/config/app.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/tools/workspace.ts";
import type { Embedder } from "../src/llm/embed.ts";
import { requestBody, requestUrl } from "./support/fetch.ts";

afterAll(restoreTestEnv);

const STUB_EMBEDDER: Embedder = {
  embed: async () => [],
  modelId: "stub",
  dimensions: undefined,
};

function bareContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    imageDir: "/tmp/test_images",
    workspaceDir: "",
    characterDataDir: "",
    historyDbPath: "/tmp/history.db",
    characterName: "",
    configDir: "",
    searchConfig: {
      api_key_env: "TAVILY_API_KEY",
      result_limit: 5,
      search_depth: "basic",
      include_answer: true,
    },
    retrievalConfig: DEFAULT_RETRIEVAL_CONFIG,
    retrievalMode: "auto",
    ...over,
  };
}

async function route(name: string, input: unknown, ctx = bareContext()): Promise<unknown> {
  try {
    return { ok: await dispatchTool(name, input, ctx) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe("routing", () => {
  const routing = fixture.routing as Record<string, unknown>;

  for (const [name, expected] of Object.entries(routing)) {
    if (name.includes(" WITH ")) continue;
    test(`dispatch ${JSON.stringify(name)}`, async () => {
      expect(await route(name, {})).toEqual(expected);
    });
  }

  test("ask_<name> with a string query reaches the runtime", async () => {
    expect(await route("ask_researcher", { query: "hello" })).toEqual(
      routing["ask_researcher WITH query"],
    );
  });

  test("ask_<name> with a non-string query is the same failure as a missing one", async () => {
    expect(await route("ask_researcher", { query: 5 })).toEqual(
      routing["ask_researcher WITH numeric query"],
    );
  });
});

describe("routing, wired", () => {
  test("ask_<name> hands the bare agent name and query to the runtime", async () => {
    const seen: unknown[] = [];
    const ctx = bareContext({
      runSubagent: async (agent, query) => {
        seen.push([agent, query]);
        return { answer: "ok" };
      },
    });
    expect(await dispatchTool("ask_deep_research", { query: "why" }, ctx)).toEqual({
      answer: "ok",
    });
    expect(seen).toEqual([["deep_research", "why"]]);
  });

  test("mcp__ hands the *full* namespaced name through, not a split", async () => {
    const seen: unknown[] = [];
    const ctx = bareContext({
      mcpCall: async (name, input) => {
        seen.push([name, input]);
        return "lit";
      },
    });
    expect(await dispatchTool("mcp__multi__part__set__light", { on: true }, ctx)).toBe("lit");
    expect(seen).toEqual([["mcp__multi__part__set__light", { on: true }]]);
  });

  test("a name merely containing mcp__ does not route to MCP", async () => {
    let called = false;
    const ctx = bareContext({
      mcpCall: async () => {
        called = true;
        return "routed";
      },
    });
    expect(await route("not_mcp__hue__x", {}, ctx)).toEqual(
      (fixture.routing as Record<string, unknown>)["not_mcp__hue__x"],
    );
    expect(called).toBe(false);
  });

  test("a name merely containing ask_ does not route to a sub-agent", async () => {
    let called = false;
    const ctx = bareContext({
      runSubagent: async () => {
        called = true;
        return "routed";
      },
    });
    expect(await route("x_ask_researcher", { query: "q" }, ctx)).toEqual(
      (fixture.routing as Record<string, unknown>)["x_ask_researcher"],
    );
    expect(called).toBe(false);
  });

  test("a null input reads as an empty object, the way Value::Null did", async () => {
    expect(await route("roll_dice", null)).toEqual(
      (fixture.routing as Record<string, unknown>)["roll_dice"],
    );
    expect(await route("web_search", undefined)).toEqual(
      (fixture.routing as Record<string, unknown>)["web_search"],
    );
  });

  test("mcp receives the caller's input verbatim, not the coerced one", async () => {
    const seen: unknown[] = [];
    const ctx = bareContext({
      mcpCall: async (_name, input) => {
        seen.push(input);
        return "ok";
      },
    });
    await dispatchTool("mcp__x__y", null, ctx);
    expect(seen).toEqual([null]);
  });

  test("set_next_wake reaches the heartbeat hook when one is wired", async () => {
    const ctx = bareContext({ scheduleNextWake: async (input) => ({ echoed: input }) });
    expect(await dispatchTool("set_next_wake", { minutes: 30 }, ctx)).toEqual({
      echoed: { minutes: 30 },
    });
  });
});

describe("search mode defaulting", () => {
  type ModeRow = {
    mode?: string;
    embedder?: boolean;
    index_path?: boolean;
    preset?: unknown;
    applied: unknown;
  };

  for (const [i, row] of (fixture.search_mode as ModeRow[]).entries()) {
    test(`case ${i}: ${JSON.stringify(row.mode ?? row.preset)}`, () => {
      const input = structuredClone("preset" in row ? row.preset : {});
      const mode = (row.mode?.toLowerCase() ?? "auto") as RetrievalMode;
      applyDefaultSearchMode(input, mode, row.embedder ?? false, row.index_path ?? false);
      expect(input).toEqual(row.applied);
    });
  }

  test("an explicit null mode is kept, not treated as absent", () => {
    const input: Record<string, unknown> = { mode: null };
    applyDefaultSearchMode(input, "hybrid", true, true);
    expect(input["mode"]).toBeNull();
  });

  test("an embedder without an index path stays lexical under auto", () => {
    const input: Record<string, unknown> = {};
    applyDefaultSearchMode(input, "auto", true, false);
    expect(input["mode"]).toBe("lexical");
  });

  test("an index path without an embedder stays lexical under auto", () => {
    const input: Record<string, unknown> = {};
    applyDefaultSearchMode(input, "auto", false, true);
    expect(input["mode"]).toBe("lexical");
  });
});

describe("search semantics bundling", () => {
  async function workspace(): Promise<string> {
    const dir = `/tmp/claude-0/dispatch-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Bun.write(`${dir}/notes.md`, "the quick brown fox\n");
    return dir;
  }

  test("an embedder with no index path is not semantics", async () => {
    const ctx = bareContext({
      workspaceDir: await workspace(),
      embedder: STUB_EMBEDDER,
      retrievalMode: "hybrid",
    });
    const result = (await dispatchTool("search", { query: "fox" }, ctx)) as Record<string, unknown>;
    expect(result["mode"]).toBe("lexical");
    expect(result["semantic_unavailable"]).toBe("embedder not configured");
  });

  test("an index path with no embedder is not semantics either", async () => {
    const ctx = bareContext({
      workspaceDir: await workspace(),
      memoryIndexPath: "/nonexistent/index.json",
      retrievalMode: "hybrid",
    });
    const result = (await dispatchTool("search", { query: "fox" }, ctx)) as Record<string, unknown>;
    expect(result["semantic_unavailable"]).toBe("embedder not configured");
  });

  test("an unconfigured workspace fails the same way the fixture recorded", async () => {
    expect(await route("search", {})).toEqual(
      (fixture.routing as Record<string, unknown>)["search"],
    );
  });

  test("the configured retrieval mode reaches the request", async () => {
    const ctx = bareContext({ workspaceDir: await workspace(), retrievalMode: "lexical" });
    const result = (await dispatchTool("search", { query: "fox" }, ctx)) as Record<string, unknown>;
    expect("semantic_unavailable" in result).toBe(false);
  });

  test("the context's retrieval config reaches the scan, not the module default", async () => {
    const ctx = bareContext({
      workspaceDir: await workspace(),
      retrievalMode: "lexical",
      retrievalConfig: { ...DEFAULT_RETRIEVAL_CONFIG, maxFileBytes: 4 },
    });
    const result = (await dispatchTool("search", { query: "fox" }, ctx)) as Record<string, unknown>;
    expect(result["count"]).toBe(0);
    expect(result["skipped_binary_or_large"]).toBe(1);
  });
});

describe("context fields reach their handler argument", () => {
  test("model_history is scoped to the context's character", async () => {
    const seen: string[] = [];
    const ctx = bareContext({
      characterName: "juniper",
      modelHistoryQuery: async (character) => {
        seen.push(character);
        return [];
      },
    });
    await dispatchTool("model_history", {}, ctx);
    expect(seen).toEqual(["juniper"]);
  });

  test("delete trashes under the context's character data directory", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspaceDir = `/tmp/claude-0/dispatch-del-ws-${stamp}`;
    const characterDataDir = `/tmp/claude-0/dispatch-del-char-${stamp}/juniper`;
    await Bun.write(`${workspaceDir}/doomed.md`, "bye\n");

    const ctx = bareContext({ workspaceDir, characterDataDir });
    const result = (await dispatchTool("delete", { path: "doomed.md" }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result["deleted"]).toBe(true);
    expect(String(result["trashed_to"])).toStartWith("juniper/trash/");
  });

  test("generate_image writes into the context's image directory", async () => {
    const imageDir = `/tmp/claude-0/dispatch-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ctx = bareContext({
      imageDir,
      imageGenConfig: {
        provider: "openai",
        model_id: "gpt-image-1",
        api_key: "k",
        size: "1024x1024",
      },
      imageGenerator: async () => ({
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        revised_prompt: "a dot",
        timing: { total_ms: 1 },
      }),
    });

    const result = (await dispatchTool("generate_image", { prompt: "a dot" }, ctx)) as Record<
      string,
      unknown
    >;
    expect(String(result["path"])).toStartWith(`${imageDir}/`);
    expect(await Bun.file(String(result["path"])).exists()).toBe(true);
  });

  test("web_search reads the context's search config", async () => {
    const seen: unknown[] = [];
    const ctx = bareContext({
      searchConfig: {
        api_key_env: "DISPATCH_TEST_KEY",
        result_limit: 7,
        search_depth: "advanced",
        include_answer: false,
      },
      fetchImpl: async (_input, init) => {
        seen.push(JSON.parse(requestBody(init)));
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    setTestEnv("DISPATCH_TEST_KEY", "secret");
    try {
      await dispatchTool("web_search", { query: "x" }, ctx);
    } finally {
      delete process.env["DISPATCH_TEST_KEY"];
    }
    expect(seen).toEqual([
      {
        api_key: "secret",
        query: "x",
        max_results: 7,
        search_depth: "advanced",
        include_answer: false,
      },
    ]);
  });

  test("fetch_url uses the context's fetch", async () => {
    const seen: string[] = [];
    const ctx = bareContext({
      fetchImpl: async (input) => {
        seen.push(requestUrl(input));
        return new Response("<p>hi</p>", { headers: { "content-type": "text/html" } });
      },
      lookupImpl: async () => ["93.184.216.34"],
    });
    const result = (await dispatchTool(
      "fetch_url",
      { url: "https://example.invalid/x" },
      ctx,
    )) as Record<string, unknown>;
    expect(seen).toEqual(["https://example.invalid/x"]);
    expect(result["content"]).toBe("hi");
  });

  test("git commits as the context's character", async () => {
    const dir = `/tmp/claude-0/dispatch-git-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Bun.write(`${dir}/a.md`, "hello\n");
    const ctx = bareContext({ workspaceDir: dir, characterName: "Juniper Vale" });

    await dispatchTool("git", { subcommand: "add", args: ["a.md"] }, ctx);
    await dispatchTool("git", { subcommand: "commit", args: ["-m", "first"] }, ctx);
    const log = (await dispatchTool(
      "git",
      { subcommand: "log", args: ["--format=%an <%ae>", "-1"] },
      ctx,
    )) as Record<string, unknown>;

    expect(String(log["stdout"])).toContain("Juniper Vale <juniper-vale@shore.local>");
  });
});

describe("deferred edit annotation", () => {
  type DeferredRow = { path: string; result: unknown };

  for (const [i, row] of (fixture.deferred_edit as DeferredRow[]).entries()) {
    test(`case ${i}: ${JSON.stringify(row.path)}`, async () => {
      const result: unknown =
        typeof row.result === "object" && row.result !== null
          ? { status: "ok", path: row.path }
          : "done";
      await annotateDeferredEdit(row.path, result, {});
      expect(result).toEqual(row.result);
    });
  }

  test("key order matches, because the model reads the serialized text", async () => {
    const result: Record<string, unknown> = { status: "ok" };
    await annotateDeferredEdit("SOUL.md", result, {});
    expect(Object.keys(result)).toEqual([
      "status",
      "prompt_visible_file",
      "protected_file",
      "deferred_until_compaction",
      "deferred_path",
      "prompt_reload_required",
    ]);
  });

  test("a non-protected prompt-visible file omits protected_file entirely", async () => {
    const result: Record<string, unknown> = {};
    await annotateDeferredEdit("MEMORY.md", result, {});
    expect("protected_file" in result).toBe(false);
  });

  test("deferEdit is called with the caller's spelling, before the annotation", async () => {
    const seen: string[] = [];
    const result: Record<string, unknown> = {};
    await annotateDeferredEdit("./SOUL.md", result, {
      deferEdit: (p) => {
        expect(result["deferred_until_compaction"]).toBeUndefined();
        seen.push(p);
      },
    });
    expect(seen).toEqual(["./SOUL.md"]);
    expect(result["deferred_path"]).toBe("SOUL.md");
  });

  test("deferEditTo passes the character directory and the caller's path", async () => {
    const seen: [string, string][] = [];
    const defer = deferEditTo("/data/juniper", async (dir, path) => {
      seen.push([dir, path]);
    });
    await defer("SOUL.md");
    expect(seen).toEqual([["/data/juniper", "SOUL.md"]]);
  });

  test("a failed queue write does not fail the tool whose write succeeded", async () => {
    const defer = deferEditTo("/data/juniper", async () => {
      throw new Error("disk full");
    });
    expect(defer("SOUL.md")).resolves.toBeUndefined();
  });

  test("a path that is not prompt-visible never reaches deferEdit", async () => {
    let called = false;
    await annotateDeferredEdit(
      "notes/scratch.md",
      {},
      {
        deferEdit: () => {
          called = true;
        },
      },
    );
    expect(called).toBe(false);
  });

  test("the edit arm annotates through dispatch", async () => {
    const dir = `/tmp/claude-0/dispatch-edit-${Date.now()}`;
    await Bun.write(`${dir}/MEMORY.md`, "before\n");
    const ctx = bareContext({ workspaceDir: dir });
    const result = (await dispatchTool(
      "edit",
      { path: "MEMORY.md", content: "after\n" },
      ctx,
    )) as Record<string, unknown>;
    expect(result["prompt_visible_file"]).toBe(true);
    expect(result["deferred_path"]).toBe("MEMORY.md");
    expect(await Bun.file(`${dir}/MEMORY.md`).text()).toBe("after\n");
  });

  test("an ordinary workspace file is written without annotation", async () => {
    const dir = `/tmp/claude-0/dispatch-edit-plain-${Date.now()}`;
    await Bun.write(`${dir}/notes.md`, "before\n");
    const ctx = bareContext({ workspaceDir: dir });
    const result = (await dispatchTool(
      "edit",
      { path: "notes.md", content: "after\n" },
      ctx,
    )) as Record<string, unknown>;
    expect("prompt_visible_file" in result).toBe(false);
  });
});

describe("result truncation", () => {
  type TruncRow = { input: string; max_chars: number; output: string };

  for (const [i, row] of (fixture.truncate as TruncRow[]).entries()) {
    const truncates = row.output.includes("[tool_result truncated");
    test(`case ${i}: ${JSON.stringify(row.input)} @ ${row.max_chars}`, () => {
      const got = windowToolResult(row.input, row.max_chars);
      if (!truncates) {
        expect(got.output).toBe(row.output);
        expect(got.truncated).toBe(false);
        return;
      }
      expect(got.truncated).toBe(true);
      expect(got.originalChars).toBe(Array.from(row.input).length);
      expect(got.headChars + got.tailChars).toBe(row.max_chars);
      expect(got.output.startsWith(Array.from(row.input).slice(0, got.headChars).join(""))).toBe(
        true,
      );
      expect(got.output).toContain(`${String(Array.from(row.input).length)} characters`);
      expect(got.output).toContain("Narrow the call");
    });
  }

  test("the tail is kept, not only the head", () => {
    const got = windowToolResult("START" + "x".repeat(200) + "THE-ERROR-IS-HERE", 20);
    expect(got.output).toContain("START");
    expect(got.output).toContain("IS-HERE");
    expect(got.headChars + got.tailChars).toBe(20);
  });

  test("counts code points, not UTF-16 units", () => {
    const got = windowToolResult("🎵🎵🎵🎵", 3);
    expect(got.originalChars).toBe(4);
    expect(got.output).toContain("4 characters");
    expect("🎵🎵🎵🎵".length).toBe(8);
  });

  test("a limit exactly at the length does not truncate", () => {
    expect(truncateToolResult("🎵🎵🎵🎵", 4)).toBe("🎵🎵🎵🎵");
  });

  test("zero means unlimited, not empty", () => {
    expect(truncateToolResult("hello", 0)).toBe("hello");
  });
});

describe("per-tool limits", () => {
  const cfg: ToolLimitsView = {
    max_result_chars: 1000,
    timeout_ms: 30_000,
    config: {
      ask_researcher: { max_result_chars: 50_000, timeout_ms: 600_000 },
      roll_dice: { max_result_chars: 0, timeout_ms: 0 },
      read: {},
    },
  };
  const zeroGlobal: ToolLimitsView = {
    max_result_chars: 1000,
    timeout_ms: 0,
    config: { ask_researcher: { timeout_ms: 5_000 } },
  };

  type LimitRow = {
    tool: string;
    global_timeout?: string;
    result_chars?: number;
    timeout_ms?: number | null;
  };

  for (const [i, row] of (fixture.limits as LimitRow[]).entries()) {
    test(`case ${i}: ${row.tool}${row.global_timeout === undefined ? "" : " (global 0s)"}`, () => {
      const c = row.global_timeout === undefined ? cfg : zeroGlobal;
      if (row.result_chars !== undefined) {
        expect(resultCharsFor(c, row.tool)).toBe(row.result_chars);
      }
      expect(timeoutFor(c, row.tool) ?? null).toBe(row.timeout_ms ?? null);
    });
  }

  test("a per-tool zero disables the deadline against a nonzero global", () => {
    expect(timeoutFor(cfg, "roll_dice")).toBeUndefined();
  });

  test("a per-tool zero max_result_chars disables truncation, not output", () => {
    expect(resultCharsFor(cfg, "roll_dice")).toBe(0);
    expect(truncateToolResult("x".repeat(5000), resultCharsFor(cfg, "roll_dice"))).toHaveLength(
      5000,
    );
  });

  test("an override present but empty inherits both globals", () => {
    expect(resultCharsFor(cfg, "read")).toBe(1000);
    expect(timeoutFor(cfg, "read")).toBe(30_000);
  });

  test("a tool with no override at all inherits both globals", () => {
    expect(resultCharsFor(cfg, "web_search")).toBe(1000);
    expect(timeoutFor(cfg, "web_search")).toBe(30_000);
  });
});

describe("sub-agent deadlines", () => {
  const subagent = (timeout?: ConfigDuration): SubagentConfig => ({
    description: "d",
    prompt: "p",
    tools: [],
    model: undefined,
    max_iterations: undefined,
    timeout,
  });

  const toolsConfig = (
    overrides: Record<string, { max_result_chars?: number; timeout?: ConfigDuration }>,
  ) => ({
    ...defaultToolsConfig(),
    config: new Map(
      Object.entries(overrides).map(([name, o]) => [
        name,
        { max_result_chars: o.max_result_chars ?? undefined, timeout: o.timeout ?? undefined },
      ]),
    ),
  });

  test("a configured sub-agent gets the long default, not the 300s tool default", () => {
    const limits = toolLimitsFrom(toolsConfig({}), new Map([["research", subagent()]]));
    expect(timeoutFor(limits, "ask_research")).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
    expect(timeoutFor(limits, "read")).toBe(300_000);
  });

  test("the sub-agent's own timeout beats the default", () => {
    const limits = toolLimitsFrom(
      toolsConfig({}),
      new Map([["research", subagent(ConfigDuration.fromSecs(7_200))]]),
    );
    expect(timeoutFor(limits, "ask_research")).toBe(7_200_000);
  });

  test("an explicit tools.config override beats the sub-agent's own timeout", () => {
    const limits = toolLimitsFrom(
      toolsConfig({ ask_research: { timeout: ConfigDuration.fromSecs(90) } }),
      new Map([["research", subagent(ConfigDuration.fromSecs(7_200))]]),
    );
    expect(timeoutFor(limits, "ask_research")).toBe(90_000);
  });

  test("an override carrying only max_result_chars still gets the sub-agent deadline", () => {
    const limits = toolLimitsFrom(
      toolsConfig({ ask_research: { max_result_chars: 1_000 } }),
      new Map([["research", subagent()]]),
    );
    expect(timeoutFor(limits, "ask_research")).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
    expect(resultCharsFor(limits, "ask_research")).toBe(1_000);
  });

  test("a sub-agent timeout of zero disables the deadline", () => {
    const limits = toolLimitsFrom(
      toolsConfig({}),
      new Map([["research", subagent(ConfigDuration.fromSecs(0))]]),
    );
    expect(timeoutFor(limits, "ask_research")).toBeUndefined();
  });

  test("an ask_ tool with no matching sub-agent keeps the global default", () => {
    const limits = toolLimitsFrom(toolsConfig({}), new Map());
    expect(timeoutFor(limits, "ask_ghost")).toBe(300_000);
  });
});

describe("dispatch deadline", () => {
  async function rejection(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "the call somehow succeeded";
  }

  function hangingContext(): ToolContext {
    return bareContext({
      mcpCall: (_name, _input) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("test overran")), 30_000).unref?.();
        }),
    });
  }

  function stoppingContext(): ToolContext {
    return bareContext({
      mcpCall: (_name, _input, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("server acknowledged the cancel"));
          });
        }),
    });
  }

  test("a tool that outruns its deadline fails as a tool, not a transport error", async () => {
    expect(
      await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, stoppingContext(), 50, 50)),
    ).toBe("timed out after 0s and was cancelled");
  });

  test("the reported seconds floor the millisecond deadline", async () => {
    expect(
      await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, stoppingContext(), 1_500, 50)),
    ).toBe("timed out after 1s and was cancelled");
  });

  test("a tool that never confirms it stopped is reported as still possibly running", async () => {
    expect(
      await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, hangingContext(), 50, 50)),
    ).toContain("it may still be running");
  });

  test("an unconfirmed timeout tells the model not to repeat the call blindly", async () => {
    expect(
      await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, hangingContext(), 50, 50)),
    ).toContain("Do not repeat this call");
  });

  test("shore waits past the deadline for the cancel to land before reporting", async () => {
    let cancelledAt: number | undefined;
    const ctx = bareContext({
      mcpCall: (_name, _input, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            setTimeout(() => {
              cancelledAt = Date.now();
              reject(new Error("stopped late"));
            }, 60);
          });
        }),
    });
    const started = Date.now();
    expect(
      await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, ctx, 50, 500)),
    ).toContain("and was cancelled");
    expect(cancelledAt).toBeDefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("work that completes while being cancelled is returned, not thrown away", async () => {
    const ctx = bareContext({
      mcpCall: (_name, _input, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            setTimeout(() => resolve("the side effect already happened"), 10);
          });
        }),
    });
    expect(await dispatchWithinDeadline("mcp__slow__thing", {}, ctx, 50, 500)).toBe(
      "the side effect already happened",
    );
  });

  test("no deadline means the call is not raced at all", async () => {
    const ctx = bareContext({ mcpCall: async () => "done" });
    expect(await dispatchWithinDeadline("mcp__x__y", {}, ctx, undefined)).toBe("done");
  });

  test("a tool that finishes inside its deadline is unaffected", async () => {
    const ctx = bareContext({ mcpCall: async () => "quick" });
    expect(await dispatchWithinDeadline("mcp__x__y", {}, ctx, 5_000)).toBe("quick");
  });

  test("the deadline reaches the handler as an abort signal it can act on", async () => {
    let aborted = false;
    const ctx = bareContext({
      mcpCall: (_name, _input, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("handler stopped"));
          });
        }),
    });
    await rejection(dispatchWithinDeadline("mcp__slow__thing", {}, ctx, 50, 50));
    expect(aborted).toBe(true);
  });

  test("an ask_ call runs the sub-agent and waits for it", async () => {
    const ctx = bareContext({
      runSubagent: async (name, query) => `blocking ${name}:${query}`,
    });
    expect(await dispatchTool("ask_researcher", { query: "tides" }, ctx)).toBe(
      "blocking researcher:tides",
    );
  });

  test("a sub-agent receives the same signal", async () => {
    let seen: AbortSignal | undefined;
    const ctx = bareContext({
      runSubagent: async (_name, _query, signal) => {
        seen = signal;
        return "done";
      },
    });
    await dispatchWithinDeadline("ask_researcher", { query: "x" }, ctx, 5_000);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  test("a caller signal already aborted fires the handler's abort immediately", async () => {
    const outer = new AbortController();
    outer.abort();
    let aborted = false;
    const ctx = bareContext({
      signal: outer.signal,
      mcpCall: (_name, _input, signal) =>
        new Promise<never>((_resolve, reject) => {
          if (signal?.aborted === true) {
            aborted = true;
            reject(new Error("aborted by caller"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("aborted late")));
        }),
    });
    expect(await rejection(dispatchWithinDeadline("mcp__x__y", {}, ctx, 5_000))).toBe(
      "aborted by caller",
    );
    expect(aborted).toBe(true);
  });

  test("without a deadline the handler still gets the caller's signal", async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const ctx = bareContext({
      signal: outer.signal,
      mcpCall: async (_name, _input, signal) => {
        seen = signal;
        return "done";
      },
    });
    await dispatchWithinDeadline("mcp__x__y", {}, ctx, undefined);
    expect(seen).toBe(outer.signal);
  });
});
