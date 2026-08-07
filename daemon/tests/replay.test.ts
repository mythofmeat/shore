/**
 * The three decisions that moved here from the daemon's `content_util.rs`.
 *
 * They ran on the wrong side for the whole life of the sidecar, and had already
 * drifted: the daemon's chat path kept carrier-less thinking for DeepSeek and
 * Moonshot while every tool-loop continuation path stripped it — on the two
 * providers whose APIs reject a request that omits prior `reasoning_content`.
 * The first test below is that case.
 */

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

/** An assistant turn carrying one thinking block plus visible text. */
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
    // The drift this pins: DeepSeek and Moonshot *require* prior
    // reasoning_content, and the daemon's continuation paths were stripping it.
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
    // Provider alone is too coarse: one aggregator key fronts many families,
    // and a signature from the wrong family hard-fails the request.
    const out = replayableMessages(
      req({
        messages: [thinkingTurn(signed, { provider_key: "anthropic", model: "claude-opus-4-6" })],
      }),
    );
    expect(types(out)).toEqual([["text"]]);
  });

  test("a foreign carrier is dropped when provenance is unknown", () => {
    // The backstop that keeps a provenance-free legacy history from sailing
    // onto the Anthropic wire with an OpenRouter payload attached.
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
    // Stripping these would bust working same-provider histories that predate
    // provenance tracking.
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
    for (const provider of ["deepseek", "moonshot", "moonshotai"]) {
      // Minted by the same provider/model — the floor governs the *setting*,
      // not portability, and a foreign signature is still dropped either way.
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
    // The floor says "never strip for this provider"; replaying a signature
    // the provider cannot read fails the request outright, so it goes anyway.
    const out = replayableMessages(
      req({
        sdk: "deepseek",
        model: "reasoner",
        provider_key: "deepseek",
        messages: history,
        replay_prior_thinking: "none",
      }),
    );
    expect(types(out)[1]).toEqual(["text"]);
  });

  test("the same history always projects to the same bytes", () => {
    // What makes the keepalive ping byte-identical to the request it pings.
    // The daemon used to filter before sending, so identity depended on when it
    // ran; now it is a pure function of the stored history.
    for (const mode of ["all", "none"] as const) {
      const r = req({ messages: history, replay_prior_thinking: mode });
      expect(JSON.stringify(replayableMessages(r))).toEqual(
        JSON.stringify(replayableMessages(r)),
      );
    }
  });

  test("a request's prefix is stable as turns are appended", () => {
    // The property the whole cache design rests on: bytes already sent must
    // render identically in the next request, or every breakpoint at or past
    // them is dead. This is what the retired `last_turn` mode violated.
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
    // An empty content array is rejected by every provider and fails the whole
    // request, not just the turn.
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
