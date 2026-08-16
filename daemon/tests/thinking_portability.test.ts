import { describe, expect, test } from "bun:test";

import { buildGeminiParams } from "../src/llm/providers/gemini.ts";
import { buildCall } from "../src/llm/providers/openrouter.ts";
import { buildAnthropicParams } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

function minted(provider: string, model: string, block: Record<string, unknown>): WireMessage {
  return {
    role: "assistant",
    provider_key: provider,
    model,
    content: [block as never, { type: "text", text: "answer" }],
  };
}

function req(over: Partial<SidecarRequest>): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "m",
    api_key: "k",
    max_tokens: 1024,
    replay_prior_thinking: "all",
    messages: [],
    ...over,
  } as SidecarRequest;
}

const anthropicSigned = { type: "thinking", thinking: "minted by claude", signature: "ErUBCkYIBRg" };
const geminiSigned = { type: "thinking", thinking: "minted by 2.5-pro", signature: "GEMINI_SIG" };
const openrouterCarried = {
  type: "thinking",
  thinking: "minted by sonnet",
  reasoning_details: [{ type: "reasoning.text", text: "minted by sonnet", signature: "SONNET" }],
};

describe("no adapter puts a foreign signature on the wire", () => {
  test("gemini refuses an anthropic signature as a thoughtSignature", () => {
    const params = buildGeminiParams(
      req({
        sdk: "gemini",
        provider_key: "gemini",
        model: "gemini-3-pro",
        messages: [minted("anthropic", "claude-opus-5", anthropicSigned)],
      }),
    );

    expect(JSON.stringify(params.contents)).not.toContain("thoughtSignature");
  });

  test("gemini refuses another gemini model's thoughtSignature", () => {
    const params = buildGeminiParams(
      req({
        sdk: "gemini",
        provider_key: "gemini",
        model: "gemini-3-pro",
        messages: [minted("gemini", "gemini-2.5-pro", geminiSigned)],
      }),
    );

    expect(JSON.stringify(params.contents)).not.toContain("GEMINI_SIG");
  });

  test("gemini replays its own model's thoughtSignature", () => {
    const params = buildGeminiParams(
      req({
        sdk: "gemini",
        provider_key: "gemini",
        model: "gemini-2.5-pro",
        messages: [minted("gemini", "gemini-2.5-pro", geminiSigned)],
      }),
    );

    expect(JSON.stringify(params.contents)).toContain("GEMINI_SIG");
  });

  test("openrouter refuses another model's reasoning_details", () => {
    const { chatRequest } = buildCall(
      req({
        sdk: "openrouter",
        provider_key: "openrouter",
        model: "anthropic/claude-opus-5",
        messages: [minted("openrouter", "anthropic/claude-sonnet-5", openrouterCarried)],
      }),
      false,
    );

    expect(JSON.stringify(chatRequest.messages)).not.toContain("SONNET");
  });

  test("openrouter replays the same model's reasoning_details", () => {
    const { chatRequest } = buildCall(
      req({
        sdk: "openrouter",
        provider_key: "openrouter",
        model: "anthropic/claude-sonnet-5",
        messages: [minted("openrouter", "anthropic/claude-sonnet-5", openrouterCarried)],
      }),
      false,
    );

    expect(JSON.stringify(chatRequest.messages)).toContain("SONNET");
  });

  test("anthropic refuses a signature minted by another anthropic model", () => {
    const params = buildAnthropicParams(
      req({
        sdk: "anthropic",
        provider_key: "anthropic",
        model: "claude-sonnet-5",
        messages: [minted("anthropic", "claude-opus-5", anthropicSigned)],
      }),
    );

    expect(JSON.stringify(params.messages)).not.toContain("thinking");
  });
});
