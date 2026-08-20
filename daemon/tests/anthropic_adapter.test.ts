import { describe, expect, test } from "bun:test";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

import {
  anthropicStreamEvents,
  buildAnthropicParams,
  buildThinkingParams,
} from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";

function req(over: Partial<SidecarRequest>): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "anthropic/claude-opus-4.8",
    api_key: "k",
    messages: [],
    max_tokens: 8192,
    replay_prior_thinking: "all",
    ...over,
  };
}

type Rec = Record<string, unknown>;
function blockCC(content: unknown): boolean[] {
  if (!Array.isArray(content)) return [];
  return content.map((b) => (b as Rec)["cache_control"] !== undefined);
}

describe("cache placement (mirrors ts_default_placement)", () => {
  const system = [
    { text: "base", label: "system_base" },
    { text: "mem", label: "memory_index" },
  ];
  const messages: SidecarRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found" }] },
  ];

  test("system anchor lands on last non-memory_index block; no label on the wire", () => {
    const p = buildAnthropicParams(req({ system, messages, provider_options: { cache_ttl: "1h" } }));
    const sys = p.system as unknown as Rec[];
    expect(sys[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(sys[1]?.["cache_control"]).toBeUndefined();
    for (const b of sys) {
      expect(b).not.toHaveProperty("_label");
      expect(b).not.toHaveProperty("label");
    }
  });

  test("a single-block system prompt keeps its label and still anchors", () => {
    const anchored = buildAnthropicParams(
      req({
        system: [{ text: "you are a character", label: "character" }],
        messages,
        provider_options: { cache_ttl: "1h" },
      }),
    ).system as unknown as Rec[];
    expect(anchored[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });

    const churning = buildAnthropicParams(
      req({
        system: [{ text: "mem", label: "memory_index" }],
        messages,
        provider_options: { cache_ttl: "1h" },
      }),
    ).system as unknown as Rec[];
    expect(churning[0]?.["cache_control"]).toBeUndefined();
  });

  test("message breakpoints on [prev_frozen, frozen_boundary, last_msg], last block of each", () => {
    const p = buildAnthropicParams(req({ system, messages, provider_options: { cache_ttl: "1h" } }));
    const m = p.messages as Array<{ content: unknown }>;
    expect(blockCC(m[0]?.content)).toEqual([true]);
    expect(blockCC(m[1]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[2]?.content)).toEqual([true]);
    expect(blockCC(m[3]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[4]?.content)).toEqual([true]);
  });

  test("never exceeds the four-breakpoint provider limit", () => {
    const long: SidecarRequest["messages"] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: [{ type: "text" as const, text: `m${i}` }],
    }));
    const p = buildAnthropicParams(req({ system, messages: long, provider_options: { cache_ttl: "1h" } }));
    const msgMarkers = (p.messages as Array<{ content: unknown }>).reduce(
      (n, msg) => n + blockCC(msg.content).filter(Boolean).length,
      0,
    );
    const sysMarkers = (p.system as unknown as Rec[]).filter(
      (b) => b["cache_control"] !== undefined,
    ).length;
    expect(msgMarkers).toBe(3);
    expect(sysMarkers).toBe(1);
    expect(msgMarkers + sysMarkers).toBeLessThanOrEqual(4);
  });

  test("no cache_ttl → no markers anywhere", () => {
    const p = buildAnthropicParams(req({ system, messages }));
    const sys = p.system as unknown as Rec[];
    for (const b of sys) expect(b["cache_control"]).toBeUndefined();
    for (const m of p.messages as Array<{ content: unknown }>) {
      expect(blockCC(m.content).some(Boolean)).toBe(false);
    }
  });

  test("an empty trailing text block never reaches placement", () => {
    const withEmptyTail: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          { type: "text", text: "" },
        ],
      },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: withEmptyTail, provider_options: { cache_ttl: "1h" } }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    expect(blockCC(m[0]?.content)).toEqual([true]);
    expect(blockCC(m[2]?.content)).toEqual([true]);
  });

  test("a turn with no anchorable block walks back to the previous one", () => {
    const thinkingTail: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      {
        role: "assistant",
        provider_key: "anthropic",
        model: "anthropic/claude-opus-4.8",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    ];
    const p = buildAnthropicParams(
      req({
        system,
        messages: thinkingTail,
        provider_key: "anthropic",
        provider_options: { cache_ttl: "1h" },
      }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    expect(blockCC(m[3]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[2]?.content)).toEqual([true]);
  });

  test("a turn of only empty text is dropped, not sent empty", () => {
    const onlyEmpty: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: onlyEmpty, provider_options: { cache_ttl: "1h" } }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    expect(m).toHaveLength(1);
    expect(blockCC(m[0]?.content)).toEqual([true]);
  });

  test("image-only frozen boundary still anchors (regression: breakpoint was dropped)", () => {
    const imageBoundary: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ] as never,
      },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
      { role: "user", content: [{ type: "text", text: "q3" }] },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: imageBoundary, provider_options: { cache_ttl: "1h" } }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    expect(blockCC(m[2]?.content)).toEqual([true]);
    const blocks = m[2]?.content as Rec[] | undefined;
    expect(blocks?.[0]?.["cache_control"]).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(blockCC(m[4]?.content)).toEqual([true]);
  });

  test("a stale marker is stripped and placement still runs", () => {
    const marked: SidecarRequest["messages"] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } } as never],
      },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: marked, provider_options: { cache_ttl: "1h" } }),
    );

    const sys = p.system as unknown as Rec[];
    expect(sys.some((b) => b["cache_control"] !== undefined)).toBe(true);

    const m = p.messages as Array<{ content: unknown }>;
    const blocks = m[0]?.content as Rec[] | undefined;
    expect(blocks?.[0]?.["cache_control"]).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

