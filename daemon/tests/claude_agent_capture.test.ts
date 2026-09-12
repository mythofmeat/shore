import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";
import { withCallCapture } from "../src/llm/capture.ts";
import { ClaudeAgentProvider, type AgentQuery } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent } from "../src/testing/fake_agent_query.ts";
import type { CallRecord } from "../src/call_store.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import type { ProviderEvent } from "../src/llm/provider_events.ts";
import { required } from "../src/util/required.ts";

test.each(["stream", "generate", "failed generation"])("SDK diagnostics survive %s without altering token accounting", async mode => {
  const dir = await mkdtemp(join(tmpdir(), "shore-sdk-capture-"));
  const limit: SDKRateLimitEvent = {
    type: "rate_limit_event", session_id: "capture-session", uuid: "00000000-0000-4000-8000-000000000001",
    rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85, resetsAt: 1789150200 },
  };
  const modelUsage = {
    "claude-opus-5": { inputTokens: 2, outputTokens: 50, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, webSearchRequests: 0, costUSD: 1, contextWindow: 200000, maxOutputTokens: 64000 },
    "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.1, contextWindow: 200000, maxOutputTokens: 64000 },
  };
  const agent = fakeAgent({
    rounds: [{ blocks: [{ kind: "text", text: "reply" }] }],
    resultUsage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  });
  const runQuery: AgentQuery = async function* (params) {
    yield limit;
    for await (const event of agent.query(params)) {
      yield event.type === "result" ? { ...event, modelUsage, total_cost_usd: 1.1 } : event;
    }
    if (mode === "failed generation") throw new Error("SDK connection lost after result");
  };
  const captures: CallRecord[] = [];
  const provider = withCallCapture(new ClaudeAgentProvider({ runQuery, bookPath: () => join(dir, "sessions.json") }), {
    recordCall: call => captures.push(call),
  });
  const request: SidecarRequest = {
    sdk: "claude_agent", model: "claude-opus-5", api_key: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 256, replay_prior_thinking: "all",
  };
  try {
    if (mode === "stream") {
      for await (const event of provider.stream(request)) expect(event.type).not.toBe("provider_event");
    } else if (mode === "failed generation") {
      const failure: unknown = await provider.generate(request).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: "SDK connection lost after result" });
    } else {
      expect((await provider.generate(request)).content).toBe("reply");
    }
    expect(captures).toHaveLength(1);
    const captured = required(captures[0]);
    const body = required(captured.response_body);
    const diagnostics = mode === "stream"
      ? body.split("\n").map(line => JSON.parse(line) as ProviderEvent).filter(event => event.type === "provider_event")
      : (JSON.parse(body) as { provider_events: ProviderEvent[] }).provider_events;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toEqual({ type: "provider_event", provider: "claude_agent", event: limit });
    expect(diagnostics[1]).toMatchObject({ type: "provider_event", provider: "claude_agent", event: { type: "result", modelUsage, total_cost_usd: 1.1 } });
    if (mode !== "failed generation") {
      expect(captured.usage).toEqual({ input_tokens: 2, output_tokens: 50, cache_read_tokens: 100, cache_write_tokens: 20 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
