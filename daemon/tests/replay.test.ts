import { describe, expect, test } from "bun:test";

import { replayableMessages, replayableMessagesWithDrops } from "../src/llm/replay.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

function req(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-opus-4-8",
    provider_key: "anthropic",
    api_key: "k",
    messages: [],
    max_tokens: 64,
    replay_prior_thinking: "all",
    ...over,
  };
}

function thinkingTurn(block: Record<string, unknown>, provenance: Partial<WireMessage> = {}) {
  return {
    role: "assistant" as const,
    content: [block as never, { type: "text" as const, text: "answer" }],
    ...provenance,
  };
}

const types = (msgs: WireMessage[]): string[][] => msgs.map((m) => m.content.map((b) => b.type));

describe("an opaque block travels only to the model that minted it", () => {
  const uncarried = thinkingTurn({ type: "thinking", thinking: "private chain" });
  const signed = { type: "thinking", thinking: "t", signature: "sig" };

  test("a block carrying nothing opaque survives on every sdk", () => {
    for (const sdk of ["anthropic", "openai", "zai", "deepseek", "moonshot", "gemini"] as const) {
      const out = replayableMessages(
        req({ sdk, model: "m", provider_key: sdk, messages: [uncarried] }),
      );
      expect(types(out), `${sdk} must keep uncarried thinking`).toEqual([["thinking", "text"]]);
    }
  });

  test("thinking minted by the active provider and model travels", () => {
    const out = replayableMessages(
      req({
        messages: [thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-8" })],
      }),
    );
    expect(types(out)).toEqual([["thinking", "text"]]);
  });

  test("thinking minted by another model of the same provider is dropped", () => {
    const out = replayableMessages(
      req({
        messages: [thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-6" })],
      }),
    );
    expect(types(out)).toEqual([["text"]]);
  });

  test("thinking minted by another provider is dropped on every sdk", () => {
    for (const sdk of ["anthropic", "openai", "zai", "gemini", "openrouter", "moonshot"] as const) {
      const out = replayableMessages(
        req({
          sdk,
          model: "m",
          provider_key: sdk,
          messages: [thinkingTurn(signed, { provider_key: "somewhere-else", model: "m" })],
        }),
      );
      expect(types(out), `${sdk} must refuse a foreign signature`).toEqual([["text"]]);
    }
  });

  test("a foreign carrier with unknown provenance is dropped", () => {
    const out = replayableMessages(
      req({
        messages: [
          thinkingTurn({ type: "thinking", thinking: "t", reasoning_details: [{ x: 1 }] }),
        ],
      }),
    );
    expect(types(out)).toEqual([["text"]]);
  });

  test("a signed block with no provenance at all is dropped rather than assumed", () => {
    const out = replayableMessages(req({ messages: [thinkingTurn(signed)] }));
    expect(types(out)).toEqual([["text"]]);
  });

  test("an OpenRouter-tagged redacted blob travels only back to OpenRouter", () => {
    const blob = {
      role: "assistant" as const,
      content: [
        { type: "redacted_thinking" as const, data: "openrouter.reasoning:abc" },
        { type: "text" as const, text: "answer" },
      ],
    };
    expect(
      types(replayableMessages(req({ sdk: "openrouter", provider_key: "openrouter", messages: [blob] }))),
    ).toEqual([["redacted_thinking", "text"]]);

    for (const sdk of ["anthropic", "moonshot"] as const) {
      expect(
        types(replayableMessages(req({ sdk, provider_key: sdk, messages: [blob] }))),
        `${sdk} must refuse an OpenRouter blob`,
      ).toEqual([["text"]]);
    }
  });
});

describe("prior-thinking replay setting", () => {
  const history: WireMessage[] = [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      provider_key: "anthropic",
      model: "claude-opus-4-8",
      content: [
        { type: "thinking", thinking: "t1", signature: "s1" },
        { type: "text", text: "a1" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ];

  test("the same history always projects to the same bytes", () => {
    for (const mode of ["all", "none"] as const) {
      const r = req({ messages: history, replay_prior_thinking: mode });
      expect(JSON.stringify(replayableMessages(r))).toEqual(
        JSON.stringify(replayableMessages(r)),
      );
    }
  });

  test("a request's prefix is stable as turns are appended", () => {
    for (const mode of ["all", "none"] as const) {
      const prev = replayableMessages(req({ messages: history, replay_prior_thinking: mode }));
      const next = replayableMessages(
        req({
          messages: [...history, { role: "assistant", content: [{ type: "text", text: "a2" }] }],
          replay_prior_thinking: mode,
        }),
      );
      expect(next.slice(0, prev.length)).toEqual(prev);
    }
  });
});

describe("empty content", () => {
  test("whitespace-only text blocks are removed", () => {
    const out = replayableMessages(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
              { type: "text", text: "  " },
            ],
          },
        ],
      }),
    );
    expect(types(out)).toEqual([["tool_result"]]);
  });

  test("a turn left with nothing is dropped rather than sent empty", () => {
    const out = replayableMessages(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "" }] },
        ],
      }),
    );
    expect(out).toHaveLength(1);
  });
});