describe("frozen-region anchor survives a last_turn thinking strip", () => {
  const system = [{ text: "base", label: "system_base" }];

  const stateN: SidecarRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "user", content: [{ type: "text", text: "q2" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deliberating", signature: "sig3" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ] as never,
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found" }] },
    { role: "assistant", content: [{ type: "text", text: "a5" }] },
    { role: "user", content: [{ type: "text", text: "q3" }] },
  ];

  const stateN1: SidecarRequest["messages"] = [
    ...stateN.slice(0, 3),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }] as never,
    },
    ...stateN.slice(4),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "new", signature: "sig7" },
        { type: "text", text: "a7" },
      ] as never,
    },
    { role: "user", content: [{ type: "text", text: "q4" }] },
  ];

  function anchoredMsgIndices(msgs: SidecarRequest["messages"]): number[] {
    const p = buildAnthropicParams(
      req({ system, messages: msgs, provider_options: { cache_ttl: "1h" } }),
    );
    return (p.messages as Array<{ content: unknown }>)
      .map((m, i) => (blockCC(m.content).some(Boolean) ? i : -1))
      .filter((i) => i >= 0);
  }

  function frozenAnchor(msgs: SidecarRequest["messages"]): number {
    const a = anchoredMsgIndices(msgs);
    expect(a.length).toBeGreaterThanOrEqual(2);
    return a[a.length - 2]!;
  }

  function prefix(msgs: SidecarRequest["messages"], idx: number): string {
    return JSON.stringify(msgs.slice(0, idx + 1));
  }

  test("anchors land on the two frozen boundaries and the last message", () => {
    expect(anchoredMsgIndices(stateN)).toEqual([0, 2, 6]);
    expect(anchoredMsgIndices(stateN1)).toEqual([2, 6, 8]);
  });

  test("request N+1's prev_frozen anchor is an exact hit on request N's frozen anchor", () => {
    const frozenN = frozenAnchor(stateN);
    const anchorsN1 = anchoredMsgIndices(stateN1);
    expect(anchorsN1).toContain(frozenN);
    expect(prefix(stateN1, frozenN)).toEqual(prefix(stateN, frozenN));
  });

  test("prefix through the request-N frozen anchor is byte-identical in N+1", () => {
    const frozen = frozenAnchor(stateN);
    expect(frozen).toBe(2);
    expect(prefix(stateN1, frozen)).toEqual(prefix(stateN, frozen));
  });

  test("regression: the old last_stable_assistant anchor would NOT have survived", () => {
    const oldAnchor = 5;
    expect(prefix(stateN1, oldAnchor)).not.toEqual(prefix(stateN, oldAnchor));
    const stripBoundary = 3;
    for (const a of anchoredMsgIndices(stateN)) {
      if (a >= stateN.length - 1) continue;
      expect(a).toBeLessThan(stripBoundary);
    }
  });

  test("under `all` (nothing stripped) every request-N anchor still reads in N+1", () => {
    const appended: SidecarRequest["messages"] = [
      ...stateN,
      { role: "assistant", content: [{ type: "text", text: "a7" }] },
      { role: "user", content: [{ type: "text", text: "q4" }] },
    ];
    const anchorsN = anchoredMsgIndices(stateN);
    expect(anchorsN[anchorsN.length - 1]).toBe(stateN.length - 1);
    for (const a of anchorsN) {
      expect(prefix(appended, a)).toEqual(prefix(stateN, a));
    }
  });

  test("tool-loop rounds still extend: iter-1 frozen boundary == iter-0 last_msg", () => {
    const iter0: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "compact now" }] },
    ];
    const iter1: SidecarRequest["messages"] = [
      ...iter0,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "compact", input: {} }] as never,
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }] },
    ];
    const a0 = anchoredMsgIndices(iter0);
    expect(a0[a0.length - 1]).toBe(2);
    expect(frozenAnchor(iter1)).toBe(2);
  });

  test("the turn after a multi-round tool loop keeps a surviving read", () => {
    const preLoop: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "compact now" }] },
    ];
    const round = (n: number): SidecarRequest["messages"] => [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `round ${n}`, signature: `sig${n}` },
          { type: "tool_use", id: `tu_${n}`, name: "compact", input: {} },
        ] as never,
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${n}`, content: `${n}` }] },
    ];
    const loopEnd: SidecarRequest["messages"] = [...preLoop, ...round(1), ...round(2), ...round(3)];
    const nextTurn: SidecarRequest["messages"] = [
      ...preLoop,
      ...[1, 2, 3].flatMap((n) => [
        {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: `tu_${n}`, name: "compact", input: {} }] as never,
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: `tu_${n}`, content: `${n}` }] as never,
        },
      ]),
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ];

    const frozenNext = frozenAnchor(nextTurn);
    expect(prefix(nextTurn, frozenNext)).not.toEqual(prefix(loopEnd, frozenNext));

    const anchorsLoop = anchoredMsgIndices(loopEnd);
    const anchorsNext = anchoredMsgIndices(nextTurn);
    const survivor = anchorsNext.find(
      (a) => anchorsLoop.includes(a) && prefix(nextTurn, a) === prefix(loopEnd, a),
    );
    expect(survivor).toBe(2);
  });
});

describe("image blocks", () => {
  const imageMessages: SidecarRequest["messages"] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "what is this?" },
      ] as never,
    },
  ];

  test("image block passes through without throwing and reaches the wire", () => {
    const p = buildAnthropicParams(req({ messages: imageMessages, provider_options: { cache_ttl: "1h" } }));
    const m = p.messages as Array<{ content: unknown }>;
    const content = m[0]?.content as Rec[];
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(blockCC(content)).toEqual([false, true]);
  });
});

describe("thinking params per model", () => {
  test("opus-4.8 + named effort → adaptive+summarized + output_config", () => {
    const r = buildThinkingParams({ reasoning_effort: "xhigh" }, "anthropic/claude-opus-4.8", 8192);
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.outputConfig).toEqual({ effort: "xhigh" });
  });

  test('opus-4.8 + literal "adaptive" → adaptive, NO output_config', () => {
    const r = buildThinkingParams({ reasoning_effort: "adaptive" }, "anthropic/claude-opus-4.8", 8192);
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.outputConfig).toBeUndefined();
  });

  test("effort is sent as adaptive + output_config on every model, not a derived budget", () => {
    for (const model of [
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-3-opus",
    ]) {
      const r = buildThinkingParams({ reasoning_effort: "high" }, model, 32000);
      expect(r.thinking, model).toEqual({ type: "adaptive", display: "summarized" });
      expect(r.outputConfig, model).toEqual({ effort: "high" });
    }
  });

  test("an explicit budget is the only way to get enabled thinking", () => {
    const r = buildThinkingParams({ budget_tokens: 8192 }, "anthropic/claude-haiku-4.5", 32000);
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(r.outputConfig).toBeUndefined();
  });

  test("an explicit budget wins over an effort", () => {
    const r = buildThinkingParams(
      { reasoning_effort: "high", budget_tokens: 4096 },
      "anthropic/claude-opus-4.8",
      32000,
    );
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("opus-4.6 (permissive) + effort → prefers adaptive", () => {
    const r = buildThinkingParams({ reasoning_effort: "high" }, "anthropic/claude-opus-4.6", 8192);
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.outputConfig).toEqual({ effort: "high" });
  });

  test("no thinking opts → nothing", () => {
    expect(buildThinkingParams({}, "anthropic/claude-opus-4.8", 8192)).toEqual({});
  });

  test("a budget with max_tokens too small drops thinking rather than sending a 400", () => {
    const r = buildThinkingParams({ budget_tokens: 8192 }, "anthropic/claude-sonnet-4.5", 512);
    expect(r.thinking).toBeUndefined();
  });
});

describe("provider routing", () => {
  test("openrouter_provider with order → allow_fallbacks injected", () => {
    const p = buildAnthropicParams(
      req({
        base_url: "https://openrouter.ai/api/v1",
        provider_options: { openrouter_provider: { order: ["Anthropic"] } },
      }),
    );
    expect((p as unknown as Rec)["provider"]).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
  });

  test("base_url alone does NOT auto-pin a provider", () => {
    const p = buildAnthropicParams(req({ base_url: "https://openrouter.ai/api/v1" }));
    expect((p as unknown as Rec)["provider"]).toBeUndefined();
  });
});

describe("inline system messages", () => {
  test("role:system turn is wrapped into a user <system_instruction>", () => {
    const p = buildAnthropicParams(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "hey" }] },
          { role: "system", content: [{ type: "text", text: "be brief" }] },
        ],
      }),
    );
    const m = p.messages as Array<{ role: string; content: unknown }>;
    expect(m.every((x) => x.role !== "system")).toBe(true);
    expect(JSON.stringify(m)).toContain("<system_instruction>be brief</system_instruction>");
  });
});

function asEvent(e: unknown): RawMessageStreamEvent {
  return e as RawMessageStreamEvent;
}
async function* fakeEvents(arr: unknown[]): AsyncIterable<RawMessageStreamEvent> {
  for (const e of arr) yield asEvent(e);
}
function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("maps thinking+signature+text+tool_use SSE to StreamEvents in order", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_9", name: "search" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];

  const out = await collect(
    anthropicStreamEvents("anthropic/claude-opus-4.8", fakeEvents(events), fakeClock()),
  );

  expect(out[0]).toEqual({ type: "start", model: "anthropic/claude-opus-4.8" });
  expect(out[1]).toEqual({ type: "thinking", text: "reason" });
  expect(out[2]).toEqual({ type: "thinking_signature", signature: "sig123" });
  expect(out[3]).toEqual({ type: "text", text: "answer" });
  expect(out[4]).toEqual({ type: "tool_use", id: "tu_9", name: "search", input: { q: "x" } });

  const done = out[5];
  expect(done?.type).toBe("done");
  if (done?.type === "done") {
    expect(done.content).toBe("answer");
    expect(done.finish_reason).toBe("tool_use");
    expect(done.usage.input_tokens).toBe(50);
    expect(done.usage.output_tokens).toBe(30);
  }
  expect(out.length).toBe(6);
});

test("emits error frame with the message_start cache write when the stream throws", async () => {
  async function* throwingEvents(): AsyncIterable<RawMessageStreamEvent> {
    yield asEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 2,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19_188,
        },
      },
    });
    throw new Error("connection reset");
  }

  const out = await collect(
    anthropicStreamEvents("anthropic/claude-opus-4.8", throwingEvents(), fakeClock()),
  );

  expect(out[0]).toEqual({ type: "start", model: "anthropic/claude-opus-4.8" });
  const last = out[out.length - 1];
  expect(last?.type).toBe("error");
  if (last?.type === "error") {
    expect(last.message).toBe("connection reset");
    expect(last.usage.cache_creation_tokens).toBe(19_188);
    expect(last.usage.input_tokens).toBe(2);
  }
  expect(out.some((e) => e.type === "done")).toBe(false);
});
