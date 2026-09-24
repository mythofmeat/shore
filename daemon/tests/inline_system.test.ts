import { describe, expect, test } from "bun:test";

import { foldInlineSystemMessages, translatesToAnthropic } from "../src/llm/inline_system.ts";
import { buildOpenAIMessages } from "../src/llm/providers/openai.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("foldInlineSystemMessages", () => {
  test("a trailing system turn merges into the user turn before it", () => {
    const out = foldInlineSystemMessages([
      { role: "user", content: text("write me a haiku") },
      { role: "assistant", content: text("...") },
      { role: "user", content: text("again") },
      { role: "system", content: text("be terse") },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2]?.content).toEqual([
      { type: "text", text: "again" },
      { type: "text", text: "be terse" },
    ]);
  });

  test("a system turn after an assistant turn becomes its own user turn", () => {
    const out = foldInlineSystemMessages([
      { role: "user", content: text("hi") },
      { role: "assistant", content: text("hello") },
      { role: "system", content: text("be terse") },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2]?.content).toEqual([{ type: "text", text: "be terse" }]);
  });

  test("it does not mutate the turns it was given", () => {
    const turns: WireMessage[] = [
      { role: "user", content: text("again") },
      { role: "system", content: text("be terse") },
    ];
    foldInlineSystemMessages(turns);
    expect(turns[0]?.content).toEqual([{ type: "text", text: "again" }]);
  });

  test("turns without a system role are passed through", () => {
    const turns: WireMessage[] = [
      { role: "user", content: text("hi") },
      { role: "assistant", content: text("hello") },
    ];
    expect(foldInlineSystemMessages(turns)).toEqual(turns);
  });
});

describe("the fold is scoped to models that translate to Anthropic", () => {
  const conversation = [
    { role: "user", content: text("write me a haiku") },
    { role: "system", content: text("guidance: be terse") },
  ];

  const openAiRequest = (model: string) =>
    ({
      model,
      sdk: "nanogpt",
      api_key: "k",
      max_tokens: 16,
      system: [{ label: "prompt", text: "you are heidi" }],
      messages: conversation,
    }) as unknown as SidecarRequest;

  test("an Anthropic model behind nano-gpt gets guidance on the user turn", () => {
    const msgs = buildOpenAIMessages(openAiRequest("anthropic/claude-opus-4.6"));
    expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
    expect(msgs[0]?.content).toBe("you are heidi");
    expect(msgs.at(-1)?.role).toBe("user");
    expect(JSON.stringify(msgs.at(-1))).toContain("guidance: be terse");
  });

  test("a non-Anthropic model keeps its inline system message", () => {
    const msgs = buildOpenAIMessages(openAiRequest("kimi-k2-thinking"));
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(msgs.at(-1)?.content).toBe("guidance: be terse");
  });

  test("thinking suffixes do not hide an Anthropic model from the gate", () => {
    expect(translatesToAnthropic("anthropic/claude-opus-4.6:thinking:max")).toBe(true);
    expect(translatesToAnthropic("glm-5.1")).toBe(false);
    expect(translatesToAnthropic("deepseek-reasoner")).toBe(false);
  });
});
