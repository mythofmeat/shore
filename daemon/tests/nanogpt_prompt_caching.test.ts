import { describe, expect, test } from "bun:test";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

import {
  applyPromptCaching,
  buildOpenAIMessagesWithTail,
} from "../src/llm/providers/openai.ts";
import { withRegenGuidance } from "../src/handler/generation.ts";
import type { CallContext, Sdk, SidecarRequest, WireMessage } from "../src/llm/types.ts";

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
  test("a 1h request asks nano-gpt for a 1h entry", () => {
    const p = params();
    applyPromptCaching(request("nanogpt", "1h"), p);
    expect(helperIn(p)).toEqual({ enabled: true, ttl: "1h", stickyProvider: true, explicitCacheControl: true });
  });

  test("every shorter TTL lands on the 5m entry nano-gpt offers", () => {
    for (const ttl of ["5m", "1m", "30s"]) {
      const p = params();
      applyPromptCaching(request("nanogpt", ttl), p);
      expect(helperIn(p), ttl).toEqual({ enabled: true, ttl: "5m", stickyProvider: true, explicitCacheControl: true });
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

  test("caching pins the upstream, because failover discards the entry", () => {
    const p = params(4);
    applyPromptCaching(request("nanogpt", "1h"), p);
    expect((helperIn(p) as { stickyProvider?: unknown }).stickyProvider).toBe(true);
  });



  test("the field is nano-gpt's alone, even for another sdk that does cache", () => {
    const req = request("nanogpt", "1h");
    req.sdk = "anthropic";
    const p = params(4);
    applyPromptCaching(req, p);
    expect(helperIn(p)).toBeUndefined();
    expect(req.context?.cache_ttl).toBeUndefined();
  });

  test("nano-gpt is told to stop auto-placing, since shore now places its own", () => {
    const p = params(4);
    applyPromptCaching(request("nanogpt", "1h"), p);
    expect((helperIn(p) as { explicitCacheControl?: unknown }).explicitCacheControl).toBe(true);
  });

  test("the system prompt is promoted to a block so it can carry a marker", () => {
    const p: ChatCompletionCreateParams = {
      model: "m",
      messages: [
        { role: "system", content: "a big stable system prompt" },
        { role: "user", content: "hi" },
      ],
    };
    applyPromptCaching(request("nanogpt", "1h"), p);
    const sys = p.messages[0] as { content: Array<{ type: string; cache_control?: unknown }> };
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("a regen's guidance never carries a marker, so the entry survives it", () => {
    const history: WireMessage[] = [
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
    ];
    const req = (guidance: string | undefined): SidecarRequest =>
      ({
        sdk: "nanogpt",
        provider_key: "nanogpt",
        model: "anthropic/claude-fable-5.1",
        api_key: "k",
        max_tokens: 100,
        system: [{ label: "prompt", text: "a big stable system prompt" }],
        messages: withRegenGuidance(history, guidance),
        provider_options: { cache_ttl: "1h" },
      }) as unknown as SidecarRequest;

    const markedText = (guidance: string | undefined): string[] => {
      const r = req(guidance);
      const { messages, transientTail } = buildOpenAIMessagesWithTail(r);
      const call = { model: r.model, messages } as ChatCompletionCreateParams;
      applyPromptCaching(r, call, transientTail);
      return call.messages.flatMap((msg) => {
        const c = (msg as { content?: unknown }).content;
        if (!Array.isArray(c)) return [];
        return c
          .filter((b) => (b as { cache_control?: unknown }).cache_control !== undefined)
          .map((b) => (b as { text: string }).text);
      });
    };

    const plain = markedText(undefined);
    const guided = markedText("be warmer and shorter");

    expect(guided).not.toContain("be warmer and shorter");
    expect(guided).toEqual(plain);
    expect(plain.length).toBeGreaterThan(0);
  });
});
