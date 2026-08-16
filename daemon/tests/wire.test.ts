import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../src/engine/types.ts";
import { replayableMessages } from "../src/llm/replay.ts";
import { buildAnthropicParams, dropUnverifiableThinking } from "../src/llm/providers/anthropic.ts";
import {
  systemToText,
  toolResultText,
  type CallContext,
  type ProviderOptions,
  type SidecarRequest,
  type StreamEvent,
  type SystemBlock,
  type ToolDefinition,
  type WireMessage,
} from "../src/llm/types.ts";

type CallComplete = Extract<StreamEvent, { type: "call_complete" }>;

interface WireFixture {
  tool_rpc: unknown;
  wire_role: Array<WireMessage["role"]>;
  thinking_replay: Array<SidecarRequest["replay_prior_thinking"]>;
  system_block: SystemBlock;
  tool_definition: ToolDefinition;
  call_complete: CallComplete;
  provider_options: { empty: ProviderOptions; full: ProviderOptions };
  call_context: { minimal: CallContext; full: CallContext };
  reasoning_carrier: Record<string, Record<string, unknown>>;
  wire_block: Record<string, ContentBlock>;
  wire_message: { bare: WireMessage; with_provenance: WireMessage };
}

const fixturePath = new URL(
  "./rust_fixtures/wire.json",
  import.meta.url,
);
const wire = (await Bun.file(fixturePath).json()) as WireFixture;

function pick<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`fixture is missing "${key}"`);
  return value;
}

function imageSource(block: ContentBlock): Extract<ContentBlock, { type: "image" }>["source"] {
  if (block.type !== "image") throw new Error(`expected an image block, got "${block.type}"`);
  return block.source;
}

function toolResultContent(block: ContentBlock): string | ContentBlock[] {
  if (block.type !== "tool_result") {
    throw new Error(`expected a tool_result block, got "${block.type}"`);
  }
  return block.content;
}

const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

function assertKeys<T>(value: unknown, declared: Array<keyof T & string>, what: string) {
  expect(keysOf(value), what).toEqual([...declared].sort());
}

describe("the fixture is real", () => {
  test("a silently unreadable fixture must not pass", () => {
    expect(Object.keys(wire).length).toBeGreaterThan(5);
    expect(Object.keys(wire.wire_block)).toHaveLength(11);
  });
});

describe("scalar mirrors carry exactly the declared fields", () => {
  test("SystemBlock", () => {
    assertKeys<SystemBlock>(wire.system_block, ["text", "label"], "SystemBlock");
    expect(systemToText([wire.system_block])).toBe("You are a character.");
  });

  test("ToolDefinition", () => {
    assertKeys<ToolDefinition>(
      wire.tool_definition,
      ["name", "description", "input_schema"],
      "ToolDefinition",
    );
  });

  test("CallContext", () => {
    assertKeys<CallContext>(
      wire.call_context.minimal,
      ["character", "call_type", "thinking_enabled"],
      "CallContext (minimal)",
    );
    assertKeys<CallContext>(
      wire.call_context.full,
      [
        "ledger",
        "character",
        "call_type",
        "api_key_name",
        "thinking_enabled",
        "cache_ttl",
        "reasoning_effort",
        "keepalive_max_secs",
        "forensics_dir",
        "rid",
        "usage",
      ],
      "CallContext (full)",
    );
    const budget = wire.call_context.full.usage?.budgets?.[0];
    expect(budget, "the census carries a budget").toBeDefined();
    expect(budget!.period).toBe("week");
    expect(budget!.limit).toBe("block");
    expect(budget!.reset_day_of_week).toBe("wednesday");
    expect(budget!.pace_action).toBe("pause_background");
    expect(budget!.usage_kind).toEqual(["message_with_tools"]);
  });

  test("call_complete", () => {
    assertKeys<CallComplete>(
      wire.call_complete,
      ["type", "usage", "timing", "finish_reason", "continuation"],
      "call_complete",
    );
    expect(wire.call_complete.type).toBe("call_complete");
    assertKeys<CallComplete["usage"]>(
      wire.call_complete.usage,
      ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"],
      "call_complete.usage",
    );
    assertKeys<CallComplete["timing"]>(
      wire.call_complete.timing,
      ["total_ms", "time_to_first_token_ms"],
      "call_complete.timing",
    );
  });

  test("ProviderOptions declares a reader for every knob the daemon sends", () => {
    assertKeys<ProviderOptions>(
      wire.provider_options.full,
      [
        "reasoning_effort",
        "thinking_enabled",
        "budget_tokens",
        "cache_ttl",
        "openrouter_provider",
        "gemini_generation",
        "zai_clear_thinking",
        "zai_subscription",
      ],
      "ProviderOptions",
    );
  });

  test("an unset knob is omitted, never sent as null", () => {
    expect(wire.provider_options.empty).toEqual({});
  });
});

describe("WireMessage", () => {
  test("declares exactly the fields the daemon sends", () => {
    assertKeys<WireMessage>(
      wire.wire_message.with_provenance,
      ["role", "content", "provider_key", "model"],
      "WireMessage",
    );
  });

  test("provenance is optional and absent for daemon-authored turns", () => {
    assertKeys<WireMessage>(wire.wire_message.bare, ["role", "content"], "WireMessage (bare)");
  });

  test("content is always an array — never the bare string it used to be", () => {
    expect(Array.isArray(wire.wire_message.bare.content)).toBe(true);
  });

  test("every role the daemon can send is one this side accepts", () => {
    const roles: Array<WireMessage["role"]> = ["user", "assistant", "system"];
    expect(wire.wire_role).toEqual(roles);
  });

  test("every replay mode the daemon can send is one this side accepts", () => {
    const modes: Array<SidecarRequest["replay_prior_thinking"]> = ["all", "none"];
    expect(wire.thinking_replay).toEqual(modes);
  });
});

