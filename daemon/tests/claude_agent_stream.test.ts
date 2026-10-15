import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
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
