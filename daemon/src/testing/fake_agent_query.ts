import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentQuery } from "../llm/providers/claude_agent.ts";

export type FakeBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "redacted_thinking"; data: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown };

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface FakeRound {
  blocks: FakeBlock[];
  stopReason?: string | null;
  startUsage?: FakeUsage;
  deltaUsage?: FakeUsage;
  nested?: boolean;
}

export interface FakeScript {
  sessionId?: string;
  rounds: FakeRound[];
  subtype?: string;
  resultStopReason?: string | null;
  resultUsage?: FakeUsage;
  compactMidTurn?: boolean;
  throwOn?: Error;
}

export interface FakeCall {
  prompt: string;
  options: Options;
}

export interface FakeAgent {
  query: AgentQuery;
  calls: FakeCall[];
}

function messageStart(id: string, usage: FakeUsage): unknown {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    },
  };
}

function blockStart(index: number, block: FakeBlock): unknown {
  switch (block.kind) {
    case "text":
      return { type: "content_block_start", index, content_block: { type: "text", text: "" } };
    case "thinking":
      return {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      };
    case "redacted_thinking":
      return {
        type: "content_block_start",
        index,
        content_block: { type: "redacted_thinking", data: block.data },
      };
    case "tool_use":
      return {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      };
  }
}

function blockDeltas(index: number, block: FakeBlock): unknown[] {
  switch (block.kind) {
    case "text":
      return [
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      ];
    case "thinking": {
      const out: unknown[] = [
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.text },
        },
      ];
      if (block.signature !== undefined) {
        out.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        });
      }
      return out;
    }
    case "redacted_thinking":
      return [];
    case "tool_use":
      return [
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      ];
  }
}

function finishedBlock(block: FakeBlock): unknown {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.text, signature: block.signature ?? "" };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
}

function usageBlock(usage: FakeUsage): unknown {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function* roundFrames(
  round: FakeRound,
  index: number,
  sessionId: string,
): Generator<Record<string, unknown>> {
  const messageId = `msg_${String(index)}`;
  const parent = round.nested === true ? `toolu_nested_${String(index)}` : null;
  const wrap = (event: unknown, uuid: string): Record<string, unknown> => ({
    type: "stream_event",
    event,
    parent_tool_use_id: parent,
    uuid,
    session_id: sessionId,
  });

  yield wrap(messageStart(messageId, round.startUsage ?? {}), `${messageId}_start`);

  for (const [at, block] of round.blocks.entries()) {
    yield wrap(blockStart(at, block), `${messageId}_bs_${String(at)}`);
    for (const [n, delta] of blockDeltas(at, block).entries()) {
      yield wrap(delta, `${messageId}_bd_${String(at)}_${String(n)}`);
    }
    yield wrap({ type: "content_block_stop", index: at }, `${messageId}_be_${String(at)}`);

    yield {
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [finishedBlock(block)],
        stop_reason: null,
        stop_sequence: null,
        usage: usageBlock(round.startUsage ?? {}),
      },
      parent_tool_use_id: parent,
      uuid: `${messageId}_asst_${String(at)}`,
      session_id: sessionId,
    };
  }

  yield wrap(
    {
      type: "message_delta",
      delta: { stop_reason: round.stopReason === undefined ? "end_turn" : round.stopReason, stop_sequence: null },
      usage: usageBlock(round.deltaUsage ?? {}),
    },
    `${messageId}_md`,
  );
  yield wrap({ type: "message_stop" }, `${messageId}_ms`);
}

export function fakeAgent(script: FakeScript): FakeAgent {
  const calls: FakeCall[] = [];
  const sessionId = script.sessionId ?? "session-fake";

  const run = async function* (): AsyncIterable<SDKMessage> {
    for (const [index, round] of script.rounds.entries()) {
      for (const frame of roundFrames(round, index, sessionId)) {
        yield frame as unknown as SDKMessage;
        await Promise.resolve();
      }
    }

    if (script.compactMidTurn === true) {
      yield {
        type: "system",
        subtype: "compact_boundary",
        session_id: sessionId,
        uuid: "compact-1",
      } as unknown as SDKMessage;
    }

    if (script.throwOn !== undefined) throw script.throwOn;

    yield {
      type: "result",
      subtype: script.subtype ?? "success",
      is_error: (script.subtype ?? "success") !== "success",
      num_turns: script.rounds.length,
      result: "",
      stop_reason: script.resultStopReason === undefined ? null : script.resultStopReason,
      usage: usageBlock(script.resultUsage ?? {}),
      modelUsage: {},
      total_cost_usd: 0,
      permission_denials: [],
      duration_ms: 1,
      duration_api_ms: 1,
      uuid: "result-1",
      session_id: sessionId,
    } as unknown as SDKMessage;
  };

  return {
    calls,
    query: (params) => {
      calls.push({ prompt: params.prompt, options: params.options });
      return run();
    },
  };
}
