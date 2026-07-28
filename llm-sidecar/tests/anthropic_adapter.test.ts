/**
 * Anthropic adapter parity tests. Pin `buildAnthropicParams` (request shaping)
 * and `anthropicStreamEvents` (event mapping). The cache-placement +
 * per-model thinking assertions are the cache/correctness proof for the
 * sidecar-owned Anthropic wire.
 */

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

// ── cache_control placement (default schedule) ──────────────────────────────

describe("cache placement (mirrors ts_default_placement)", () => {
  const system = [
    { type: "text" as const, text: "base", _label: "system_base" },
    { type: "text" as const, text: "mem", _label: "memory_index" },
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

  test("system anchor lands on last non-memory_index block; _label stripped", () => {
    const p = buildAnthropicParams(req({ system, messages, provider_options: { cache_ttl: "1h" } }));
    const sys = p.system as unknown as Rec[];
    expect(sys[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(sys[1]?.["cache_control"]).toBeUndefined(); // memory_index NOT anchored
    // _label never reaches the wire
    for (const b of sys) expect(b).not.toHaveProperty("_label");
  });

  test("message breakpoints on [prev_frozen, frozen_boundary, last_msg], last block of each", () => {
    const p = buildAnthropicParams(req({ system, messages, provider_options: { cache_ttl: "1h" } }));
    const m = p.messages as Array<{ content: unknown }>;
    // The trailing assistant turn is idx 3–4 (assistant + its tool_result), so
    // the frozen boundary is idx 2, and the boundary one turn back is idx 0.
    // Anchors: 0, 2, and 4 (last msg). The trailing turn itself is deliberately
    // NOT anchored — its bytes change when `replay_prior_thinking` strips it on
    // the next request.
    expect(blockCC(m[0]?.content)).toEqual([true]);
    expect(blockCC(m[1]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[2]?.content)).toEqual([true]);
    expect(blockCC(m[3]?.content).some(Boolean)).toBe(false);
    // msg 4: cc on the tool_result.
    expect(blockCC(m[4]?.content)).toEqual([true]);
  });

  test("never exceeds the four-breakpoint provider limit", () => {
    // 3 message anchors + 1 system anchor is exactly the cap; a fifth marker
    // fails the whole request.
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
    // Anchoring cc on an empty text block makes Anthropic reject the whole
    // request with "cache_control cannot be set for empty text blocks". The
    // block is now removed before placement runs (see `llm/replay.ts`), so the
    // anchor lands on the tool_result and the empty block is simply not there.
    // `applyMessageBreakpoint` still skips empty text as a backstop.
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
    // frozen boundary (idx 0): anchored on its only block.
    expect(blockCC(m[0]?.content)).toEqual([true]);
    // last msg (idx 2): the empty text block is gone; cc rides the tool_result.
    expect(blockCC(m[2]?.content)).toEqual([true]);
  });

  test("a turn with no anchorable block walks back to the previous one", () => {
    // An assistant turn of only thinking blocks is the remaining un-anchorable
    // case — `thinking` rejects `cache_control` and, unlike empty text, the
    // block is legitimate and must ship. The breakpoint has to walk back rather
    // than be dropped: a dropped breakpoint is a silent cache-cost regression.
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
    // Shipping it with an empty content array fails the request outright, and
    // shipping the empty block fails it the moment a breakpoint lands there.
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
    // The daemon persists a caption-less image message with NO text block
    // (`handler/task.rs`), precisely so an empty text block can't anchor a
    // breakpoint. `messages[frozenIdx]` is always a genuine user message, so
    // an image-only one lands exactly there — and before `image` became an
    // eligible anchor the frozen breakpoint vanished, shipping a request with
    // a single anchor on the last message: the shape this schedule exists to
    // fix. The old `last_stable_assistant` anchor never hit this, since an
    // assistant message effectively always has text or a tool_use.
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
    // Trailing turn starts at 3 → frozen boundary is the image-only msg 2.
    expect(blockCC(m[2]?.content)).toEqual([true]);
    // cc rides the image block itself (Anthropic accepts cache_control there).
    expect((m[2]?.content as Rec[])[0]?.["cache_control"]).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(blockCC(m[4]?.content)).toEqual([true]);
  });

  test("pre-existing markers → placement skipped (has_existing_markers gate)", () => {
    const marked: SidecarRequest["messages"] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } } as never],
      },
    ];
    const p = buildAnthropicParams(req({ system, messages: marked, provider_options: { cache_ttl: "1h" } }));
    // system passes through un-anchored because we didn't run placement.
    const sys = p.system as unknown as Rec[];
    expect(sys.every((b) => b["cache_control"] === undefined)).toBe(true);
  });
});

// ── frozen-region anchor vs. replay_prior_thinking strips ───────────────────

