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
    { role: "user", content: "hi" },
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

  test("message breakpoints on [last_stable_assistant, last_msg], last block of each", () => {
    const p = buildAnthropicParams(req({ system, messages, provider_options: { cache_ttl: "1h" } }));
    const m = p.messages as Array<{ content: unknown }>;
    // idx 0,1,2 unmarked; 3 (last stable assistant) + 4 (last msg) marked on last block.
    expect(blockCC(m[0]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[1]?.content).some(Boolean)).toBe(false);
    expect(blockCC(m[2]?.content).some(Boolean)).toBe(false);
    // msg 3: cc on the LAST block (the tool_use), not the text.
    expect(blockCC(m[3]?.content)).toEqual([false, true]);
    // msg 4: cc on the tool_result.
    expect(blockCC(m[4]?.content)).toEqual([true]);
  });

  test("no cache_ttl → no markers anywhere", () => {
    const p = buildAnthropicParams(req({ system, messages }));
    const sys = p.system as unknown as Rec[];
    for (const b of sys) expect(b["cache_control"]).toBeUndefined();
    for (const m of p.messages as Array<{ content: unknown }>) {
      expect(blockCC(m.content).some(Boolean)).toBe(false);
    }
  });

  test("empty trailing text block is skipped as anchor; breakpoint walks back", () => {
    // An assistant turn that streamed a tool_use after an empty text block, or
    // a message whose only trailing block is empty text. Anchoring cc on the
    // empty text block makes Anthropic reject the whole request with
    // "cache_control cannot be set for empty text blocks".
    const withEmptyTail: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
          { type: "text", text: "" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: withEmptyTail, provider_options: { cache_ttl: "1h" } }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    // last stable assistant (idx 1): cc lands on the tool_use, NOT the empty text.
    expect(blockCC(m[1]?.content)).toEqual([false, true, false]);
    // last msg (idx 2): tool_result anchored as usual.
    expect(blockCC(m[2]?.content)).toEqual([true]);
  });

  test("message with only an empty text block gets no breakpoint", () => {
    const onlyEmpty: SidecarRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
    ];
    const p = buildAnthropicParams(
      req({ system, messages: onlyEmpty, provider_options: { cache_ttl: "1h" } }),
    );
    const m = p.messages as Array<{ content: unknown }>;
    // No eligible anchor → no cache_control on that message (request stays valid).
    expect(blockCC(m[1]?.content).some(Boolean)).toBe(false);
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
          { role: "user", content: "hey" },
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
