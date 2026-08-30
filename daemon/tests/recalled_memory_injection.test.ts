import { describe, expect, test } from "bun:test";

import { DEFAULT_MEMORY_RECALL_PREAMBLE } from "../src/config/app.ts";
import { withRecalledMemory } from "../src/handler/generation.ts";
import { buildAnthropicPlan } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

function turn(role: WireMessage["role"], body: string): WireMessage {
  return { role, content: [{ type: "text", text: body }] };
}

const HISTORY: WireMessage[] = [
  turn("user", "morning"),
  turn("assistant", "morning to you"),
  turn("user", "did you sleep"),
  turn("assistant", "in a manner of speaking"),
];

function plan(messages: WireMessage[]) {
  const request = {
    sdk: "anthropic",
    model: "claude-opus-4-6",
    api_key: "k",
    max_tokens: 1024,
    messages,
    system: [{ text: "stable system prompt", label: "system" }],
    replay_prior_thinking: "none",
    provider_options: { cache_ttl: "1h" },
  } as unknown as SidecarRequest;
  return buildAnthropicPlan(request);
}

describe("recalled memory injection", () => {
  test("appends nothing when recall came back empty", () => {
    expect(withRecalledMemory(HISTORY, undefined, DEFAULT_MEMORY_RECALL_PREAMBLE)).toEqual(HISTORY);
    expect(withRecalledMemory(HISTORY, "   ", DEFAULT_MEMORY_RECALL_PREAMBLE)).toEqual(HISTORY);
  });

  test("appends one system turn after the last message, changing no earlier turn", () => {
    const withBlock = withRecalledMemory(
      HISTORY,
      "- he told her about the bicycle",
      DEFAULT_MEMORY_RECALL_PREAMBLE,
    );
    expect(withBlock).toHaveLength(HISTORY.length + 1);
    expect(withBlock.slice(0, HISTORY.length)).toEqual(HISTORY);
    expect(withBlock.at(-1)?.role).toBe("system");
    const body = withBlock.at(-1)?.content[0];
    expect(body?.type === "text" ? body.text : "").toContain("- he told her about the bicycle");
  });

  test("uses a configured preamble verbatim", () => {
    const withBlock = withRecalledMemory(HISTORY, "- a recalled line", "Private notes:");
    const body = withBlock.at(-1)?.content[0];
    expect(body?.type === "text" ? body.text : "").toBe(
      "<recalled_memories>\nPrivate notes:\n\n- a recalled line\n</recalled_memories>",
    );
  });

  test("an empty preamble leaves only the tagged fact list", () => {
    const withBlock = withRecalledMemory(HISTORY, "- a recalled line", "");
    const body = withBlock.at(-1)?.content[0];
    expect(body?.type === "text" ? body.text : "").toBe(
      "<recalled_memories>\n- a recalled line\n</recalled_memories>",
    );
  });

  test("the system prompt the block does not touch stays byte-identical", () => {
    const plain = plan([...HISTORY]);
    const injected = plan(withRecalledMemory(HISTORY, "- a recalled line", DEFAULT_MEMORY_RECALL_PREAMBLE));
    expect(JSON.stringify(injected.params.system)).toBe(JSON.stringify(plain.params.system));
  });

  test("every turn before the last stays byte-identical on the wire", () => {
    const plain = plan([...HISTORY]);
    const injected = plan(withRecalledMemory(HISTORY, "- a recalled line", DEFAULT_MEMORY_RECALL_PREAMBLE));
    const shared = plain.params.messages.length - 1;
    expect(JSON.stringify(injected.params.messages.slice(0, shared)))
      .toBe(JSON.stringify(plain.params.messages.slice(0, shared)));
  });

  test("the frozen breakpoint still lands inside unchanged history", () => {
    const injected = plan(withRecalledMemory(HISTORY, "- a recalled line", DEFAULT_MEMORY_RECALL_PREAMBLE));
    const frozen = injected.placement.msg_breakpoints.filter(
      (index) => index < HISTORY.length - 1,
    );
    expect(frozen.length).toBeGreaterThan(0);
  });
});
