import { describe, expect, test } from "bun:test";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

import { applyPromptCaching } from "../src/llm/providers/openai.ts";
import type { CallContext, Sdk, SidecarRequest } from "../src/llm/types.ts";

function request(sdk: Sdk, cacheTtl?: string): SidecarRequest {
  return {
    sdk,
    provider_key: sdk === "nanogpt" ? "nanogpt" : "openai",
    model: "anthropic/claude-sonnet-5",
    api_key: "k",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(cacheTtl === undefined ? {} : { provider_options: { cache_ttl: cacheTtl } }),
  } as SidecarRequest;
}

function params(): ChatCompletionCreateParams {
  return { model: "anthropic/claude-sonnet-5", messages: [] };
}

const helperIn = (p: ChatCompletionCreateParams): unknown =>
  (p as unknown as Record<string, unknown>)["prompt_caching"];

describe("the prompt-cache helper nano-gpt reads", () => {
  test("a 1h request asks nano-gpt for a 1h entry", () => {
    const p = params();
    applyPromptCaching(request("nanogpt", "1h"), p);
    expect(helperIn(p)).toEqual({ enabled: true, ttl: "1h" });
  });

  test("every shorter TTL lands on the 5m entry nano-gpt offers", () => {
    for (const ttl of ["5m", "1m", "30s"]) {
      const p = params();
      applyPromptCaching(request("nanogpt", ttl), p);
      expect(helperIn(p), ttl).toEqual({ enabled: true, ttl: "5m" });
    }
  });

  test("no cache_ttl means no helper, so implicit caching is left alone", () => {
    const p = params();
    applyPromptCaching(request("nanogpt"), p);
    expect(helperIn(p)).toBeUndefined();
  });

  test("OpenAI's own endpoint never sees the field, which it would reject", () => {
    const p = params();
    applyPromptCaching(request("openai", "1h"), p);
    expect(helperIn(p)).toBeUndefined();
  });

  test("a TTL the adapter drops is struck from what the ledger records", () => {
    const req = request("openai", "1h");
    req.context = { cache_ttl: "1h" } as CallContext;
    applyPromptCaching(req, params());
    expect(req.context && "cache_ttl" in req.context).toBe(false);
  });

  test("a TTL nano-gpt honors survives into what the ledger records", () => {
    const req = request("nanogpt", "1h");
    req.context = { cache_ttl: "1h" } as CallContext;
    applyPromptCaching(req, params());
    expect(req.context?.cache_ttl).toBe("1h");
  });
});
