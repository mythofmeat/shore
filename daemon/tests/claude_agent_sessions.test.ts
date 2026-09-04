import { describe, expect, test } from "bun:test";

import {
  agentEffort,
  conversationKey,
  nextEntries,
  planTurn,
  type SessionRecord,
} from "../src/llm/providers/claude_agent.ts";
import {
  SESSION_BOOK_VERSION,
  sessionKey,
  sessionKeyThread,
  withoutThread,
  type SessionBook,
} from "../src/llm/providers/agent_sessions.ts";
import type { CallContext, SidecarRequest, WireMessage } from "../src/llm/types.ts";

function msg(role: WireMessage["role"], text: string): WireMessage {
  return { role, content: [{ type: "text", text }] };
}

const user1 = msg("user", "my freezer died. i'm calling it Brian.");
const asst1 = msg("assistant", "rest in piss, Brian.");
const user2 = msg("user", "what was his name again?");
const user2b = msg("user", "remind me what i named him?");

function messageHashOf(m: WireMessage): string {
  return nextEntries(planTurn(undefined, [m]), undefined)[0]?.hash ?? "";
}

function seed(history: readonly WireMessage[], assistantUuid?: string): SessionRecord {
  const plan = planTurn(undefined, history);
  return {
    version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
    entries: nextEntries(plan, undefined),
    ...(assistantUuid === undefined ? {} : { pendingAssistantUuids: [assistantUuid] }),
  };
}

