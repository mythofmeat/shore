/**
 * Recorded cases for dispatch.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

import fixture from "./tools_fixtures/dispatch.json" with { type: "json" };

import {
  annotateDeferredEdit,
  applyDefaultSearchMode,
  deferEditTo,
  dispatchTool,
  dispatchWithinDeadline,
  resultCharsFor,
  timeoutFor,
  truncateToolResult,
  windowToolResult,
  type RetrievalMode,
  type ToolContext,
  type ToolLimitsView,
} from "../src/tools/dispatch.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/tools/workspace.ts";
import type { Embedder } from "../src/llm/embed.ts";

afterAll(restoreTestEnv);

// ── The bare context the fixture was generated against ──────────────────

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

/** Mirror the generator's `describe`: an outcome as `{ok}` or `{err}`. */
async function route(name: string, input: unknown, ctx = bareContext()): Promise<unknown> {
  try {
    return { ok: await dispatchTool(name, input, ctx) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

// ── Routing ─────────────────────────────────────────────────────────────

describe("routing", () => {
  const routing = fixture.routing as Record<string, unknown>;

  for (const [name, expected] of Object.entries(routing)) {
    // Two rows carry their input in the key rather than being bare names.
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
    // The prefix is stripped exactly once, and an agent name containing `_`
    // survives intact.
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

  // The fixture cannot distinguish these on its own: on the bare context it
  // generated against, taking the `mcp__` branch and falling through to the
  // catch-all both produce `<name>: not yet implemented`. The Rust used
  // `starts_with`, so a wired context is where the difference shows.
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
    // `Value::Null.get("query")` was `None`, so a null input reached each
    // handler as "no arguments" rather than as a type error.
    expect(await route("roll_dice", null)).toEqual(
      (fixture.routing as Record<string, unknown>)["roll_dice"],
    );
    expect(await route("web_search", undefined)).toEqual(
      (fixture.routing as Record<string, unknown>)["web_search"],
    );
  });

  test("mcp receives the caller's input verbatim, not the coerced one", async () => {
    // The Rust handed `mcp_call` the original `Value`, so a null stayed null on
    // the wire rather than becoming `{}`. `McpClient.call` is the side that
    // decides what a null means.
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

// ── Default search mode ─────────────────────────────────────────────────

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
      // `?? {}` would fold the `preset: null` row into the no-preset case and
      // quietly stop testing that a null input is left alone.
      const input = structuredClone("preset" in row ? row.preset : {});
      const mode = (row.mode?.toLowerCase() ?? "auto") as RetrievalMode;
      applyDefaultSearchMode(input, mode, row.embedder ?? false, row.index_path ?? false);
      expect(input).toEqual(row.applied);
    });
  }

  test("an explicit null mode is kept, not treated as absent", () => {
    // `Value::get("mode")` was `Some(Null)` for this, so the Rust left it
    // alone. A `!= null` check here would overwrite it and silently turn a
    // malformed request into a hybrid search.
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
  /** A workspace with one file, so the lexical path has something to answer. */
  async function workspace(): Promise<string> {
    const dir = `/tmp/claude-0/dispatch-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Bun.write(`${dir}/notes.md`, "the quick brown fox\n");
    return dir;
  }

  test("an embedder with no index path is not semantics", async () => {
    // The Rust passed `ctx.embedder()` and `ctx.memory_index_path()` as two
    // arguments; the port bundles them, and the bundle must be all-or-nothing.
    // An embedder paired with an empty index path would send an explicit
    // `hybrid` request down the vector road with nothing to search.
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
    // `parseSearchMode(undefined)` is `hybrid`, so skipping the default
    // entirely still produces a hybrid request — the mode that shows the
    // difference is `lexical`, which only the default can supply.
    const ctx = bareContext({ workspaceDir: await workspace(), retrievalMode: "lexical" });
    const result = (await dispatchTool("search", { query: "fox" }, ctx)) as Record<string, unknown>;
    expect("semantic_unavailable" in result).toBe(false);
  });

  test("the context's retrieval config reaches the scan, not the module default", async () => {
    const ctx = bareContext({
      workspaceDir: await workspace(),
      retrievalMode: "lexical",
      // Smaller than the one file in the workspace, so the scan skips it.
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
    // The display path is rooted at the character directory's *name*, which is
    // only knowable from `characterDataDir`.
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
      // A one-pixel PNG as a data URL, so nothing is fetched.
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
        seen.push(JSON.parse(String(init?.body)));
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
        seen.push(String(input));
        return new Response("<p>hi</p>", { headers: { "content-type": "text/html" } });
      },
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

    // Spaces become hyphens in the local part; the display name is verbatim.
    expect(String(log["stdout"])).toContain("Juniper Vale <juniper-vale@shore.local>");
  });
});

// ── Deferred-edit annotation ────────────────────────────────────────────

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
        // The annotation must not have run yet: the queue write is what makes
        // the "deferred" claim true.
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
    // The file is already on disk by the time this runs. Throwing here would
    // tell the model the edit failed when it did not — the worst available
    // answer, because it will try again.
    const defer = deferEditTo("/data/juniper", async () => {
      throw new Error("disk full");
    });
    await expect(defer("SOUL.md")).resolves.toBeUndefined();
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

// ── Truncation ──────────────────────────────────────────────────────────

describe("result truncation", () => {
  type TruncRow = { input: string; max_chars: number; output: string };

  /**
   * The Rust kept the head only and said so, which is what the fixture
   * records. Since #92 the window keeps both ends at the same character cost
   * — for a build log or a file read the tail is usually the part that matters
   * — and the marker names a recovery instead of stating a fact and stopping.
   *
   * The fixture is frozen, so the cases that pass through untouched still
   * assert against it verbatim; the ones that truncate assert the properties
   * the Rust's format also had, plus the two that are new.
   */
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
      expect(got.originalChars).toBe([...row.input].length);
      expect(got.headChars + got.tailChars).toBe(row.max_chars);
      expect(got.output.startsWith([...row.input].slice(0, got.headChars).join(""))).toBe(true);
      expect(got.output).toContain(`${String([...row.input].length)} characters`);
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
    // Four musical notes are 8 UTF-16 units and 4 chars. A `.length`-based
    // implementation would report "of 8" here.
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

// ── Per-tool limits ─────────────────────────────────────────────────────

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

// ── The deadline ────────────────────────────────────────────────────────

describe("dispatch deadline", () => {
  /** A context whose `roll_dice` hangs until aborted. */
  function hangingContext(): ToolContext {
    return bareContext({
      mcpCall: (_name, _input) =>
        new Promise((_resolve, reject) => {
          // Never resolves on its own.
          setTimeout(() => reject(new Error("test overran")), 30_000).unref?.();
        }),
    });
  }

  test("a tool that outruns its deadline fails as a tool, not a transport error", async () => {
    await expect(
      dispatchWithinDeadline("mcp__slow__thing", {}, hangingContext(), 50),
    ).rejects.toThrow("timed out after 0s and was cancelled");
  });

  test("the reported seconds floor the millisecond deadline", async () => {
    await expect(
      dispatchWithinDeadline("mcp__slow__thing", {}, hangingContext(), 1_500),
    ).rejects.toThrow("timed out after 1s and was cancelled");
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
    // This is the whole reason the signal is threaded: a promise cannot be
    // cancelled, so without it the handler runs on forever after the race is
    // lost. A handler that honours the signal actually stops.
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
    await expect(dispatchWithinDeadline("mcp__slow__thing", {}, ctx, 50)).rejects.toThrow();
    expect(aborted).toBe(true);
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
    await expect(dispatchWithinDeadline("mcp__x__y", {}, ctx, 5_000)).rejects.toThrow(
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