describe("ContentBlock variants", () => {
  const block = (name: string) => pick(wire.wire_block, name);

  test("the tag of every variant is one this side discriminates on", () => {
    const known: Array<ContentBlock["type"]> = [
      "text",
      "image",
      "thinking",
      "redacted_thinking",
      "tool_use",
      "tool_result",
    ];
    const sent = new Set(Object.values(wire.wire_block).map((b) => b.type));
    for (const tag of sent) {
      expect(known, `unknown block tag "${tag}"`).toContain(tag);
    }
  });

  test("text / redacted_thinking / tool_use", () => {
    assertKeys<Extract<ContentBlock, { type: "text" }>>(block("text"), ["type", "text"], "text");
    assertKeys<Extract<ContentBlock, { type: "redacted_thinking" }>>(
      block("redacted_thinking"),
      ["type", "data"],
      "redacted_thinking",
    );
    assertKeys<Extract<ContentBlock, { type: "tool_use" }>>(
      block("tool_use"),
      ["type", "id", "name", "input"],
      "tool_use",
    );
  });

  test("image blocks are synthesized by the daemon and must be accepted here", () => {
    assertKeys<Extract<ContentBlock, { type: "image" }>>(block("image"), ["type", "source"], "image");
    assertKeys<Extract<ContentBlock, { type: "image" }>["source"]>(
      imageSource(block("image")),
      ["type", "media_type", "data"],
      "image.source",
    );
  });

  test("each reasoning carrier rides flattened onto the thinking block", () => {
    type Thinking = Extract<ContentBlock, { type: "thinking" }>;
    assertKeys<Thinking>(block("thinking_uncarried"), ["type", "thinking"], "thinking (uncarried)");
    assertKeys<Thinking>(
      block("thinking_signature"),
      ["type", "thinking", "signature"],
      "thinking (anthropic/gemini)",
    );
    assertKeys<Thinking>(
      block("thinking_openrouter"),
      ["type", "thinking", "reasoning_details"],
      "thinking (openrouter)",
    );
    assertKeys<Thinking>(
      block("thinking_zai"),
      ["type", "thinking", "reasoning_content"],
      "thinking (zai)",
    );
  });

  test("tool_result content is text or blocks, and is_error is omitted when false", () => {
    type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
    assertKeys<ToolResult>(
      block("tool_result_text"),
      ["type", "tool_use_id", "content"],
      "tool_result (text)",
    );
    assertKeys<ToolResult>(
      block("tool_result_blocks"),
      ["type", "tool_use_id", "content"],
      "tool_result (blocks)",
    );
    assertKeys<ToolResult>(
      block("tool_result_error"),
      ["type", "tool_use_id", "content", "is_error"],
      "tool_result (error)",
    );

    const blocks = toolResultContent(block("tool_result_blocks"));
    expect(Array.isArray(blocks)).toBe(true);
    expect(toolResultText(blocks)).toBe("a cat");
  });
});

describe("the census survives the real code paths", () => {
  const everyBlock = Object.values(wire.wire_block) as ContentBlock[];
  const uncarried = (b: ContentBlock): boolean =>
    b.type === "thinking" && b.signature === undefined && b.reasoning_details === undefined &&
    b.reasoning_content === undefined;
  const carriedBlocks = everyBlock.filter((b) => !uncarried(b));
  const uncarriedBlocks = everyBlock.filter(uncarried);

  const req: SidecarRequest = {
    sdk: "anthropic",
    model: "claude-opus-4-8",
    provider_key: "anthropic",
    api_key: "k",
    system: [wire.system_block],
    tools: [wire.tool_definition],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        provider_key: "anthropic",
        model: "claude-opus-4-8",
        content: carriedBlocks,
      },
      { role: "user", content: [{ type: "text", text: "and again" }] },
      {
        role: "assistant",
        provider_key: "anthropic",
        model: "claude-opus-4-8",
        content: [...uncarriedBlocks, { type: "text", text: "answer" }],
      },
    ],
    max_tokens: 64,
    replay_prior_thinking: "all",
    provider_options: wire.provider_options.full,
  };

  test("replay keeps the blocks minted by the active model", () => {
    const out = replayableMessages(req);
    const kept = out[1]?.content.map((b) => b.type) ?? [];
    expect(kept).toContain("thinking");
    expect(kept).toContain("redacted_thinking");
    expect(kept).toContain("tool_result");
    expect(kept).toContain("image");
  });

  test("shared replay hands every block on, unreplayable ones included", () => {
    const out = replayableMessages(req);
    const kept = out[3]?.content.map((b) => b.type) ?? [];
    expect(kept).toContain("thinking");
  });

  test("the anthropic adapter is what loses a message that carries nothing replayable", () => {
    const { messages } = dropUnverifiableThinking(
      replayableMessages(req),
      "anthropic",
      "claude-opus-4-8",
    );
    const kept = messages[3]?.content.map((b) => b.type) ?? [];
    expect(kept).toEqual(["text"]);
  });

  test("the anthropic adapter accepts every variant without throwing", () => {
    const params = buildAnthropicParams(req);
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.tools).toHaveLength(1);
  });
});
