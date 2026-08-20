import { describe, expect, test } from "bun:test";

import {
  dispatchHeartbeatTools,
  runHeartbeatToolLoop,
  type HeartbeatLoopDeps,
  type HeartbeatToolResult,
  type TranscriptRound,
} from "../src/autonomy/heartbeat_loop.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";

function request(): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-fixture",
    api_key: "k",
    provider_key: "anthropic",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 4096,
    replay_prior_thinking: "off",
  } as never;
}

function response(blocks: ContentBlock[], finishReason = "end_turn"): GenerateResponse {
  return {
    content: blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    content_blocks: blocks,
    finish_reason: finishReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "claude-fixture",
  };
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}

interface World {
  notes: string[];
  dispatched: { name: string; input: unknown }[];
  wakes: { hours: number; reason: string }[];
  transcript: TranscriptRound[];
  deps: HeartbeatLoopDeps;
}

function world(
  rounds: GenerateResponse[],
  over: Partial<HeartbeatLoopDeps> = {},
  toolResult: (name: string, input: unknown) => HeartbeatToolResult = (name) => ({
    output: `${name} ok`,
    isError: false,
  }),
): World {
  const notes: string[] = [];
  const dispatched: { name: string; input: unknown }[] = [];
  const wakes: { hours: number; reason: string }[] = [];
  const transcript: TranscriptRound[] = [];
  let round = 0;

  return {
    notes,
    dispatched,
    wakes,
    transcript,
    deps: {
      character: "ada",
      generate: async () => rounds[round++],
      dispatch: async (name, input) => {
        dispatched.push({ name, input });
        return toolResult(name, input);
      },
      scheduleNextWake: (hours, reason) => {
        wakes.push({ hours, reason });
        return `Scheduled next moment in ${hours.toFixed(1)} hours.`;
      },
      note: (t) => notes.push(t),
      recordTranscript: (r) => transcript.push(r),
      wrapUpGrace: 3,
      maxToolIterations: 4,
      ...over,
    },
  };
}