/**
 * Reproduces the production regression observed on 2026-07-23 (calls #7207 →
 * #7208). Under `replay_prior_thinking = "last_turn"` the daemon strips
 * thinking from the assistant turn that just stopped being the trailing one.
 * The old `last_stable_assistant` anchor sat *inside* that turn, so its cached
 * prefix was rewritten on the very next request: both message anchors missed
 * and the read collapsed to the system prefix alone (7,602 tokens), re-caching
 * the whole ~18k conversation on every committed turn.
 *
 * The strip boundary only ever moves forward, so everything before the trailing
 * turn is frozen for the life of the conversation. Anchoring there survives.
 */
describe("frozen-region anchor survives a last_turn thinking strip", () => {
  const system = [{ type: "text" as const, text: "base", _label: "system_base" }];

  // Request N — the trailing assistant turn (idx 3–5) still carries thinking.
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

  // Request N+1 — the turn committed, a new turn landed, and `last_turn`
  // stripped the thinking block from idx 3 now that it is no longer trailing.
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

  /** The frozen-boundary anchor: anchors are sorted ascending and the schedule
   * is `[prev_frozen?, frozen, last_msg]`, so it is the second from the end. */
  function frozenAnchor(msgs: SidecarRequest["messages"]): number {
    const a = anchoredMsgIndices(msgs);
    expect(a.length).toBeGreaterThanOrEqual(2);
    return a[a.length - 2]!;
  }

  /** Prefix bytes a breakpoint at `idx` covers, as the provider hashes them. */
  function prefix(msgs: SidecarRequest["messages"], idx: number): string {
    return JSON.stringify(msgs.slice(0, idx + 1));
  }

  test("anchors land on the two frozen boundaries and the last message", () => {
    // N: trailing turn starts at 3 → frozen boundary 2, prior boundary 0; last msg 6.
    expect(anchoredMsgIndices(stateN)).toEqual([0, 2, 6]);
    // N+1: trailing turn starts at 7 → frozen boundary 6, prior boundary 2; last msg 8.
    expect(anchoredMsgIndices(stateN1)).toEqual([2, 6, 8]);
  });

  test("request N+1's prev_frozen anchor is an exact hit on request N's frozen anchor", () => {
    // Under the normal turn cadence the boundary advances one turn per request,
    // so the older of N+1's two frozen anchors sits exactly where N anchored —
    // an exact breakpoint hit, with no reliance on the ~20-block lookback.
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
    // Old placement anchored idx 5 (last assistant before the final message).
    // Its prefix spans idx 3, whose thinking block is stripped in N+1 — which
    // is exactly why the live read collapsed to the system anchor. The current
    // schedule must not place anything at or past the strip boundary (3).
    const oldAnchor = 5;
    expect(prefix(stateN1, oldAnchor)).not.toEqual(prefix(stateN, oldAnchor));
    const stripBoundary = 3; // trailing turn of state N — rewritten in N+1
    for (const a of anchoredMsgIndices(stateN)) {
      if (a >= stateN.length - 1) continue; // the last_msg anchor is a fresh write
      expect(a).toBeLessThan(stripBoundary);
    }
  });

  test("under `all` (nothing stripped) every request-N anchor still reads in N+1", () => {
    // With no strip, appending a turn leaves every prior byte intact, so all of
    // request N's anchors — last_msg included — remain valid prefixes of
    // request N+1. The frozen anchors cost no coverage in this mode.
    const appended: SidecarRequest["messages"] = [
      ...stateN,
      { role: "assistant", content: [{ type: "text", text: "a7" }] },
      { role: "user", content: [{ type: "text", text: "q4" }] },
    ];
    const anchorsN = anchoredMsgIndices(stateN);
    expect(anchorsN[anchorsN.length - 1]).toBe(stateN.length - 1); // last_msg
    for (const a of anchorsN) {
      expect(prefix(appended, a)).toEqual(prefix(stateN, a));
    }
  });

  test("tool-loop rounds still extend: iter-1 frozen boundary == iter-0 last_msg", () => {
    // A compaction/tool loop appends `assistant + user(tool_result)` per round.
    // The appended assistant begins the next trailing turn, so the frozen
    // boundary lands exactly on the previous round's last_msg — the position
    // that round already cached. Caching extends round over round rather than
    // restarting, which is the property `live_compaction_cache.rs` guards.
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
    expect(a0[a0.length - 1]).toBe(2); // iter-0 anchored its last_msg at idx 2
    expect(frozenAnchor(iter1)).toBe(2); // iter-1's frozen boundary is that same position
  });

  test("the turn after a multi-round tool loop keeps a surviving read", () => {
    // The round-to-round guarantee above does NOT cover loop → next turn. While
    // the loop runs the boundary is pinned at the loop start and the loop's
    // thinking is kept; once the loop ends and a new assistant turn lands, the
    // boundary jumps past the whole loop in one step and every round's thinking
    // is stripped at once. The new frozen anchor sits after that rewritten
    // region and misses — the prev_frozen anchor is what keeps a read alive.
    // For a short loop the ~20-block automatic lookback would probably rescue
    // it; compaction and dreaming loops run well past that.
    const preLoop: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "compact now" }] },
    ];
    // 3 rounds, each `assistant(thinking + tool_use) + user(tool_result)`.
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
    // Next turn: the loop's thinking is now history and gets stripped, and a
    // fresh user + assistant turn lands on top.
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

    // The new frozen anchor genuinely misses: its prefix spans the rewritten
    // loop. That part is unavoidable — those bytes really did change.
    const frozenNext = frozenAnchor(nextTurn);
    expect(prefix(nextTurn, frozenNext)).not.toEqual(prefix(loopEnd, frozenNext));

    // But the read does not collapse to the system prefix: the still-stable
    // prefix before the loop is a placed breakpoint in both requests, and its
    // bytes are identical.
    const anchorsLoop = anchoredMsgIndices(loopEnd);
    const anchorsNext = anchoredMsgIndices(nextTurn);
    const survivor = anchorsNext.find(
      (a) => anchorsLoop.includes(a) && prefix(nextTurn, a) === prefix(loopEnd, a),
    );
    expect(survivor).toBe(2); // the genuine user turn that opened the loop
  });
});