describe("what replay keeps and counts", () => {
  const thinking = (extra: Record<string, unknown>) => ({ type: "thinking", thinking: "t", ...extra });

  test("a foreign carrier from the active provider is dropped unless the same model minted it, while a redacted blob from that provider travels", () => {
    const fromProvider = { provider_key: "anthropic" };
    const kept = (block: Record<string, unknown>, provenance: Partial<WireMessage>) => types(replayableMessages(req({ messages: [thinkingTurn(block, provenance)] })));
    expect(kept(thinking({ reasoning_details: [{ text: "x" }] }), fromProvider)).toEqual([["text"]]);
    expect(kept(thinking({ reasoning_content: "x" }), fromProvider)).toEqual([["text"]]);
    expect(kept(thinking({ reasoning_content: "x" }), { provider_key: "anthropic", model: "claude-opus-4-8" })).toEqual([["thinking", "text"]]);
    expect(kept({ type: "redacted_thinking", data: "blob" }, fromProvider)).toEqual([["redacted_thinking", "text"]]);
    expect(kept(thinking({ signature: "sig" }), fromProvider), "a signed block from the active provider, model unknown").toEqual([["thinking", "text"]]);
    expect(kept(thinking({ signature: "sig" }), { provider_key: "zai" })).toEqual([["text"]]);
  });

  test("drops are counted by why they happened", () => {
    const foreign = thinkingTurn(thinking({ signature: "sig" }), { provider_key: "zai", model: "glm" });
    const own = thinkingTurn(thinking({ signature: "sig" }), { provider_key: "anthropic", model: "claude-opus-4-8" });
    expect(replayableMessagesWithDrops(req({ messages: [foreign, foreign] })).drops).toEqual({ strippedByPolicy: 0, unportable: 2 });
    expect(replayableMessagesWithDrops(req({ replay_prior_thinking: "none", messages: [own] })).drops).toEqual({ strippedByPolicy: 1, unportable: 0 });
    expect(replayableMessagesWithDrops(req({ messages: [own] })).drops).toEqual({ strippedByPolicy: 0, unportable: 0 });
  });

  test("with prior thinking off, a turn that called a tool keeps its thinking for the loop, and other turns lose theirs", () => {
    const plain = thinkingTurn(thinking({ signature: "sig" }), { provider_key: "anthropic", model: "claude-opus-4-8" });
    const calling: WireMessage = { role: "assistant", content: [thinking({ signature: "sig" }) as never, { type: "tool_use", id: "t1", name: "read", input: {} }], provider_key: "anthropic", model: "claude-opus-4-8" };
    const user: WireMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(types(replayableMessages(req({ replay_prior_thinking: "none", messages: [user, plain, calling] })))).toEqual([["text"], ["text"], ["thinking", "tool_use"]]);
  });

  test("a turn's transient tail counts only the tail blocks that are kept, and a turn without one gets none", () => {
    const tailed: WireMessage = { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "c" }, { type: "text", text: "  " }, { type: "text", text: "d" }], transient_tail: 3 };
    const plain: WireMessage = { role: "user", content: [{ type: "text", text: "e" }] };
    const out = replayableMessages(req({ messages: [tailed, plain] }));
    expect(out[0]).toStrictEqual({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "c" }, { type: "text", text: "d" }], transient_tail: 2 });
    expect(out[1]).toStrictEqual(plain);
  });
});