describe("planTurn", () => {
  test("cold start replays the whole history and opens a new session", () => {
    const plan = planTurn(undefined, [user1]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
    expect(plan.prompt).toContain("Brian");
    expect(plan.delivered).toHaveLength(1);
  });

  test("cold start marks prior assistant turns so they are not read as the user", () => {
    const plan = planTurn(undefined, [user1, asst1, user2]);
    expect(plan.prompt).toContain("<prior_assistant_turn>");
    expect(plan.prompt).toContain("rest in piss");
  });

  test("an exact prefix resumes the session and sends only the new user turn", () => {
    const record = seed([user1], "asst-uuid-1");
    const plan = planTurn(record, [user1, asst1, user2]);
    expect(plan.resume).toBe("session-1");
    expect(plan.fork).toBe(false);
    expect(plan.prompt).toBe("what was his name again?");
    expect(plan.prompt).not.toContain("rest in piss");
  });

  test("a diverged tail forks at the last kept assistant uuid", () => {
    const record: SessionRecord = {
      version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
      entries: [
        { hash: "h-user1" },
        { hash: "h-asst1", uuid: "asst-uuid-1" },
        { hash: "h-user2" },
      ],
      pendingAssistantUuids: ["asst-uuid-2"],
    };
    const seeded = planTurn(undefined, [user1, asst1, user2]);
    record.entries = nextEntries(seeded, ["asst-uuid-1"]);

    const plan = planTurn(record, [user1, asst1, user2b]);
    expect(plan.fork).toBe(true);
    expect(plan.resume).toBe("session-1");
    expect(plan.resumeSessionAt).toBe("asst-uuid-1");
    expect(plan.prompt).toBe("remind me what i named him?");
  });

  test("a fully diverged history falls back to a cold start", () => {
    const record = seed([user1], "asst-uuid-1");
    const plan = planTurn(record, [msg("user", "completely different opener")]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
  });
});

describe("planTurn regeneration", () => {
  function afterTwoTurns(): SessionRecord {
    const cold = planTurn(undefined, [user1]);
    const first: SessionRecord = { version: SESSION_BOOK_VERSION, sessionId: "session-1", entries: nextEntries(cold, undefined) };
    const second = planTurn(first, [user1, asst1, user2]);
    return {
      version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
      entries: nextEntries(second, ["asst-uuid-1"]),
      pendingAssistantUuids: ["asst-uuid-2"],
    };
  }

  test("regenerating the latest turn never sends an empty prompt", () => {
    const plan = planTurn(afterTwoTurns(), [user1, asst1, user2]);
    expect(plan.prompt).not.toBe("");
    expect(plan.prompt).toBe("what was his name again?");
  });

  test("regenerating the latest turn forks at the preceding assistant turn", () => {
    const plan = planTurn(afterTwoTurns(), [user1, asst1, user2]);
    expect(plan.fork).toBe(true);
    expect(plan.resume).toBe("session-1");
    expect(plan.resumeSessionAt).toBe("asst-uuid-1");
  });

  test("the regenerated turn is redelivered rather than assumed present", () => {
    const plan = planTurn(afterTwoTurns(), [user1, asst1, user2]);
    expect(plan.keptEntries).toHaveLength(2);
    expect(plan.delivered).toHaveLength(1);
    expect(nextEntries(plan, ["asst-uuid-2"])).toHaveLength(3);
  });

  test("regenerating the very first reply cold starts, since nothing can anchor a fork", () => {
    const cold = planTurn(undefined, [user1]);
    const record: SessionRecord = {
      version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
      entries: nextEntries(cold, undefined),
      pendingAssistantUuids: ["asst-uuid-1"],
    };
    const plan = planTurn(record, [user1]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
    expect(plan.prompt).toContain("Brian");
  });
});

describe("planTurn fork bookkeeping", () => {
  test("a fork does not keep entries the forked session cannot contain", () => {
    const nudge = msg("user", "still there?");
    const record: SessionRecord = {
      version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
      entries: [
        { hash: messageHashOf(user1) },
        { hash: messageHashOf(asst1), uuid: "asst-uuid-1" },
        { hash: messageHashOf(user2) },
        { hash: messageHashOf(nudge) },
      ],
    };
    const plan = planTurn(record, [user1, asst1, user2, msg("user", "different nudge")]);

    expect(plan.fork).toBe(true);
    expect(plan.resumeSessionAt).toBe("asst-uuid-1");
    expect(plan.keptEntries).toHaveLength(2);
    expect(plan.prompt).toContain("what was his name again?");
    expect(plan.prompt).toContain("different nudge");
    expect(plan.prompt).not.toContain("still there?");
  });
});

describe("nextEntries", () => {
  test("anchors the assistant entry to the uuid captured on the previous turn", () => {
    const record = seed([user1], "asst-uuid-1");
    const plan = planTurn(record, [user1, asst1, user2]);
    const entries = nextEntries(plan, ["asst-uuid-1"]);

    expect(entries).toHaveLength(3);
    expect(entries[1]?.uuid).toBe("asst-uuid-1");
    expect(entries[0]?.uuid).toBeUndefined();
    expect(entries[2]?.uuid).toBeUndefined();
  });

  test("consumes the pending uuid once so later assistants stay unanchored", () => {
    const plan = planTurn(undefined, [user1, asst1, msg("assistant", "second")]);
    const entries = nextEntries(plan, ["asst-uuid-1"]);
    expect(entries[1]?.uuid).toBe("asst-uuid-1");
    expect(entries[2]?.uuid).toBeUndefined();
  });
});

describe("agentEffort", () => {
  test("passes named levels through and drops off and junk", () => {
    expect(agentEffort("xhigh")).toBe("xhigh");
    expect(agentEffort("max")).toBe("max");
    expect(agentEffort("off")).toBeUndefined();
    expect(agentEffort("adaptive")).toBeUndefined();
    expect(agentEffort(undefined)).toBeUndefined();
  });
});

describe("conversationKey", () => {
  function request(context: CallContext | undefined): SidecarRequest {
    return {
      sdk: "claude_agent",
      model: "claude-opus-5",
      api_key: "",
      messages: [],
      max_tokens: 100,
      replay_prior_thinking: "all",
      ...(context === undefined ? {} : { context }),
    };
  }
  const context = (thread?: string): CallContext => ({
    character: "qifei",
    ledger: "/data/ledger.db",
    call_type: "message",
    thinking_enabled: false,
    ...(thread === undefined ? {} : { thread }),
  });

  test("a thread of its own gets a session of its own", () => {
    expect(conversationKey(request(context("scratch")))).not.toBe(
      conversationKey(request(context("eval"))),
    );
  });

  test("main keeps the key it had before threads existed, so live sessions survive", () => {
    const beforeThreads = conversationKey(request(context()));
    expect(conversationKey(request(context("main")))).toBe(beforeThreads);
    expect(beforeThreads).toBe("qifei\u0000/data/ledger.db");
  });

  test("the key still separates characters and ledgers", () => {
    expect(conversationKey(request({ ...context("scratch"), character: "aria" }))).not.toBe(
      conversationKey(request(context("scratch"))),
    );
    expect(conversationKey(request({ ...context("scratch"), ledger: "/other.db" }))).not.toBe(
      conversationKey(request(context("scratch"))),
    );
  });

  test("no context at all is still a usable key", () => {
    expect(conversationKey(request(undefined))).toBe("default\u0000");
  });
});

describe("forgetting a thread's sessions", () => {
  const book = (): SessionBook => ({
    [sessionKey("qifei", "/l.db", "main")]: { version: SESSION_BOOK_VERSION, sessionId: "home", entries: [] },
    [sessionKey("qifei", "/l.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "eval", entries: [] },
    [sessionKey("qifei", "/other.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "eval-other", entries: [] },
    [sessionKey("aria", "/l.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "aria-eval", entries: [] },
  });

  test("drops every ledger's session for that character's thread", () => {
    const kept = withoutThread(book(), "qifei", "eval");
    expect(Object.values(kept ?? {}).map((r) => r.sessionId).sort()).toEqual([
      "aria-eval",
      "home",
    ]);
  });

  test("another character's identically named thread is left alone", () => {
    const kept = withoutThread(book(), "aria", "eval");
    expect(kept?.[sessionKey("qifei", "/l.db", "eval")]?.sessionId).toBe("eval");
  });

  test("a book with nothing to drop says so rather than rewriting itself", () => {
    expect(withoutThread(book(), "qifei", "nowhere")).toBeUndefined();
  });

  test("home is reachable by name even though its key does not carry one", () => {
    expect(sessionKeyThread(sessionKey("qifei", "/l.db", "main"))).toBe("main");
    expect(sessionKeyThread(sessionKey("qifei", "/l.db", "eval"))).toBe("eval");
    const kept = withoutThread(book(), "qifei", "main");
    expect(kept?.[sessionKey("qifei", "/l.db", "main")]).toBeUndefined();
    expect(kept?.[sessionKey("qifei", "/l.db", "eval")]?.sessionId).toBe("eval");
  });
});

describe("what a message hash is taken over", () => {
  const withBlocks = (role: WireMessage["role"], content: WireMessage["content"]): WireMessage => ({
    role,
    content,
  });

  const image = (data: string, media_type = "image/png"): WireMessage =>
    withBlocks("user", [{ type: "image", source: { type: "base64", media_type, data } }]);

  test("two turns differing only by the image attached no longer collide", () => {
    expect(messageHashOf(image("AAAA"))).not.toBe(messageHashOf(image("BBBB")));
  });

  test("the same image under a different media type is a different turn", () => {
    expect(messageHashOf(image("AAAA"))).not.toBe(messageHashOf(image("AAAA", "image/jpeg")));
  });

  test("a caption alongside an image is not the whole of what is hashed", () => {
    const captioned = (data: string): WireMessage =>
      withBlocks("user", [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
      ]);
    expect(messageHashOf(captioned("AAAA"))).not.toBe(messageHashOf(captioned("BBBB")));
  });

  test("two tool calls to the same tool with different arguments are told apart", () => {
    const call = (path: string): WireMessage =>
      withBlocks("assistant", [{ type: "tool_use", id: "t1", name: "read", input: { path } }]);
    expect(messageHashOf(call("SOUL.md"))).not.toBe(messageHashOf(call("USER.md")));
  });

  test("the same arguments in a different key order are the same call", () => {
    const call = (input: unknown): WireMessage =>
      withBlocks("assistant", [{ type: "tool_use", id: "t1", name: "read", input }]);
    expect(messageHashOf(call({ path: "SOUL.md", limit: 10 }))).toBe(
      messageHashOf(call({ limit: 10, path: "SOUL.md" })),
    );
  });

  test("two tool results carrying different output are told apart", () => {
    const result = (content: string): WireMessage =>
      withBlocks("user", [{ type: "tool_result", tool_use_id: "t1", content }]);
    expect(messageHashOf(result("ok"))).not.toBe(messageHashOf(result("no such file")));
  });

  test("a failed tool result is not the same as a successful one with the same text", () => {
    const result = (is_error: boolean): WireMessage =>
      withBlocks("user", [{ type: "tool_result", tool_use_id: "t1", content: "no", is_error }]);
    expect(messageHashOf(result(true))).not.toBe(messageHashOf(result(false)));
  });

  test("a whitespace-only text block is ignored, so recording and replay agree", () => {
    const recorded = withBlocks("assistant", [
      { type: "text", text: "   " },
      { type: "tool_use", id: "t1", name: "read", input: { path: "SOUL.md" } },
    ]);
    const replayed = withBlocks("assistant", [
      { type: "tool_use", id: "t1", name: "read", input: { path: "SOUL.md" } },
    ]);
    expect(messageHashOf(recorded)).toBe(messageHashOf(replayed));
  });

  test("the role is still part of the hash", () => {
    expect(messageHashOf(msg("user", "same"))).not.toBe(messageHashOf(msg("assistant", "same")));
  });
});

describe("the session book version", () => {
  test("a book written before the hash changed is not trusted", () => {
    const stale = { ...seed([user1]), version: 1 };
    const plan = planTurn(stale, [user1, asst1, user2]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
    expect(plan.prompt).toContain("Brian");
  });

  test("a book from before rounds were anchored one by one is not trusted", () => {
    const stale = { ...seed([user1]), version: 2 };
    expect(planTurn(stale, [user1, asst1, user2]).resume).toBeUndefined();
  });

  test("a book with no version at all is not trusted either", () => {
    const { version: _dropped, ...legacy } = seed([user1]);
    const plan = planTurn(legacy as SessionRecord, [user1, asst1, user2]);
    expect(plan.resume).toBeUndefined();
  });
});

describe("replaying a history that is not all text", () => {
  test("an image-only turn is named rather than silently deleted", () => {
    const withImage: WireMessage = {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }],
    };
    const plan = planTurn(undefined, [withImage, asst1, user2]);
    expect(plan.prompt).toContain("image omitted");
    expect(plan.prompt).toContain("image/png");
  });
});

describe("replaying a history that used tools", () => {
  const toolTurn: WireMessage[] = [
    { role: "user", content: [{ type: "text", text: "what does SOUL.md say?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me look." },
        { type: "tool_use", id: "t1", name: "read", input: { path: "SOUL.md" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "his name is Brian" }],
    },
    { role: "assistant", content: [{ type: "text", text: "it says Brian." }] },
    { role: "user", content: [{ type: "text", text: "and the freezer?" }] },
  ];

  test("a cold start keeps what the assistant did, not only what it said", () => {
    const plan = planTurn(undefined, toolTurn);
    expect(plan.prompt).toContain("<prior_tool_call");
    expect(plan.prompt).toContain('name="read"');
    expect(plan.prompt).toContain('{"path":"SOUL.md"}');
  });

  test("the answers those calls came back with survive too", () => {
    const plan = planTurn(undefined, toolTurn);
    expect(plan.prompt).toContain("<prior_tool_result>");
    expect(plan.prompt).toContain("his name is Brian");
  });

  test("a tool result is not replayed as though the user had typed it", () => {
    const plan = planTurn(undefined, toolTurn);
    const beforeResult = plan.prompt.slice(0, plan.prompt.indexOf("his name is Brian"));
    expect(beforeResult.endsWith("<prior_tool_result>\n")).toBe(true);
  });

  test("a failed call is replayed as one", () => {
    const failed: WireMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true },
        ],
      },
      { role: "user", content: [{ type: "text", text: "try again" }] },
    ];
    expect(planTurn(undefined, failed).prompt).toContain('failed="true"');
  });

  test("an extension past a tool round still resumes rather than replaying it", () => {
    const record = seed(toolTurn.slice(0, 4));
    const plan = planTurn(record, toolTurn);
    expect(plan.resume).toBe("session-1");
    expect(plan.prompt).toBe("and the freezer?");
  });
});

describe("anchoring several rounds in one turn", () => {
  test("each assistant turn is given its own frame, in order", () => {
    const plan = planTurn(undefined, [
      user1,
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    const entries = nextEntries(plan, ["uuid-one", "uuid-two"]);
    expect(entries.map((e) => e.uuid)).toEqual([
      undefined,
      "uuid-one",
      undefined,
      "uuid-two",
    ]);
  });

  test("an assistant turn with no frame to anchor on is left unanchored", () => {
    const plan = planTurn(undefined, [
      user1,
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    expect(nextEntries(plan, ["uuid-one"]).map((e) => e.uuid)).toEqual([
      undefined,
      "uuid-one",
      undefined,
      undefined,
    ]);
  });
});
