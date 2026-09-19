import { describe, expect, test } from "bun:test";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";
import { buildAnthropicParams } from "../src/llm/providers/anthropic.ts";
import { buildGeminiParams } from "../src/llm/providers/gemini.ts";
import { applyPromptCaching, buildOpenAIMessages, buildOpenAIMessagesWithTail } from "../src/llm/providers/openai.ts";
import { buildCall } from "../src/llm/providers/vercel.ts";
import { buildZaiMessages } from "../src/llm/providers/zai.ts";
import type { Sdk, SidecarRequest } from "../src/llm/types.ts";
import { preprocessRequest } from "../src/llm/request.ts";
import { appendCompactionTail } from "../src/memory/compaction/llm.ts";
import { required } from "../src/util/required.ts";

const COMPACTION_PROMPT = "Compaction task.\n\nCompaction rules.";

function request(sdk: Sdk, prompt = COMPACTION_PROMPT): SidecarRequest {
  const req: SidecarRequest = {
    sdk, provider_key: sdk, model: "anthropic/claude-sonnet-5", api_key: "test-key",
    system: [{ label: "prompt", text: "Stable character instructions." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello." }] },
      { role: "assistant", content: [{ type: "text", text: "Hi." }] },
    ],
    max_tokens: 100, replay_prior_thinking: "all",
  };
  appendCompactionTail(req, prompt);
  return req;
}

const providers: Array<{ sdk: Sdk; messages: (req: SidecarRequest) => unknown }> = [
  { sdk: "anthropic", messages: req => buildAnthropicParams(req).messages },
  { sdk: "openai", messages: buildOpenAIMessages },
  { sdk: "nanogpt", messages: buildOpenAIMessages },
  { sdk: "zai", messages: buildZaiMessages },
  { sdk: "gemini", messages: req => buildGeminiParams(req).contents },
  { sdk: "openrouter", messages: req => buildCall(req).messages },
  { sdk: "deepseek", messages: req => buildCall(req).messages },
  { sdk: "moonshot", messages: req => buildCall(req).messages },
];

describe("compaction user instructions at provider boundaries", () => {
  test.each(providers)("$sdk receives the complete prompt in one user message", ({ sdk, messages }) => {
    const req = request(sdk);
    if (sdk !== "nanogpt") req.model = "fixture-model";
    const before = structuredClone(req);
    const sent = messages(req) as Array<{ role: string; content?: unknown; parts?: unknown }>;
    const tail = required(sent.at(-1));
    expect(tail.role).toBe("user");
    const text = JSON.stringify(tail.content ?? tail.parts);
    expect(text).toContain("Compaction task.");
    expect(text).toContain("Compaction rules.");
    expect(text.indexOf("Compaction task.")).toBeLessThan(text.indexOf("Compaction rules."));
    expect(JSON.stringify(sent.slice(0, -1))).not.toContain("Compaction");
    expect(JSON.stringify(sent)).not.toContain("transient_tail");
    expect(req).toEqual(before);
  });
});

describe("compaction cache boundaries", () => {
  for (const sdk of ["anthropic", "nanogpt"] as const) {
    test.each([
      { prompt: COMPACTION_PROMPT, orphan: false, guidance: false },
      { prompt: "", orphan: false, guidance: false },
      { prompt: " \n ", orphan: false, guidance: false },
      { prompt: COMPACTION_PROMPT, orphan: true, guidance: false },
      { prompt: COMPACTION_PROMPT, orphan: false, guidance: true },
    ])(`${sdk} keeps the cache boundary before the compaction prompt: %j`, ({ prompt, orphan, guidance }) => {
      let req = request(sdk, prompt);
      if (orphan) required(req.messages[1]).content.push({ type: "tool_use", id: "orphan", name: "read", input: {} });
      if (guidance) req.messages.splice(1, 0, { role: "system", content: [{ type: "text", text: "Earlier guidance." }] });
      req = preprocessRequest(req);
      req.provider_options = { cache_ttl: "1h" };
      for (let round = 0; round < 3; round += 1) {
        const before = structuredClone(req);
        let messages: unknown;
        if (sdk === "anthropic") {
          messages = buildAnthropicParams(req).messages;
        } else {
          const converted = buildOpenAIMessagesWithTail(req);
          const params: ChatCompletionCreateParams = { model: req.model, messages: converted.messages };
          applyPromptCaching(req, params, converted.transientTail);
          messages = params.messages;
        }
        const marked = (messages as Array<{ content: unknown }>).flatMap(message =>
          Array.isArray(message.content)
            ? (message.content as Array<{ text?: string; cache_control?: unknown }>).filter(block => block.cache_control !== undefined)
            : []);
        expect(marked.map(block => block.text)).toContain(prompt.trim() === "" ? "Hello." : "Hi.");
        expect(marked.map(block => block.text)).not.toContain(prompt);
        expect(JSON.stringify(messages)).not.toContain("transient_tail");
        expect(req).toEqual(before);
        req.messages.push(
          { role: "assistant", content: [{ type: "tool_use", id: `call-${round}`, name: "read", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${round}`, content: "memory" }] },
        );
      }
    });
  }
});