// ── image content blocks ────────────────────────────────────────────────────

describe("image blocks", () => {
  // The daemon synthesizes base64 image blocks from a message's `images` and
  // inlines them into the wire `content` array. The adapter must accept them;
  // before the fix, the unknown block type fell through toContentBlockParam to
  // `undefined`, and normalizeMessages threw "undefined is not an object
  // (evaluating 'delete Q.cache_control')", surfacing as an HTTP 502.
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
    // breakpoint still lands on the trailing text block, not the image.
    expect(blockCC(content)).toEqual([false, true]);
  });
});

// ── thinking (mirrors build_thinking_params + thinking_caps) ────────────────

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

  test("sonnet-4.5 (adaptive-incapable) + effort → enabled+budget, no output_config", () => {
    const r = buildThinkingParams({ reasoning_effort: "high" }, "anthropic/claude-sonnet-4.5", 32000);
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 12288 });
    expect(r.outputConfig).toBeUndefined();
  });

  test("haiku + effort → enabled+budget (medium=8192)", () => {
    const r = buildThinkingParams({ reasoning_effort: "medium" }, "anthropic/claude-haiku-4.5", 32000);
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  test("opus-4.6 (permissive) + effort → prefers adaptive", () => {
    const r = buildThinkingParams({ reasoning_effort: "high" }, "anthropic/claude-opus-4.6", 8192);
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.outputConfig).toEqual({ effort: "high" });
  });

  test("no thinking opts → nothing", () => {
    expect(buildThinkingParams({}, "anthropic/claude-opus-4.8", 8192)).toEqual({});
  });

  test("adaptive-incapable + max_tokens too small → thinking disabled (no 400)", () => {
    // ceiling = max_tokens-1 < 1024 → no valid budget.
    const r = buildThinkingParams({ reasoning_effort: "high" }, "anthropic/claude-sonnet-4.5", 512);
    expect(r.thinking).toBeUndefined();
  });
});

// ── provider routing (config-driven, not base_url heuristic) ────────────────

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

// ── inline system wrap ──────────────────────────────────────────────────────

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
    // merged into the preceding user turn; no role:system survives.
    expect(m.every((x) => x.role !== "system")).toBe(true);
    expect(JSON.stringify(m)).toContain("<system_instruction>be brief</system_instruction>");
  });
});

// ── streaming event mapping ─────────────────────────────────────────────────

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
  // signature emitted at the thinking block's close — after deltas, before text.
  expect(out[2]).toEqual({ type: "thinking_signature", signature: "sig123" });
  expect(out[3]).toEqual({ type: "text", text: "answer" });
  expect(out[4]).toEqual({ type: "tool_use", id: "tu_9", name: "search", input: { q: "x" } });

  const done = out[5];
  expect(done?.type).toBe("done");
  if (done?.type === "done") {
    expect(done.content).toBe("answer");
    expect(done.finish_reason).toBe("tool_use");
    expect(done.usage.input_tokens).toBe(50);
    expect(done.usage.output_tokens).toBe(30); // updated by message_delta
  }
  expect(out.length).toBe(6);
});

test("emits error frame with the message_start cache write when the stream throws", async () => {
  // message_start reports the cache write (Anthropic bills it before any
  // output); the SDK iterator then throws. The adapter must surface that usage
  // in a terminal `error` frame so the daemon records the already-billed cache
  // write instead of dropping it to zero.
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
  // No `done` frame after the error.
  expect(out.some((e) => e.type === "done")).toBe(false);
});
