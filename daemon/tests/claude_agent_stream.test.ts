import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAgentProvider, claudeAgentEnvironment } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent, type FakeScript } from "../src/testing/fake_agent_query.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";

async function bookDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "shore-agent-book-"));
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "claude_agent",
    model: "claude-opus-5",
    api_key: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    ...overrides,
  };
}

async function collect(
  script: FakeScript,
  req: SidecarRequest = request(),
  signal?: AbortSignal,
): Promise<{ events: StreamEvent[]; agent: ReturnType<typeof fakeAgent>; path: string }> {
  const dir = await bookDir();
  const path = join(dir, "sessions.json");
  const agent = fakeAgent(script);
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(req, signal)) events.push(event);
  return { events, agent, path };
}

describe("the options the SDK is run with", () => {
  test("every built-in tool and skill is off, and the harness cannot compact", async () => {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    const options = agent.calls[0]?.options;
    expect(options?.tools).toEqual([]);
    expect(options?.skills).toEqual([]);
    expect(options?.settings).toEqual({ autoCompactEnabled: false });
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.disallowedTools).toContain("Task");
    expect(options?.disallowedTools).toContain("Agent");
  });

  test("tool calls go to shore's canUseTool, not to the CLI's auto-mode classifier", async () => {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    expect(agent.calls[0]?.options.permissionMode).toBe("default");
  });
});

describe("the environment the subprocess is given", () => {
  async function envOf(req: SidecarRequest): Promise<Record<string, string>> {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] }, req);
    return (agent.calls[0]?.options.env ?? {}) as Record<string, string>;
  }

  test("the daemon's own Anthropic key is not inherited, so a subscription turn stays one", async () => {
    setTestEnv("ANTHROPIC_API_KEY", "sk-ant-daemon-key");
    try {
      expect(await envOf(request({ api_key: "" }))).not.toHaveProperty("ANTHROPIC_API_KEY");
    } finally {
      restoreTestEnv();
    }
  });

  test("a key the request actually carries is passed on", async () => {
    expect((await envOf(request({ api_key: "sk-ant-asked-for" }))).ANTHROPIC_API_KEY).toBe(
      "sk-ant-asked-for",
    );
  });

  test.each(["/shared/claude", ""])("the credential-store override is preserved exactly: %j", async (directory) => {
    setTestEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", directory);
    try {
      expect((await envOf(request())).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(directory);
    } finally {
      restoreTestEnv();
    }
  });

  test.each(["/shared/claude", undefined])("session restore keeps the original credential store: %j", async (directory) => {
    if (directory === undefined) unsetTestEnv("CLAUDE_CONFIG_DIR");
    else setTestEnv("CLAUDE_CONFIG_DIR", directory);
    unsetTestEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    try {
      expect((await envOf(request())).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(directory ?? "");
    } finally {
      restoreTestEnv();
    }
  });

  test("the CLI is told not to turn an omitted thinking display into updates", async () => {
    expect((await envOf(request())).CLAUDE_CODE_THINKING_DISPLAY_UPDATES).toBe("0");
  });

  test("nothing else of the daemon's environment leaks in", async () => {
    setTestEnv("SHORE_SECRET_FIXTURE", "do-not-forward");
    try {
      expect(Object.keys(await envOf(request()))).not.toContain("SHORE_SECRET_FIXTURE");
    } finally {
      restoreTestEnv();
    }
  });
});

describe("what the options carry", () => {
  const once: FakeScript = { rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] };

  test("the config folder and base URL are passed on only when there are any", async () => {
    unsetTestEnv("CLAUDE_CONFIG_DIR");
    try {
      expect((await collect(once)).agent.calls[0]?.options.env ?? {}).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      const bare = claudeAgentEnvironment();
      expect(bare).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      expect(bare).not.toHaveProperty("ANTHROPIC_BASE_URL");
      const given = claudeAgentEnvironment("https://proxy.example", "", "/claude/login");
      expect(given.CLAUDE_CONFIG_DIR).toBe("/claude/login");
      expect(given.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
      setTestEnv("CLAUDE_CONFIG_DIR", "/claude/config");
      expect(((await collect(once)).agent.calls[0]?.options.env ?? {}).CLAUDE_CONFIG_DIR).toBe("/claude/config");
    } finally {
      restoreTestEnv();
    }
  });

  test("the system prompt goes as a custom prompt that is not snapshotted, the cache lifetime only when set, partial messages on, and one turn without tools", async () => {
    const plain = (await collect(once)).agent.calls[0]?.options;
    expect(plain?.settings).toStrictEqual({ autoCompactEnabled: false });
    expect(plain?.includePartialMessages).toBe(true);
    expect(plain?.maxTurns).toBe(1);
    expect(plain).not.toHaveProperty("systemPrompt");
    expect(plain?.env ?? {}).not.toHaveProperty("MAX_MCP_OUTPUT_TOKENS");
    const shaped = (await collect(once, request({ system: [{ text: "be kind", label: "soul" }], provider_options: { cache_ttl: "1h" } }))).agent.calls[0]?.options;
    expect(shaped?.systemPrompt).toStrictEqual({ type: "custom", prompt: "be kind", snapshot: false });
    expect(shaped?.settings).toStrictEqual({ autoCompactEnabled: false, promptCacheTtl: "1h" });
  });

  test("a regenerated reply forks the session at the reply before it, while a new turn just continues", async () => {
    const dir = await bookDir();
    const path = join(dir, "sessions.json");
    const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "first" }] }, { blocks: [{ kind: "text", text: "second" }] }, { blocks: [{ kind: "text", text: "again" }] }] });
    const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
    const run = async (messages: SidecarRequest["messages"]): Promise<string> => {
      let text = "";
      for await (const event of provider.stream(request({ messages }))) if (event.type === "text") text += event.text;
      return text;
    };
    const ask = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] };
    const first = await run([ask]);
    const then = { role: "user" as const, content: [{ type: "text" as const, text: "and then?" }] };
    await run([ask, { role: "assistant", content: [{ type: "text", text: first }] }, then]);
    await run([ask, { role: "assistant", content: [{ type: "text", text: first }] }, then]);
    const [, continued, regenerated] = agent.calls.map((call) => call.options);
    expect(continued?.resume).toBeDefined();
    expect(continued).not.toHaveProperty("forkSession");
    expect(continued).not.toHaveProperty("resumeSessionAt");
    expect(regenerated?.forkSession).toBe(true);
    expect(typeof regenerated?.resumeSessionAt).toBe("string");
  });
});
