import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

import {
  anthropicContentEvents,
  anthropicStreamEvents,
  buildAnthropicParams,
  buildAnthropicPlan,
  buildThinkingParams,
  dropUnverifiableThinking,
  newTurnAccumulator,
  placeBreakpoints,
  placeContinuationBreakpoints,
} from "../src/llm/providers/anthropic.ts";
import { assistantTurnStart, messageBreakpoints, type PlacementTurn } from "../src/llm/cache_placement.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { resolvedModelFromParts } from "../src/config/models.ts";
import { settingSchema } from "../src/llm/settings.ts";
import { collect, tickingClock } from "./support/stream.ts";

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
    return required(a[a.length - 2]);
  }

  function prefix(msgs: SidecarRequest["messages"], idx: number): string {
    return JSON.stringify(msgs.slice(0, idx + 1));
  }

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

describe("sampling parameters", () => {
  test("temperature and top_p never reach the wire", () => {
    const p = buildAnthropicParams(req({ temperature: 0.7, top_p: 0.9 })) as unknown as Rec;
    expect(p["temperature"]).toBeUndefined();
    expect(p["top_p"]).toBeUndefined();
  });

  test("a configured temperature or top_p is dropped and not offered", () => {
    const model = resolvedModelFromParts("opus", "anthropic:opus", "chat", "anthropic", "claude-opus-4-8", "anthropic", { sdk: "anthropic", temperature: 0.7, topP: 0.9 });
    expect(model.temperature).toBeUndefined();
    expect(model.topP).toBeUndefined();
    const offered = settingSchema("anthropic").filter((entry) => entry.applicability !== "rejected").map((entry) => entry.key);
    expect(offered).not.toContain("temperature");
    expect(offered).not.toContain("top_p");
    expect(settingSchema("openrouter").find((entry) => entry.key === "temperature")?.applicability).toBe("honored");
  });
});

describe("thinking params per model", () => {

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
  test("no thinking opts → nothing", () => {
    expect(buildThinkingParams({}, "anthropic/claude-opus-4.8", 8192)).toEqual({});
  });

  test("a budget with max_tokens too small drops thinking rather than sending a 400", () => {
    const r = buildThinkingParams({ budget_tokens: 8192 }, "anthropic/claude-sonnet-4.5", 512);
    expect(r.thinking).toBeUndefined();
  });
});

describe("inline system messages", () => {
  test("role:system turn becomes a user block without changing its text", () => {
    const guidance = "Please use ask_memory before responding.";
    const p = buildAnthropicParams(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "hey" }] },
          { role: "system", content: [{ type: "text", text: guidance }] },
        ],
      }),
    );
    const m = p.messages as Array<{ role: string; content: unknown }>;
    expect(m.every((x) => x.role !== "system")).toBe(true);
    expect((m[0]?.content as Array<{ text?: string }> | undefined)?.[1]?.text).toBe(guidance);
  });
});

