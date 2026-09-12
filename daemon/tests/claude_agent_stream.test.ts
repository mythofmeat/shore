import { readFile } from "./support/stored_files.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeAgentProvider,
  type AgentQuery,
  nextEntries,
  planTurn,
} from "../src/llm/providers/claude_agent.ts";
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

  test("context_usage is the last round alone, not every round of the tool loop summed", async () => {
    const { events } = await collect({
      rounds: [
        {
          blocks: [{ kind: "text", text: "looking" }],
          startUsage: { input_tokens: 5, cache_read_input_tokens: 50_000 },
          deltaUsage: { output_tokens: 100 },
        },
        {
          blocks: [{ kind: "text", text: "still looking" }],
          startUsage: { input_tokens: 5, cache_read_input_tokens: 56_000 },
          deltaUsage: { output_tokens: 200 },
        },
        {
          blocks: [{ kind: "text", text: "done" }],
          startUsage: { input_tokens: 5, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 900 },
          deltaUsage: { output_tokens: 300 },
        },
      ],
      resultUsage: {
        input_tokens: 15,
        output_tokens: 600,
        cache_read_input_tokens: 166_000,
        cache_creation_input_tokens: 900,
      },
    });
    expect(done(events).usage.cache_read_tokens).toBe(166_000);
    expect(done(events).context_usage).toEqual({
      input_tokens: 5,
      output_tokens: 300,
      cache_read_tokens: 60_000,
      cache_creation_tokens: 900,
    });
  });

  test("a nested agent's rounds do not become the reported context", async () => {
    const { events } = await collect({
      rounds: [
        {
          blocks: [{ kind: "text", text: "mine" }],
          startUsage: { input_tokens: 7, cache_read_input_tokens: 40_000 },
        },
        {
          blocks: [{ kind: "text", text: "nested" }],
          startUsage: { input_tokens: 1, cache_read_input_tokens: 999_000 },
          nested: true,
        },
      ],
    });
    expect(done(events).context_usage?.cache_read_tokens).toBe(40_000);
  });

  test("a run that streamed no context leaves context_usage off so billing usage stands in", async () => {
    const { events } = await collect({
      rounds: [],
      resultUsage: { input_tokens: 11, cache_read_input_tokens: 33 },
    });
    expect(done(events).context_usage).toBeUndefined();
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
    expect(options?.strictMcpConfig).toBe(true);
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

describe("the environment the subprocess is given", () => {
  async function envOf(req: SidecarRequest): Promise<Record<string, string>> {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] }, req);
    return (agent.calls[0]?.options.env ?? {}) as Record<string, string>;
  }

  test("the daemon's own Anthropic key is not inherited, so a subscription turn stays one", async () => {
    const had = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-daemon-key";
    try {
      expect(await envOf(request({ api_key: "" }))).not.toHaveProperty("ANTHROPIC_API_KEY");
    } finally {
      if (had === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = had;
    }
  });

  test("a key the request actually carries is passed on", async () => {
    expect((await envOf(request({ api_key: "sk-ant-asked-for" }))).ANTHROPIC_API_KEY).toBe(
      "sk-ant-asked-for",
    );
  });

  test("nothing else of the daemon's environment leaks in", async () => {
    const had = process.env.SHORE_SECRET_FIXTURE;
    process.env.SHORE_SECRET_FIXTURE = "do-not-forward";
    try {
      expect(Object.keys(await envOf(request()))).not.toContain("SHORE_SECRET_FIXTURE");
    } finally {
      if (had === undefined) delete process.env.SHORE_SECRET_FIXTURE;
      else process.env.SHORE_SECRET_FIXTURE = had;
    }
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

  test("a missing resume anchor clears the stale record so a retry can restore native history", async () => {
    const dir = await bookDir();
    const path = join(dir, "sessions.json");
    const key = "default\u0000";
    const opening = request().messages[0];
    if (opening === undefined) throw new Error("request fixture has no opening message");
    const history = [
      opening,
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "first question" }] },
    ];
    const stale: SessionBook = {
      [key]: {
        version: SESSION_BOOK_VERSION,
        sessionId: "forked-session",
        storedTranscript: true,
        entries: nextEntries({ ...planTurn(undefined, history), resume: "forked-session" }, ["missing-parent-uuid"]),
      },
    };
    await writeFile(path, JSON.stringify(stale), "utf8");
    const agent = fakeAgent({
      rounds: [],
      throwOn: new Error(
        "Claude Code returned an error result: No message found with message.uuid of: missing-parent-uuid",
      ),
    });
    const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
    const req = request({
      messages: [
        ...history.slice(0, 2),
        { role: "user", content: [{ type: "text", text: "edited question" }] },
      ],
    });

    for await (const _event of provider.stream(req)) {
      void _event;
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});

    const retried: StreamEvent[] = [];
    const recovered = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "recovered" }] }] });
    const restarted = new ClaudeAgentProvider({ runQuery: recovered.query, bookPath: () => path });
    for await (const event of restarted.stream(req)) retried.push(event);
    expect(recovered.calls[0]?.options.sessionStore).toBeDefined();
    expect(kinds(retried)).not.toContain("error");
    expect(done(retried).content).toBe("recovered");
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

