import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { startMockClaudeOAuth } from "../src/testing/mock_claude_oauth.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";

test.each([false, true])("continued and regenerated turns refresh expired OAuth credentials (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-auth-refresh-"));
  const configDir = join(dir, "claude");
  await mkdir(configDir);
  let acceptedToken = "test-access-0";
  const mock = await startMockAnthropic({ fallback: sent =>
    sent.headers["authorization"] === `Bearer ${acceptedToken}`
      ? { text: "authenticated reply" }
      : { status: 401, errorBody: { type: "error", error: {
          type: "authentication_error",
          message: "OAuth access token has expired. Re-authenticate to continue.",
        } } },
  });
  const oauth = await startMockClaudeOAuth(mock.url);
  setTestEnv("CLAUDE_CONFIG_DIR", configDir);
  unsetTestEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  const makeProvider = (book: string) => new ClaudeAgentProvider({
    bookPath: () => join(dir, book),
    runQuery: params => query({ ...params, options: {
      ...params.options, env: { ...params.options.env, ...oauth.env },
    } }),
  });
  let provider = makeProvider("sessions.json");
  const request: SidecarRequest = {
    sdk: "claude_agent", model: "claude-opus-4-8", api_key: "", base_url: mock.url,
    system: [{ label: "character", text: "Reply briefly." }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    context: { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
    max_tokens: 256, replay_prior_thinking: "all",
    ...(withTools ? { tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }] } : {}),
  };
  try {
    for (let turn = 0; turn < 3; turn++) {
      await writeFile(join(configDir, ".credentials.json"), oauth.credentials(turn > 0));
      acceptedToken = `test-access-${turn}`;
      if (turn === 2) provider = makeProvider("restarted-sessions.json");
      const { result } = await runGeneration(request, { providerKey: "claude-code" }, {
        config: {
          app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
          dirs: { config: dir, data: dir, cache: dir, runtime: dir },
        },
        providers: { claude_agent: provider },
        retry: { maxRetries: 0, backoffBaseMs: 0 },
      }, {
        signal: AbortSignal.timeout(20_000),
        ...(withTools ? { tools: {
          messages: [], recordTurn: () => {},
          runTool: async () => { throw new Error("No tool call was requested"); },
        } } : {}),
      });
      expect(result.content).toBe("authenticated reply");
      expect(oauth.refreshTokens).toHaveLength(turn);
      const saved = JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8")) as {
        claudeAiOauth: { accessToken: string };
      };
      expect(saved.claudeAiOauth.accessToken)
        .toBe(acceptedToken);
      if (turn === 0) request.messages.push(
        { role: "assistant", content: [{ type: "text", text: result.content }] },
        { role: "user", content: [{ type: "text", text: "And now?" }] },
      );
    }
    expect(oauth.refreshTokens).toEqual(["test-refresh-0", "test-refresh-1"]);
    expect(mock.requests.map(sent => sent.headers["authorization"])).toEqual([
      "Bearer test-access-0", "Bearer test-access-1", "Bearer test-access-2",
    ]);
  } finally {
    restoreTestEnv();
    await oauth.stop();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test.each([false, true])("the SDK uses the shared credential store across token rotation (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-auth-"));
  const configDir = join(dir, "sessions");
  const authDir = join(dir, "auth");
  await Promise.all([mkdir(configDir), mkdir(authDir)]);
  const credentials = (accessToken: string) => JSON.stringify({
    claudeAiOauth: {
      accessToken,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
      subscriptionType: "pro",
    },
  });
  await writeFile(join(configDir, ".credentials.json"), credentials("stale-test-token"));
  await writeFile(join(authDir, ".credentials.json"), credentials("fresh-test-token"));
  let acceptedToken = "fresh-test-token";
  const mock = await startMockAnthropic({ fallback: request =>
    request.headers["authorization"] === `Bearer ${acceptedToken}`
      ? { text: "authenticated reply" }
      : { status: 401, errorBody: { type: "error", error: {
          type: "authentication_error",
          message: "OAuth access token has expired. Re-authenticate to continue.",
        } } },
  });
  setTestEnv("CLAUDE_CONFIG_DIR", configDir);
  setTestEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", authDir);
  const provider = new ClaudeAgentProvider({ bookPath: () => join(dir, "sessions.json") });
  const request: SidecarRequest = {
    sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "", base_url: mock.url,
    system: [{ label: "character", text: "Reply briefly." }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    context: { character: "test", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
    max_tokens: 256, replay_prior_thinking: "all",
    ...(withTools ? { tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }] } : {}),
  };
  try {
    for (const token of ["fresh-test-token", "rotated-test-token"]) {
      acceptedToken = token;
      await writeFile(join(authDir, "next.json"), credentials(token));
      await rename(join(authDir, "next.json"), join(authDir, ".credentials.json"));
      const { result } = await runGeneration(request, { providerKey: "claude-code" }, {
        config: {
          app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
          dirs: { config: dir, data: dir, cache: dir, runtime: dir },
        },
        providers: { claude_agent: provider },
        retry: { maxRetries: 0, backoffBaseMs: 0 },
      }, {
        signal: AbortSignal.timeout(20_000),
        ...(withTools ? { tools: {
          messages: [], recordTurn: () => {},
          runTool: async () => { throw new Error("No tool call was requested"); },
        } } : {}),
      });
      expect(result.content).toBe("authenticated reply");
      request.messages.push(
        { role: "assistant", content: [{ type: "text", text: result.content }] },
        { role: "user", content: [{ type: "text", text: "And now?" }] },
      );
    }
    expect(mock.requests.map(sent => sent.headers["authorization"])).toEqual([
      "Bearer fresh-test-token", "Bearer rotated-test-token",
    ]);
  } finally {
    restoreTestEnv();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