function asEvent(e: unknown): RawMessageStreamEvent {
  return e as RawMessageStreamEvent;
}
async function* fakeEvents(arr: unknown[]): AsyncIterable<RawMessageStreamEvent> {
  for (const e of arr) yield asEvent(e);
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
    anthropicStreamEvents("anthropic/claude-opus-4.8", fakeEvents(events), tickingClock()),
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

describe("where cache anchors go", () => {
  const u: PlacementTurn = { role: "user", toolResultOnly: false };
  const a: PlacementTurn = { role: "assistant", toolResultOnly: false };
  const r: PlacementTurn = { role: "user", toolResultOnly: true };
  const s: PlacementTurn = { role: "system", toolResultOnly: false };

  test("the answer being given starts at the last assistant turn and runs back through its tool loop", () => {
    expect(assistantTurnStart([])).toBe(0);
    expect(assistantTurnStart([u])).toBe(1);
    expect(assistantTurnStart([a])).toBe(0);
    expect(assistantTurnStart([u, a])).toBe(1);
    expect(assistantTurnStart([u, a, r, a])).toBe(1);
    expect(assistantTurnStart([a, r, a, u])).toBe(0);
    expect(assistantTurnStart([u, a, u, a])).toBe(3);
    expect(assistantTurnStart([s, a])).toBe(1);
    expect(assistantTurnStart([u, a, r, r, a])).toBe(1);
  });

  test("anchors sit on the newest turn, the turn before the current answer and the turn before the previous one, oldest first", () => {
    expect(messageBreakpoints([])).toEqual([]);
    expect(messageBreakpoints([u])).toEqual([0]);
    expect(messageBreakpoints([u, u, u])).toEqual([2]);
    expect(messageBreakpoints([u, a, u])).toEqual([0, 2]);
    expect(messageBreakpoints([u, a, u, a, u, a, u])).toEqual([2, 4, 6]);
    expect(messageBreakpoints([u, a, r, a, u])).toEqual([0, 4]);
  });
});

describe("placing cache markers", () => {
  const cc = { type: "ephemeral" } as const;
  type Param = Parameters<typeof placeBreakpoints>[0][number];
  type Sys = Parameters<typeof placeBreakpoints>[1][number];
  const marked = (messages: Param[]): unknown[][] =>
    messages.map((m) => (Array.isArray(m.content) ? m.content.map((b) => "cache_control" in b) : []));

  test("system and message markers are counted, placed on the last block that takes one, and capped at four", () => {
    const messages: Param[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: "plain" },
      { role: "user", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "b" }, { type: "text", text: "transient" }] },
    ];
    const system: Sys[] = [{ type: "text", text: "s1" }, { type: "text", text: "s2" }];
    expect(placeBreakpoints(messages, system, cc, [3, 2, 1], [0, 1, 5], [0, 0, 0, 1])).toEqual({ requested: 6, placed: 4, droppedNoAnchor: 1, droppedOverLimit: 1 });
    expect(system.map((b) => "cache_control" in b)).toEqual([true, true]);
    expect(marked(messages)).toEqual([[true], [], [false], [true, false]]);
  });

  test("a marker never lands twice on one message, and thinking can't hold one but images and tool blocks can", () => {
    const messages: Param[] = [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: {} }, { type: "thinking", thinking: "x", signature: "s" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
    ];
    expect(placeBreakpoints(messages, [], cc, [3, 2, 2, 1, 0], [])).toEqual({ requested: 5, placed: 3, droppedNoAnchor: 2, droppedOverLimit: 0 });
    expect(marked(messages)).toEqual([[true], [true, false], [true], [false]]);
  });

  test("continuing a loop clears old markers first, and with caching off touches nothing", () => {
    const system: Sys[] = [{ type: "text", text: "s1", cache_control: cc }];
    const messages: Param[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: cc }] },
      { role: "user", content: [{ type: "text", text: "c" }] },
      { role: "assistant", content: "plain" },
    ];
    expect(placeContinuationBreakpoints(messages, system, [{ text: "s1", label: "memory_index" }], "")).toEqual({ msgBp: [], sysBp: [] });
    expect(marked(messages)).toEqual([[false], [true], [false], []]);
    const placed = placeContinuationBreakpoints(messages, system, [{ text: "s1", label: "memory_index" }], "5m");
    expect(placed).toEqual({ msgBp: [0, 2, 3], sysBp: [] });
    expect(marked(messages)).toEqual([[true], [false], [true], []]);
    expect(system.map((b) => "cache_control" in b)).toEqual([false]);
  });

  test("the request plan reports how many markers were asked for and where they went", () => {
    const plan = buildAnthropicPlan(req({
      provider_options: { cache_ttl: "1h" },
      system: [{ text: "be kind", label: "soul" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    }));
    expect(plan.placement).toMatchObject({ cache_enabled: true, has_existing_markers: false, msg_count: 3, sys_blocks: 1, breakpoints_dropped_no_anchor: 0, breakpoints_dropped_over_limit: 0 });
    expect(plan.placement.breakpoints_placed).toBe(plan.placement.breakpoints_requested);
    expect(plan.placement.breakpoints_requested).toBe(plan.placement.msg_breakpoints.length + plan.placement.sys_breakpoints.length);
  });
});

describe("thinking replayed to Anthropic", () => {
  test("a turn whose thinking can't be verified loses all its thinking, and a turn left empty is dropped", () => {
    const { messages, dropped } = dropUnverifiableThinking([
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }, { type: "redacted_thinking", data: "r" }, { type: "text", text: "kept" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "signed", signature: "sig" }, { type: "text", text: "whole" }] },
    ]);
    expect(dropped).toBe(3);
    expect(messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "signed", signature: "sig" }, { type: "text", text: "whole" }] },
    ]);
  });

  test("redacted thinking and failed tool results reach the wire as they are", () => {
    const params = buildAnthropicParams(req({ provider_key: "anthropic", messages: [
      { role: "assistant", provider_key: "anthropic", model: "anthropic/claude-opus-4.8", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "tool_use", id: "t", name: "n", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }, { type: "tool_result", tool_use_id: "t", content: "fine" }] },
    ] }));
    expect(params.messages).toEqual([
      { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "tool_use", id: "t", name: "n", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }, { type: "tool_result", tool_use_id: "t", content: "fine" }] },
    ]);
  });
});

describe("a thinking budget", () => {
  test("is raised to the 1,024-token minimum, kept under max_tokens, and dropped when it can't fit", () => {
    const budget = (budget_tokens: number, maxTokens: number): unknown => buildThinkingParams({ budget_tokens, reasoning_effort: "high" }, "anthropic/claude-opus-4.8", maxTokens);
    expect(budget(500, 4096)).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(budget(1024, 1100)).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(budget(5000, 3000)).toEqual({ thinking: { type: "enabled", budget_tokens: 2999 } });
    expect(budget(2000, 1025)).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(budget(2000, 1024)).toEqual({});
  });
});

describe("streamed content", () => {
  const stream = (events: unknown[]) => anthropicContentEvents((async function* () { for (const e of events) yield e as RawMessageStreamEvent; })(), newTurnAccumulator());

  test("redacted thinking is passed on, and a thinking block that never got a signature sends none", async () => {
    expect(await collect(stream([
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hm" } },
      { type: "content_block_stop", index: 1 },
    ]))).toEqual([{ type: "redacted_thinking", data: "opaque" }, { type: "thinking", text: "hm" }]);
  });

  test("a delta that doesn't match its block, or has no block, changes nothing", async () => {
    expect(await collect(stream([
      { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "stray" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "not thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "n" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "nope" } },
      { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "nope" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "nope" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "yes" } },
      { type: "content_block_stop", index: 2 },
    ]))).toEqual([
      { type: "thinking_signature", signature: "sig" },
      { type: "tool_use", id: "t", name: "n", input: { a: 1 } },
      { type: "text", text: "yes" },
    ]);
  });
});
