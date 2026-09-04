import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent, type FakeScript } from "../src/testing/fake_agent_query.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import {
  SESSION_BOOK_VERSION,
  type SessionBook,
} from "../src/llm/providers/agent_sessions.ts";

async function bookDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "shore-agent-book-"));
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "claude_agent",
    model: "claude-opus-5",
    api_key: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    ...overrides,
  };
}

async function collect(
  script: FakeScript,
  req: SidecarRequest = request(),
  signal?: AbortSignal,
): Promise<{ events: StreamEvent[]; agent: ReturnType<typeof fakeAgent>; path: string }> {
  const dir = await bookDir();
  const path = join(dir, "sessions.json");
  const agent = fakeAgent(script);
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(req, signal)) events.push(event);
  return { events, agent, path };
}

const kinds = (events: readonly StreamEvent[]): string[] => events.map((e) => e.type);

function done(events: readonly StreamEvent[]): Extract<StreamEvent, { type: "done" }> {
  const found = events.find((e) => e.type === "done");
  if (found === undefined) throw new Error(`no done event in ${kinds(events).join(", ")}`);
  return found;
}

describe("what the provider forwards from the SDK stream", () => {
  test("text arrives as it streams and is gathered into the finished turn", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "rest in piss, Brian." }] }],
    });
    expect(events.filter((e) => e.type === "text").map((e) => e.text)).toEqual([
      "rest in piss, Brian.",
    ]);
    expect(done(events).content).toBe("rest in piss, Brian.");
  });

  test("a thinking block carries its signature, which the old parser never saw", async () => {
    const { events } = await collect({
      rounds: [
        {
          blocks: [
            { kind: "thinking", text: "the freezer is a person now", signature: "sig-abc" },
            { kind: "text", text: "ok" },
          ],
        },
      ],
    });
    expect(kinds(events)).toContain("thinking");
    const signed = events.find((e) => e.type === "thinking_signature");
    expect(signed?.signature).toBe("sig-abc");
  });

  test("a redacted thinking block is forwarded rather than dropped", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "redacted_thinking", data: "encrypted" }] }],
    });
    const redacted = events.find((e) => e.type === "redacted_thinking");
    expect(redacted?.data).toBe("encrypted");
  });

  test("a tool call is forwarded with its arguments assembled from the json deltas", async () => {
    const { events } = await collect({
      rounds: [
        {
          blocks: [{ kind: "tool_use", id: "toolu_1", name: "read", input: { path: "SOUL.md" } }],
          stopReason: "tool_use",
        },
      ],
    });
    const call = events.find((e) => e.type === "tool_use");
    expect(call?.name).toBe("read");
    expect(call?.input).toEqual({ path: "SOUL.md" });
  });
});

describe("how a turn says it ended", () => {
  test("a truncated turn says so instead of claiming it finished", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "half a th" }], stopReason: "max_tokens" }],
      resultStopReason: "max_tokens",
    });
    expect(done(events).finish_reason).toBe("max_tokens");
  });

  test("an ordinary turn ends on the model's own stop reason", async () => {
    const { events } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    expect(done(events).finish_reason).toBe("end_turn");
  });

  test("a failed run reports the failure rather than a stop reason", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "" }] }],
      subtype: "error_max_turns",
    });
    expect(done(events).finish_reason).toBe("error_max_turns");
  });

  test("a stream that never said how it ended falls back to what the run reports", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "half a th" }], stopReason: null }],
      resultStopReason: "max_tokens",
    });
    expect(done(events).finish_reason).toBe("max_tokens");
  });

  test("what the model said wins over what the run reports afterwards", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "hi" }], stopReason: "stop_sequence" }],
      resultStopReason: "end_turn",
    });
    expect(done(events).finish_reason).toBe("stop_sequence");
  });

  test("the model's stop reason is used when the run reports none", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "hi" }], stopReason: "stop_sequence" }],
      resultStopReason: null,
    });
    expect(done(events).finish_reason).toBe("stop_sequence");
  });
});

describe("what gets billed", () => {
  test("usage is the run's own total, including both cache columns", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "hi" }] }],
      resultUsage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_read_input_tokens: 33,
        cache_creation_input_tokens: 44,
      },
    });
    expect(done(events).usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_tokens: 33,
      cache_creation_tokens: 44,
    });
  });
});

describe("frames that are not this turn", () => {
  test("an agent the SDK ran on its own contributes nothing to the reply", async () => {
    const { events } = await collect({
      rounds: [
        { blocks: [{ kind: "text", text: "nested" }], nested: true },
        { blocks: [{ kind: "text", text: "mine" }] },
      ],
    });
    expect(done(events).content).toBe("mine");
  });

  test("the SDK compacting mid-turn is an error, not something absorbed in silence", async () => {
    const { events } = await collect({
      rounds: [{ blocks: [{ kind: "text", text: "hi" }] }],
      compactMidTurn: true,
    });
    const failed = events.find((e) => e.type === "error");
    expect(failed?.message).toContain("compacted mid-turn");
  });
});

describe("the options the SDK is run with", () => {
  test("every built-in tool and skill is off, and the harness cannot compact", async () => {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    const options = agent.calls[0]?.options;
    expect(options?.tools).toEqual([]);
    expect(options?.skills).toEqual([]);
    expect(options?.settings).toEqual({ autoCompactEnabled: false });
    expect(options?.settingSources).toEqual([]);
    expect(options?.disallowedTools).toContain("Task");
    expect(options?.disallowedTools).toContain("Agent");
  });

  test("the run is given a controller so shore can stop it", async () => {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    expect(agent.calls[0]?.options.abortController).toBeInstanceOf(AbortController);
  });

  test("an aborted turn hands the SDK an already-aborted controller", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = await collect(
      { rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] },
      request(),
      controller.signal,
    );
    expect(agent.calls[0]?.options.abortController?.signal.aborted).toBe(true);
  });
});

describe("what the turn leaves behind", () => {
  test("the session is written under the current book version", async () => {
    const { path } = await collect({
      sessionId: "s-1",
      rounds: [{ blocks: [{ kind: "text", text: "hi" }] }],
    });
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    const record = Object.values(book)[0];
    expect(record?.sessionId).toBe("s-1");
    expect(record?.version).toBe(SESSION_BOOK_VERSION);
  });

  test("the last assistant frame is what a later fork would anchor on", async () => {
    const { path } = await collect({
      sessionId: "s-1",
      rounds: [
        {
          blocks: [
            { kind: "thinking", text: "hmm", signature: "sig" },
            { kind: "text", text: "hi" },
          ],
        },
      ],
    });
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    expect(Object.values(book)[0]?.pendingAssistantUuids).toEqual(["msg_0_asst_1"]);
  });
});

describe("generate", () => {
  test("the blocks it returns are the ones the stream actually produced", async () => {
    const dir = await bookDir();
    const agent = fakeAgent({
      rounds: [
        {
          blocks: [
            { kind: "thinking", text: "weighing it up", signature: "sig-1" },
            { kind: "text", text: "yes" },
          ],
        },
      ],
    });
    const provider = new ClaudeAgentProvider({
      runQuery: agent.query,
      bookPath: () => join(dir, "sessions.json"),
    });
    const result = await provider.generate(request());
    expect(result.content).toBe("yes");
    expect(result.content_blocks).toEqual([
      { type: "thinking", thinking: "weighing it up", signature: "sig-1" },
      { type: "text", text: "yes" },
    ]);
  });
});
