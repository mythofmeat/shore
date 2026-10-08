import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore } from "../src/call_store.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { REDACTED } from "../src/llm/redact.ts";
import { installWireCapture } from "../src/llm/wire_capture.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { until } from "./support/until.ts";

test("each claude_agent turn's HTTP exchanges are captured under its own call id, as Anthropic received them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-wire-"));
  const email = "someone.private@example.com";
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: {
    emailAddress: email, accountUuid: "00000000-0000-4000-8000-000000000001",
    organizationUuid: "00000000-0000-4000-8000-000000000002",
  } }));
  const mock = await startMockAnthropic({ script: [
    { toolUses: [{ id: "toolu_look", name: "mcp__shore__bash", input: { command: "ls" } }] },
    { text: "Shells and a crab." },
    { text: "The crab is called Pinch." },
  ] });
  const store = CallStore.openInMemory();
  const uninstall = installWireCapture((exchange) => { store.recordHttpCall(exchange); });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 }, callStore: store,
  };
  const turn = (messages: WireMessage[]) => runGeneration({
    sdk: "claude_agent", api_key: "", base_url: mock.url, model: "opus",
    system: [{ label: "soul", text: "You are Heidi." }], messages,
    tools: [{ name: "bash", description: "Run a shell command", input_schema: {
      type: "object", properties: { command: { type: "string" } }, required: ["command"],
    } }],
    context: { character: "heidi", workspace_dir: dir, thinking_enabled: false, call_type: "message" },
    max_tokens: 1024, replay_prior_thinking: "all",
  }, { providerKey: "claude-code" }, deps, {
    signal: AbortSignal.timeout(30_000), sink: () => {},
    tools: { messages: [], recordTurn: () => {}, runTool: (use: { id: string }) =>
      Promise.resolve({ type: "tool_result" as const, tool_use_id: use.id, content: "shells.txt" }) },
  });
  const ask = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
  try {
    const first = await turn([ask("What is in your room?")]);
    expect(first.result.content).toBe("Shells and a crab.");
    const second = await turn([ask("What is in your room?"),
      { role: "assistant", content: [{ type: "text", text: "Shells and a crab." }] }, ask("Does the crab have a name?")]);
    expect(second.result.content).toBe("The crab is called Pinch.");

    const callIds = store.queryCalls({ limit: 10 }).map(call => call.call_id).sort();
    expect(callIds).toHaveLength(2);
    const messagesCalls = (callId: string) =>
      store.httpCallsFor(callId).filter(row => new URL(row.url).pathname === "/v1/messages");
    const settled = () => callIds.every(id => messagesCalls(id).every(row => row.response_body !== null));
    await until(() => messagesCalls(required(callIds[0])).length === 2 && messagesCalls(required(callIds[1])).length === 1 && settled(),
      "every captured exchange under its own call");
    const captured = callIds.flatMap(messagesCalls);

    expect(captured.map(row => new URL(row.url).origin)).toEqual([mock.url, mock.url, mock.url]);
    expect(captured.map(row => row.status)).toEqual([200, 200, 200]);
    expect(captured.map(row => row.character)).toEqual(["heidi", "heidi", "heidi"]);
    for (const [index, row] of captured.entries()) {
      const body = required(row.request_body);
      expect(JSON.parse(body)).toEqual(mock.requests[index]?.body);
      expect(body).not.toContain(email);
      expect(new Map(row.request_headers).get("authorization")).toBe(REDACTED);
      expect(JSON.stringify(row.request_headers)).not.toContain("test-oauth-token");
    }
    expect(required(captured[2]).request_body).toContain("Does the crab have a name?");
    expect(required(captured[0]).response_body).toContain("mcp__shore__bash");
    expect(required(captured[1]).response_body).toContain(`"stop_reason":"end_turn"`);
  } finally {
    uninstall();
    store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