describe("sending a picture", () => {
  const withImage = request({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });

  test("a turn carrying no images is still sent as plain text", async () => {
    const { agent } = await collect({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
    expect(typeof agent.calls[0]?.prompt).toBe("string");
  });

  test("the image reaches the model rather than only being described", async () => {
    const { agent } = await collect(
      { rounds: [{ blocks: [{ kind: "text", text: "a freezer" }] }] },
      withImage,
    );
    const prompt = agent.calls[0]?.prompt;
    expect(typeof prompt).not.toBe("string");
    const sent = [];
    for await (const turn of prompt as AsyncIterable<{ message: { content: unknown } }>) {
      sent.push(turn.message.content);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(withImage.messages[0]?.content);
  });

  test("an upload does not acquire a replay instruction or a synthetic image label", async () => {
    const { agent } = await collect(
      { rounds: [{ blocks: [{ kind: "text", text: "a freezer" }] }] },
      withImage,
    );
    const prompt = agent.calls[0]?.prompt as AsyncIterable<{
      message: { content: { type: string; text?: string }[] };
    }>;
    const sent = [];
    for await (const turn of prompt) sent.push(turn.message.content.map((b) => b.text ?? "").join("\n"));
    expect(sent[0]).toBe("what is this?\n");
  });
});

describe("native history restoration", () => {
  test("loads prior turns as native history when no matching SDK session exists", async () => {
    const { events, agent } = await collect(
      { rounds: [{ blocks: [{ kind: "text", text: "reply" }] }] },
      request({ messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ] }),
    );
    expect(kinds(events)).not.toContain("error");
    const options = agent.calls[0]?.options;
    expect(options?.sessionStore).toBeDefined();
    const history = await options?.sessionStore?.load({ projectKey: "-tmp", sessionId: options.resume ?? "" });
    expect(history?.map((entry) => entry.type)).toEqual(["user", "assistant"]);
    expect(done(events).content).toBe("reply");
  });

  test("does not warn for a fresh conversation", async () => {
    const { events } = await collect({ rounds: [] });
    expect(kinds(events)).not.toContain("provider_warning");
  });
});

test("a native session continuation does not warn about replay", async () => {
  const path = join(await bookDir(), "sessions.json");
  const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
  const first = request();
  for await (const event of provider.stream(first)) expect(event.type).not.toBe("error");
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request({ messages: [
    ...first.messages,
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ] }))) events.push(event);
  expect(agent.calls[1]?.options.resume).toBeDefined();
  expect(kinds(events)).not.toContain("provider_warning");
});

