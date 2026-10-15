import { describe, expect, test } from "bun:test";

import { genericToolLoopEvents } from "../src/llm/providers/generic_loop.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock, Role } from "../src/engine/types.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  GenerateResponse,
} from "../src/llm/types.ts";
import { collect } from "./support/stream.ts";

type Turn =
  | { kind: "tools"; calls: Array<{ id: string; name: string; input: unknown }> }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

const USAGE = { input_tokens: 10, output_tokens: 7, cache_read_tokens: 4, cache_creation_tokens: 0 };

class FakeProvider implements SidecarProvider {
  requests: SidecarRequest[] = [];
  private next = 0;

  constructor(private readonly turns: Turn[]) {}

  async *stream(req: SidecarRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns[this.next++] ?? { kind: "text" as const, text: "(exhausted)" };
    yield { type: "start", model: req.model };
    if (turn.kind === "error") {
      yield { type: "error", message: turn.message, usage: USAGE, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      return;
    }
    if (turn.kind === "text") yield { type: "text", text: turn.text };
    else for (const call of turn.calls) yield { type: "tool_use", id: call.id, name: call.name, input: call.input };
    yield {
      type: "done",
      content: turn.kind === "text" ? turn.text : "",
      finish_reason: turn.kind === "tools" ? "tool_use" : "end_turn",
      usage: USAGE,
      timing: { total_ms: 5, time_to_first_token_ms: 2 },
    };
  }

  generate(): Promise<GenerateResponse> {
    throw new Error("the loop never calls generate");
  }
}

function fakePhase(output: () => string) {
  const runs: ToolUseEvent[] = [];
  let minted = 0;
  const phase: ToolPhase = {
    messages: [],
    recordTurn: (role: Role, blocks: ContentBlock[]) => {
      minted += 1;
      phase.messages.push({ msg_id: `m_${String(minted)}`, role, content: "", images: [], content_blocks: blocks, timestamp: "2026-01-01T00:00:00-05:00" });
    },
    runTool: async (use: ToolUseEvent): Promise<ContentBlock> => {
      runs.push(use);
      return { type: "tool_result", tool_use_id: use.id, content: output(), is_error: false };
    },
  };
  return { phase, runs };
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "deepseek",
    model: "deepseek-chat",
    provider_key: "deepseek",
    api_key: "k",
    messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    system: [{ text: "you are a character", label: "character" }],
    tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    ...overrides,
  };
}

test.each([false, true])("cancellation prevents a fresh provider call even when the provider ignores abort (before start: %s)", async (beforeStart) => {
  const controller = new AbortController();
  const provider = new FakeProvider([
    { kind: "tools", calls: [{ id: "cancelled-tool", name: "read", input: {} }] },
    { kind: "text", text: "must not start this call" },
  ]);
  const tools = fakePhase(() => { controller.abort(); return "effect already happened"; });
  if (beforeStart) controller.abort();
  const events = await collect(genericToolLoopEvents(provider, request(), tools.phase, controller.signal));
  expect(provider.requests).toHaveLength(beforeStart ? 0 : 1);
  expect(tools.runs).toHaveLength(beforeStart ? 0 : 1);
  expect(events.at(-1)).toMatchObject({ type: "error", aborted: true });
});

describe("driving a tool loop for a non-Anthropic dialect", () => {
  test("each model call gets a fresh retry budget without replaying a completed tool", async () => {
    const provider = new FakeProvider([
      { kind: "error", message: "initial 429" },
      { kind: "error", message: "initial 429 again" },
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "error", message: "continuation 429" },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase(() => "hello");

    const events = await collect(
      genericToolLoopEvents(provider, request(), tools.phase, undefined, Date.now, {
        settings: { maxRetries: 2, backoffBaseMs: 1 },
        sleep: async () => {},
        random: () => 0,
      }),
    );

    expect(provider.requests).toHaveLength(5);
    expect(tools.runs).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", content: "done" });
  });
});
