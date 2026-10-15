import { describe, expect, test } from "bun:test";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

import { applyPromptCaching } from "../src/llm/providers/openai.ts";
import type { Sdk, SidecarRequest } from "../src/llm/types.ts";

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

function params(messageCount = 0): ChatCompletionCreateParams {
  return {
    model: "anthropic/claude-sonnet-5",
    messages: Array.from({ length: messageCount }, () => ({
      role: "user" as const,
      content: "hi",
    })),
  };
}

const helperIn = (p: ChatCompletionCreateParams): unknown =>
  (p as unknown as Record<string, unknown>)["prompt_caching"];

describe("the prompt-cache helper nano-gpt reads", () => {

  test("OpenAI's own endpoint never sees the field, which it would reject", () => {
    const p = params();
    applyPromptCaching(request("openai", "1h"), p);
    expect(helperIn(p)).toBeUndefined();
  });
});
