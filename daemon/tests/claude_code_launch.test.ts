import { describe, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { toLlmError } from "../src/llm/errors.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import {
  BUNDLED_CLAUDE_CODE,
  ClaudeCodeLaunchFailed,
  claudeCodeExecutable,
  claudeCodeLaunchFailure,
  isCompiledDaemon,
} from "../src/llm/providers/claude_code.ts";
import { shouldRetryError } from "../src/llm/retry.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { setTestEnv } from "./support/env.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

async function scratch(name: string): Promise<string> {
  const dir = testTmp(`claude-code-launch-${name}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function sdkLaunchError(path: string, cwd: string): Promise<unknown> {
  return await rejectionOf((async () => {
    const run = query({
      prompt: "hello",
      options: {
        pathToClaudeCodeExecutable: path,
        cwd,
        env: { PATH: process.env["PATH"] ?? "", HOME: cwd, CLAUDE_CONFIG_DIR: cwd },
        settingSources: [],
        persistSession: false,
      },
    });
    for await (const _message of run) void _message;
  })());
}

describe("which Claude Code the daemon runs", () => {
  test("a compiled daemon runs the shore-claude beside its own executable", () => {
    expect(claudeCodeExecutable({}, "/opt/shore/shore-daemon", true)).toBe(join("/opt/shore", BUNDLED_CLAUDE_CODE));
  });

  test("run from source it leaves the lookup to the SDK, which finds its platform package in node_modules", () => {
    expect(claudeCodeExecutable({}, "/usr/bin/bun", false)).toBeUndefined();
    expect(claudeCodeExecutable({ SHORE_CLAUDE_PATH: "" }, "/usr/bin/bun", false)).toBeUndefined();
  });

  test("SHORE_CLAUDE_PATH wins either way, and must be absolute", () => {
    const env = { SHORE_CLAUDE_PATH: "/usr/local/bin/claude" };
    expect(claudeCodeExecutable(env, "/opt/shore/shore-daemon", true)).toBe("/usr/local/bin/claude");
    expect(claudeCodeExecutable(env, "/usr/bin/bun", false)).toBe("/usr/local/bin/claude");
    expect(() => claudeCodeExecutable({ SHORE_CLAUDE_PATH: "claude" }, "/usr/bin/bun", false)).toThrow(ClaudeCodeLaunchFailed);
  });

  test("only a module inside a Bun executable counts as compiled", () => {
    expect(isCompiledDaemon("/$bunfs/root/shore-daemon")).toBe(true);
    expect(isCompiledDaemon("B:\\~BUN\\root\\shore-daemon.exe")).toBe(true);
    expect(isCompiledDaemon(import.meta.path)).toBe(false);
    expect(isCompiledDaemon()).toBe(false);
  });
});

describe("a Claude Code that cannot start", () => {
  test.each(["missing", "not executable"])("the SDK's launch error when the executable is %s becomes a final launch failure", async (state) => {
    const dir = await scratch(state.replace(" ", "-"));
    const path = join(dir, BUNDLED_CLAUDE_CODE);
    if (state === "not executable") await writeFile(path, "#!/bin/sh\n", { mode: 0o644 });
    const raw = await sdkLaunchError(path, dir);

    const failure = claudeCodeLaunchFailure(raw, true);
    expect(failure).toBeInstanceOf(ClaudeCodeLaunchFailed);
    expect(failure?.cause).toBe(raw);
    expect(failure?.message).toStartWith("Claude Code could not start: ");
    expect(failure?.message).toContain(path);
    expect(failure?.message).toContain("SHORE_CLAUDE_PATH");
    expect(failure?.message).not.toContain("options.pathToClaudeCodeExecutable");
    expect(failure?.message).toContain(`runs the ${BUNDLED_CLAUDE_CODE} beside it`);
    expect(claudeCodeLaunchFailure(raw, false)?.message).not.toContain("beside it");
    expect(toLlmError(failure).kind).toBe("launch_failed");
    expect(shouldRetryError(failure, 0, { max_retries: 5 })).toEqual({ decision: "fail" });
  });

  test("the SDK's own lookup failing is a launch failure too, and nothing else is", () => {
    const lookup = new Error("Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.");
    expect(claudeCodeLaunchFailure(lookup, false)?.message)
      .toBe("Claude Code could not start: Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set SHORE_CLAUDE_PATH.");
    expect(claudeCodeLaunchFailure(new Error("Claude Code process exited with code 1"))).toBeUndefined();
    expect(claudeCodeLaunchFailure("Native CLI binary for linux-x64 not found")).toBeUndefined();
  });

  test.each([false, true])("a generation fails on its first attempt instead of retrying (tools: %s)", async (withTools) => {
    const dir = await scratch(`generation-${String(withTools)}`);
    const missing = join(dir, BUNDLED_CLAUDE_CODE);
    setTestEnv("SHORE_CLAUDE_PATH", missing);
    setTestEnv("CLAUDE_CONFIG_DIR", dir);
    const sleeps: number[] = [];
    const request: SidecarRequest = {
      sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "",
      system: [{ label: "character", text: "Reply briefly." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      context: { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
      max_tokens: 256, replay_prior_thinking: "all",
      ...(withTools ? { tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }] } : {}),
    };

    const error = await rejectionOf(runGeneration(request, { providerKey: "claude-code" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: dir, data: dir, cache: dir, runtime: dir },
      },
      providers: { claude_agent: new ClaudeAgentProvider({ bookPath: () => join(dir, "sessions.json") }) },
      retry: { maxRetries: 5, backoffBaseMs: 1_000 },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }, {
      signal: AbortSignal.timeout(20_000),
      ...(withTools ? { tools: {
        messages: [], recordTurn: () => {},
        runTool: () => Promise.reject(new Error("No tool call was requested")),
      } } : {}),
    }));

    expect(error).toBeInstanceOf(ClaudeCodeLaunchFailed);
    expect((error as Error).message).toContain(missing);
    expect(sleeps).toEqual([]);
  }, 30_000);
});