describe("what a tick asks to say", () => {
  test("takes the last <sendMessage> when the model writes several in one response", async () => {
    const w = world([
      response([text("<sendMessage>first thought</sendMessage> and <sendMessage>on reflection, this</sendMessage>")]),
    ]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBe("on reflection, this");
  });

  test("a later round's message replaces an earlier round's", async () => {
    const w = world([
      response(
        [text("<sendMessage>a draft</sendMessage>"), toolUse("t1", "read", { path: "a.md" })],
        "tool_use",
      ),
      response([text("<sendMessage>having read it, this</sendMessage>")]),
    ]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBe("having read it, this");
  });

  test("reads the tag out of a response that carries no content blocks", async () => {
    const w = world([
      {
        content: "<sendMessage>from the flat string</sendMessage>",
        content_blocks: [],
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
        model: "claude-fixture",
      },
    ]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBe("from the flat string");
  });

  test("reads a sendMessage tool call from a response that does not finish on tool_use", async () => {
    const w = world([
      response([toolUse("t1", "sendMessage", { message: "I found something" })], "end_turn"),
    ]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBe("I found something");
    expect(w.dispatched).toEqual([]);
  });

  test("the tool call wins over a tag in the same round", async () => {
    const w = world([
      response(
        [
          text("<sendMessage>about to send</sendMessage>"),
          toolUse("t1", "send_message", { text: "the real one" }),
        ],
        "tool_use",
      ),
      response([text("done")]),
    ]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBe("the real one");
  });

  test("says nothing when the model never asked to", async () => {
    const w = world([response([text("HEARTBEAT_OK")])]);

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.sendMessageText).toBeUndefined();
    expect(result.images).toEqual([]);
  });

  test("carries generated images out of the loop", async () => {
    const w = world(
      [
        response([toolUse("t1", "generate_image", { prompt: "a boat" })], "tool_use"),
        response([text("here it is")]),
      ],
      {},
      () => ({
        output: '{"path":"images/boat.png"}',
        isError: false,
        value: { path: "images/boat.png", caption: "a boat" },
      }),
    );

    const result = await runHeartbeatToolLoop(request(), w.deps);

    expect(result.images).toEqual([{ path: "images/boat.png", caption: "a boat", data: undefined }]);
  });
});

describe("the round budget", () => {
  test("nudges at the cap and keeps going into the grace window", async () => {
    const rounds = Array.from({ length: 8 }, () =>
      response([toolUse("t", "edit", { path: "a.md" })], "tool_use"),
    );
    const w = world(rounds, { maxToolIterations: 2, wrapUpGrace: 3 });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(5);
    expect(w.notes).toContain("Wrap-up nudge: budget reached, model asked to summarize");
    expect(w.notes.filter((n) => n.startsWith("Wrap-up nudge")).length).toBe(1);
  });

  test("the nudge folds into the trailing tool-result turn", async () => {
    const rounds = Array.from({ length: 4 }, () =>
      response([toolUse("t", "edit", { path: "a.md" })], "tool_use"),
    );
    const w = world(rounds, { maxToolIterations: 1, wrapUpGrace: 1 });
    const req = request();

    await runHeartbeatToolLoop(req, w.deps);

    const userTurns = req.messages.filter((m) => m.role === "user");
    const nudged = userTurns.filter((m) =>
      m.content.some((b) => b.type === "text" && b.text.startsWith("[System nudge:")),
    );
    expect(nudged.length).toBe(1);
    expect(nudged[0]?.content.some((b) => b.type === "tool_result")).toBe(true);
  });

  test("stops at the cap when no grace is configured", async () => {
    const rounds = Array.from({ length: 8 }, () =>
      response([toolUse("t", "edit", { path: "a.md" })], "tool_use"),
    );
    const w = world(rounds, { maxToolIterations: 2, wrapUpGrace: 0 });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(2);
    expect(w.notes.filter((n) => n.startsWith("Wrap-up nudge"))).toEqual([]);
  });

  test("a deadline tripped during the grace window ends the loop", async () => {
    const rounds = Array.from({ length: 8 }, () =>
      response([toolUse("t", "edit", { path: "a.md" })], "tool_use"),
    );
    let clock = 0;
    const w = world(rounds, {
      maxToolIterations: 5,
      wrapUpGrace: 3,
      deadlineMs: 10,
      monotonicMs: () => (clock++ < 2 ? 0 : 1000),
    });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(2);
    expect(w.notes.filter((n) => n.startsWith("Wrap-up nudge")).length).toBe(1);
  });

  test("an unlimited cap runs as long as the model keeps asking", async () => {
    const rounds = [
      ...Array.from({ length: 6 }, () => response([toolUse("t", "edit", { path: "a.md" })], "tool_use")),
      response([text("done")]),
    ];
    const w = world(rounds, { maxToolIterations: undefined, wrapUpGrace: 1 });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(7);
    expect(w.notes.filter((n) => n.startsWith("Wrap-up nudge"))).toEqual([]);
  });

  test("an unlimited cap still answers to the deadline", async () => {
    const rounds = Array.from({ length: 8 }, () =>
      response([toolUse("t", "edit", { path: "a.md" })], "tool_use"),
    );
    let clock = 0;
    const w = world(rounds, {
      maxToolIterations: undefined,
      wrapUpGrace: 1,
      deadlineMs: 10,
      monotonicMs: () => (clock++ < 2 ? 0 : 1000),
    });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(2);
    expect(w.notes.filter((n) => n.startsWith("Wrap-up nudge")).length).toBe(1);
  });
});

describe("the loop's rounds", () => {
  test("stops as soon as the model finishes without asking for tools", async () => {
    const w = world([
      response([toolUse("t1", "edit", { path: "a.md" })], "tool_use"),
      response([text("all done")]),
      response([text("never reached")]),
    ]);

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.length).toBe(2);
  });

  test("labels the first call heartbeat and the rest heartbeat_tool_loop", async () => {
    const w = world([
      response([toolUse("t1", "edit", { path: "a.md" })], "tool_use"),
      response([toolUse("t2", "edit", { path: "b.md" })], "tool_use"),
      response([text("done")]),
    ]);

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript.map((r) => r.callType)).toEqual([
      "heartbeat",
      "heartbeat_tool_loop",
      "heartbeat_tool_loop",
    ]);
  });

  test("a failed model call ends the loop rather than being retried", async () => {
    let calls = 0;
    const w = world([], {
      maxToolIterations: 5,
      wrapUpGrace: 3,
      generate: async (_r, iteration) => {
        calls += 1;
        return iteration === 0
          ? response([toolUse("t1", "edit", { path: "a.md" })], "tool_use")
          : undefined;
      },
    });

    await runHeartbeatToolLoop(request(), w.deps);

    expect(calls).toBe(2);
    expect(w.transcript.length).toBe(1);
  });

  test("tool blocks in a response that finished cleanly are read but not run", async () => {
    const w = world([response([toolUse("t1", "edit", { path: "a.md" })], "end_turn")]);

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.dispatched).toEqual([]);
    expect(w.transcript[0]?.captured).toEqual([]);
  });

  test("the transcript row carries the round's tool outputs", async () => {
    const w = world([
      response([toolUse("t1", "edit", { path: "a.md" })], "tool_use"),
      response([text("done")]),
    ]);

    await runHeartbeatToolLoop(request(), w.deps);

    expect(w.transcript[0]?.captured).toEqual([
      { name: "edit", input: { path: "a.md" }, output: "edit ok", isError: false },
    ]);
    expect(w.transcript[1]?.captured).toEqual([]);
  });

  test("every round's assistant turn and tool results land in the request", async () => {
    const w = world([
      response([toolUse("t1", "edit", { path: "a.md" })], "tool_use"),
      response([text("done")]),
    ]);
    const req = request();

    await runHeartbeatToolLoop(req, w.deps);

    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});

describe("the tools the loop answers itself", () => {
  const noop = {
    dispatch: async (): Promise<HeartbeatToolResult> => ({ output: "", isError: false }),
    scheduleNextWake: () => "scheduled",
    note: () => {},
  };

  test("set_next_wake never reaches the tool registry", async () => {
    const dispatched: string[] = [];
    const wakes: { hours: number; reason: string }[] = [];
    const notes: string[] = [];

    const out = await dispatchHeartbeatTools([["t1", "set_next_wake", { hours_from_now: 6, reason: "the essay" }]], {
      dispatch: async (name) => {
        dispatched.push(name);
        return { output: "", isError: false };
      },
      scheduleNextWake: (hours, reason) => {
        wakes.push({ hours, reason });
        return `Scheduled next moment in ${hours.toFixed(1)} hours.`;
      },
      note: (t) => notes.push(t),
    });

    expect(dispatched).toEqual([]);
    expect(wakes).toEqual([{ hours: 6, reason: "the essay" }]);
    expect((out.results[0] as { content: string }).content).toBe(
      "Scheduled next moment in 6.0 hours.",
    );
    expect(notes).toEqual([]);
  });

  test("set_next_wake defaults to an hour with no reason", async () => {
    const wakes: { hours: number; reason: string }[] = [];
    await dispatchHeartbeatTools([["t1", "set_next_wake", {}]], {
      ...noop,
      scheduleNextWake: (hours, reason) => {
        wakes.push({ hours, reason });
        return "scheduled";
      },
    });

    expect(wakes).toEqual([{ hours: 1, reason: "" }]);
  });

  test("sendMessage is acknowledged as delivered rather than refused", async () => {
    const dispatched: string[] = [];
    const out = await dispatchHeartbeatTools([["t1", "SendMessage", { message: "hi" }]], {
      ...noop,
      dispatch: async (name) => {
        dispatched.push(name);
        return { output: "", isError: false };
      },
    });

    expect(dispatched).toEqual([]);
    const content = (out.results[0] as { content: string }).content;
    expect((JSON.parse(content) as { status: string }).status).toBe("delivered");
    expect(out.results[0]).toMatchObject({ is_error: false });
  });

  test("an ordinary tool goes to the registry and gets a ring-buffer line", async () => {
    const notes: string[] = [];
    const out = await dispatchHeartbeatTools([["t1", "edit", { path: "a.md" }]], {
      ...noop,
      dispatch: async () => ({ output: "wrote 12 lines", isError: false }),
      note: (t) => notes.push(t),
    });

    expect(notes).toEqual(["Tool: edit → wrote 12 lines"]);
    expect(out.captured).toEqual([
      { name: "edit", input: { path: "a.md" }, output: "wrote 12 lines", isError: false },
    ]);
  });

  test("a failed tool is text with a flag, not a throw", async () => {
    const out = await dispatchHeartbeatTools([["t1", "edit", { path: "/etc/passwd" }]], {
      ...noop,
      dispatch: async () => ({ output: "invalid args: path escapes the workspace", isError: true }),
    });

    expect(out.results[0]).toMatchObject({ is_error: true });
    expect(out.captured[0]?.isError).toBe(true);
  });

  test("a failed generate_image contributes no image even when it named a path", async () => {
    const out = await dispatchHeartbeatTools([["t1", "generate_image", { prompt: "x" }]], {
      ...noop,
      dispatch: async () => ({
        output: "io: the write did not complete",
        isError: true,
        value: { path: "images/half-written.png" },
      }),
    });

    expect(out.images).toEqual([]);
  });

  test("results come back in the order the model asked for them", async () => {
    const out = await dispatchHeartbeatTools(
      [
        ["t1", "edit", { path: "a.md" }],
        ["t2", "set_next_wake", { hours_from_now: 2, reason: "later" }],
        ["t3", "read", { path: "b.md" }],
      ],
      { ...noop, dispatch: async (name) => ({ output: `${name} ok`, isError: false }) },
    );

    expect(out.results.map((r) => (r as { tool_use_id: string }).tool_use_id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
});
