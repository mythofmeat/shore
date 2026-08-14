import { describe, expect, test } from "bun:test";

import { replayableMessages } from "../src/llm/replay.ts";
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

describe("carrier-less thinking", () => {
  const uncarried = thinkingTurn({ type: "thinking", thinking: "private chain" });

  test("is dropped for Anthropic, which rejects an unsigned thinking block", () => {
    const out = replayableMessages(req({ messages: [uncarried] }));
    expect(types(out)).toEqual([["text"]]);
  });

  test("survives on the dialects that echo raw reasoning back", () => {
    for (const sdk of ["openai", "zai", "deepseek", "moonshot"] as const) {
      const out = replayableMessages(
        req({ sdk, model: "m", provider_key: sdk, messages: [uncarried] }),
      );
      expect(types(out), `${sdk} must keep uncarried thinking`).toEqual([["thinking", "text"]]);
    }
  });
});

describe("replay portability", () => {
  const signed = { type: "thinking", thinking: "t", signature: "sig" };

  test("thinking minted by the active model is replayed", () => {
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

  test("a foreign carrier is dropped when provenance is unknown", () => {
    const out = replayableMessages(
      req({
        messages: [
          thinkingTurn({ type: "thinking", thinking: "t", reasoning_details: [{ x: 1 }] }),
        ],
      }),
    );
    expect(types(out)).toEqual([["text"]]);
  });

  test("a plain legacy blob with no provenance is kept", () => {
    const out = replayableMessages(req({ messages: [thinkingTurn(signed)] }));
    expect(types(out)).toEqual([["thinking", "text"]]);
  });

  test("an OpenRouter-tagged redacted blob is kept only on OpenRouter", () => {
    const blob = {
      role: "assistant" as const,
      content: [
        { type: "redacted_thinking" as const, data: "openrouter.reasoning:abc" },
        { type: "text" as const, text: "answer" },
      ],
    };
    expect(types(replayableMessages(req({ messages: [blob] })))).toEqual([["text"]]);
    expect(
      types(
        replayableMessages(
          req({ sdk: "openrouter", provider_key: "openrouter", messages: [blob] }),
        ),
      ),
    ).toEqual([["redacted_thinking", "text"]]);
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

  test("`all` keeps prior thinking", () => {
    expect(types(replayableMessages(req({ messages: history })))).toEqual([
      ["text"],
      ["thinking", "text"],
      ["text"],
    ]);
  });

  test("`none` strips it from assistant history", () => {
    const out = replayableMessages(req({ messages: history, replay_prior_thinking: "none" }));
    expect(types(out)).toEqual([["text"], ["text"], ["text"]]);
  });

  test("the provider floor overrides `none` where the API demands replay", () => {
    for (const provider of ["moonshot", "moonshotai"]) {
      const own: WireMessage[] = history.map((m) =>
        m.role === "assistant" ? { ...m, provider_key: provider, model: "reasoner" } : m,
      );
      const out = replayableMessages(
        req({
          sdk: "deepseek",
          model: "reasoner",
          provider_key: provider,
          messages: own,
          replay_prior_thinking: "none",
        }),
      );
      expect(types(out)[1], `${provider} must keep prior reasoning`).toEqual(["thinking", "text"]);
    }
  });

  test("portability still wins over the floor: a foreign signature is dropped", () => {
    const out = replayableMessages(
      req({
        sdk: "moonshot",
        model: "reasoner",
        provider_key: "moonshot",
        messages: history,
        replay_prior_thinking: "none",
      }),
    );
    expect(types(out)[1]).toEqual(["text"]);
  });

  test("deepseek is not on the floor: `none` strips there like anywhere else", () => {
    const own: WireMessage[] = history.map((m) =>
      m.role === "assistant" ? { ...m, provider_key: "deepseek", model: "reasoner" } : m,
    );
    const out = replayableMessages(
      req({
        sdk: "deepseek",
        model: "reasoner",
        provider_key: "deepseek",
        messages: own,
        replay_prior_thinking: "none",
      }),
    );
    expect(types(out)[1]).toEqual(["text"]);
  });

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
