import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import fixture from "./tools_captures/dispatch.json" with { type: "json" };

import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  annotateDeferredEdit,
  deferEditTo,
  dispatchTool,
  dispatchWithinDeadline,
  resultCharsFor,
  timeoutFor,
  toolLimitsFrom,
  truncateToolResult,
  windowToolResult,
  type ToolContext,
  type ToolLimitsView,
} from "../src/tools/dispatch.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { defaultToolsConfig, type SubagentConfig } from "../src/config/app.ts";

function bareContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    imageDir: "/tmp/test_images",
    workspaceDir: "",
    characterDataDir: "",
    conversationDir: "",
  historyDbPath: "/tmp/history.db",
    characterName: "",
    configDir: "",
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
    expect(await route("bash", null)).toEqual(
      (fixture.routing as Record<string, unknown>)["bash"],
    );
    expect(await route("generate_image", undefined)).toEqual(
      (fixture.routing as Record<string, unknown>)["generate_image"],
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

  test("set_next_wake asks the clock for what the model asked and quotes what it got", async () => {
    const asked: [number, string][] = [];
    const ctx = bareContext({
      scheduleNextWake: (hours, reason) => {
        asked.push([hours, reason]);
        return 48;
      },
    });
    expect(await dispatchTool("set_next_wake", { hours_from_now: 900, reason: "the essay" }, ctx)).toBe(
      "Scheduled next moment in 48.0 hours.",
    );
    expect(asked).toEqual([[900, "the essay"]]);
  });

  test("set_next_wake defaults to an hour with no reason", async () => {
    const asked: [number, string][] = [];
    const ctx = bareContext({
      scheduleNextWake: (hours, reason) => {
        asked.push([hours, reason]);
        return hours;
      },
    });
    await dispatchTool("set_next_wake", {}, ctx);
    expect(asked).toEqual([[1, ""]]);
  });

  test("set_next_wake says so when the character has no heartbeat to move", async () => {
    const ctx = bareContext({ scheduleNextWake: () => undefined });
    expect(await route("set_next_wake", { hours_from_now: 2, reason: "later" }, ctx)).toEqual({
      err: "io: heartbeats are not running for this character",
    });
  });

  test("a dry run leaves the heartbeat schedule alone", async () => {
    const asked: number[] = [];
    const ctx = bareContext({
      dryRun: true,
      scheduleNextWake: (hours) => {
        asked.push(hours);
        return hours;
      },
    });
    expect(await route("set_next_wake", { hours_from_now: 2, reason: "later" }, ctx)).toEqual({
      err: "io: set_next_wake blocked: dry-run tools cannot change files or external state",
    });
    expect(asked).toEqual([]);
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

  test("generate_image writes into the context's image directory", async () => {
    const imageDir = `${tmpdir()}/dispatch-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  test("git commits as the context's character", async () => {
    const dir = `${tmpdir()}/dispatch-git-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Bun.write(`${dir}/a.md`, "hello\n");
    const ctx = bareContext({ workspaceDir: dir, characterName: "Juniper Vale" });

    await dispatchTool("bash", { command: "git init -q && git add a.md" }, ctx);
    await dispatchTool("bash", { command: "git commit -qm first" }, ctx);
    const log = (await dispatchTool(
      'bash',
      { command: "git log --format='%an <%ae>' -1" },
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
    expect(await defer("SOUL.md")).toBeUndefined();
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

  test("bash reports prompt edits through dispatch", async () => {
    const dir = `${tmpdir()}/dispatch-edit-${Date.now()}`;
    await Bun.write(`${dir}/MEMORY.md`, "before\n");
    const ctx = bareContext({ workspaceDir: dir });
    const result = (await dispatchTool(
      "bash",
      { command: "printf 'after\\n' > MEMORY.md" },
      ctx,
    )) as Record<string, unknown>;
    expect(result["prompt_files_changed"]).toEqual(["MEMORY.md"]);
    expect(await Bun.file(`${dir}/MEMORY.md`).text()).toBe("after\n");
  });

  test("an ordinary workspace file is written without annotation", async () => {
    const dir = `${tmpdir()}/dispatch-edit-plain-${Date.now()}`;
    await Bun.write(`${dir}/notes.md`, "before\n");
    const ctx = bareContext({ workspaceDir: dir });
    const result = (await dispatchTool(
      "bash",
      { command: "printf 'after\\n' > notes.md" },
      ctx,
    )) as Record<string, unknown>;
    expect(result["prompt_files_changed"]).toEqual([]);
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