test.each([false, true])("repeated regeneration of an eleven-message chat uses the original native anchor (image: %s)", async (withImage) => {
  const path = join(await bookDir(), "sessions.json");
  const sessions = new Map<string, Set<string>>();
  const calls: Parameters<AgentQuery>[0][] = [];
  const runQuery: AgentQuery = async function* (params) {
    calls.push(params);
    const { resume, resumeSessionAt, forkSession } = params.options;
    if (resumeSessionAt !== undefined && !sessions.get(resume ?? "")?.has(resumeSessionAt)) {
      throw new Error(`No message found with message.uuid of: ${resumeSessionAt}`);
    }
    const sid = resume === undefined || forkSession === true ? `session-${String(calls.length)}` : resume;
    const anchors = sessions.get(sid) ?? new Set<string>();
    if (forkSession === true) {
      for (const uuid of sessions.get(resume ?? "") ?? []) anchors.add(`${sid}:copy:${uuid}`);
    }
    sessions.set(sid, anchors);
    const agent = fakeAgent({ sessionId: sid, rounds: [{ blocks: [{ kind: "text", text: `reply ${String(calls.length)}` }] }] });
    for await (const frame of agent.query(params)) {
      if (frame.type === "assistant") {
        const uuid = `${sid}:${String(calls.length)}:${frame.uuid}` as typeof frame.uuid;
        anchors.add(uuid);
        yield { ...frame, uuid };
      } else yield frame;
    }
  };
  const provider = new ClaudeAgentProvider({ runQuery, bookPath: () => path });
  const history: SidecarRequest["messages"] = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    history.push({ role: "user", content: [
      ...(withImage && turn === 6 ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aW1hZ2U=" } }] : []),
      { type: "text", text: `question ${String(turn)}` },
    ] });
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request({ messages: [...history] }))) events.push(event);
    expect(kinds(events)).not.toContain("error");
    if (turn < 6) history.push({ role: "assistant", content: [{ type: "text", text: done(events).content }] });
  }
  expect(history).toHaveLength(11);
  for (let regeneration = 0; regeneration < 3; regeneration += 1) {
    const restarted = new ClaudeAgentProvider({ runQuery, bookPath: () => path });
    const events: StreamEvent[] = [];
    for await (const event of restarted.stream(request({ messages: [...history] }))) events.push(event);
    expect(kinds(events)).not.toContain("error");
    expect(kinds(events)).not.toContain("provider_warning");
    const prompt = calls.at(-1)?.prompt;
    if (withImage && typeof prompt !== "string" && prompt !== undefined) {
      const turns = [];
      for await (const message of prompt) turns.push(message.message.content);
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(turns)).toContain("question 6");
      expect(JSON.stringify(turns)).not.toContain("prior_assistant_turn");
    } else expect(prompt).toBe("question 6");
    expect(calls.at(-1)?.options.resume).toBe("session-1");
    expect(calls.at(-1)?.options.resumeSessionAt).toBe("session-1:5:msg_0_asst_0");
    expect(calls.at(-1)?.options.forkSession).toBe(true);
  }
});

test("temporary system instructions do not diverge the conversation on the next turn", async () => {
  const path = join(await bookDir(), "sessions.json");
  const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "reply" }] }] });
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
  const history = request().messages;
  for (const instruction of ["first recall", "second recall"]) {
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request({ messages: [
      ...history,
      { role: "system", content: [{ type: "text", text: instruction }] },
    ] }))) events.push(event);
    expect(kinds(events)).not.toContain("error");
    const prompt = agent.calls.at(-1)?.options.systemPrompt;
    expect(prompt).toBeUndefined();
    const sent = agent.calls.at(-1)?.prompt;
    if (sent === undefined || typeof sent === "string") throw new Error("Expected structured turn content");
    const turns = [];
    for await (const turn of sent) turns.push(turn.message.content);
    expect(JSON.stringify(turns)).toContain(instruction);
    history.push({ role: "assistant", content: [{ type: "text", text: "reply" }] });
    history.push({ role: "user", content: [{ type: "text", text: "continue" }] });
  }
  expect(agent.calls[1]?.options.resume).toBe("session-fake");
});

test("a heartbeat between chat turns cannot replace the chat session", async () => {
  const path = join(await bookDir(), "sessions.json");
  const chat = fakeAgent({ sessionId: "chat-session", rounds: [{ blocks: [{ kind: "text", text: "chat reply" }] }] });
  const heartbeat = fakeAgent({ sessionId: "heartbeat-session", rounds: [{ blocks: [{ kind: "text", text: "heartbeat reply" }] }] });
  const provider = new ClaudeAgentProvider({ runQuery: chat.query, bookPath: () => path });
  const background = new ClaudeAgentProvider({ runQuery: heartbeat.query, bookPath: () => path });
  const context = { character: "qifei", ledger: "/data/ledger.db", call_type: "message", thinking_enabled: false };
  const first = request({ context });
  for await (const event of provider.stream(first)) expect(event.type).not.toBe("error");
  for await (const event of background.stream(request({ context: { ...context, call_type: "heartbeat" } }))) {
    expect(event.type).not.toBe("error");
  }
  for await (const event of provider.stream(request({ context, messages: [
    ...first.messages,
    { role: "assistant", content: [{ type: "text", text: "chat reply" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ] }))) expect(event.type).not.toBe("error");
  expect(chat.calls[1]?.options.resume).toBe("chat-session");
  expect(chat.calls[1]?.prompt).toBe("continue");
  const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
  expect(Object.values(book).map(record => record.sessionId).sort()).toEqual(["chat-session", "heartbeat-session"]);
});
