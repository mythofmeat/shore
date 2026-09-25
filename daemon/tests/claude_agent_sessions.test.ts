
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

function nativeHistory(history: readonly WireMessage[], uuids: string[]) {
  return nextEntries({ ...planTurn(undefined, history), resume: "session-1" }, uuids);
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
  test("cold start keeps structured history for native restoration", () => {
    const plan = planTurn(undefined, [user1]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
    expect(plan.delivered).toEqual([user1]);
  });


  test("an exact prefix resumes the session and sends only the new user turn", () => {
    const record = seed([user1], "asst-uuid-1");
    const plan = planTurn(record, [user1, asst1, user2]);
    expect(plan.resume).toBe("session-1");
    expect(plan.fork).toBe(false);
    expect(plan.delivered).toEqual([asst1, user2]);
  });

  test("a diverged tail forks at the last kept assistant uuid", () => {
    const record: SessionRecord = {
      version: SESSION_BOOK_VERSION,
    sessionId: "session-1",
      entries: nativeHistory([user1, asst1, user2], ["asst-uuid-1"]),
      pendingAssistantUuids: ["asst-uuid-2"],
    };
    const plan = planTurn(record, [user1, asst1, user2b]);
    expect(plan.fork).toBe(true);
    expect(plan.resume).toBe("session-1");
    expect(plan.resumeSessionAt).toBe("asst-uuid-1");
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
    expect(plan.delivered).toEqual([user2]);
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
  });

  test("a fork keeps parent anchors bound to the session that owns them", () => {
    const record: SessionRecord = {
      version: SESSION_BOOK_VERSION,
      sessionId: "session-1",
      entries: nativeHistory([user1, asst1, user2], ["asst-uuid-1"]),
      pendingAssistantUuids: ["asst-uuid-2"],
    };
    const plan = planTurn(record, [user1, asst1, user2b]);
    const entries = nextEntries(plan, record.pendingAssistantUuids);

    expect(plan.fork).toBe(true);
    expect(entries[1]).toEqual({ hash: messageHashOf(asst1), uuid: "asst-uuid-1", sessionId: "session-1" });
    expect(entries[2]?.uuid).toBeUndefined();
    const fork = { ...record, sessionId: "fork-1", entries };
    const again = planTurn(fork, [user1, asst1, user2b]);
    expect(again.resume).toBe("session-1");
    expect(again.resumeSessionAt).toBe("asst-uuid-1");
    const twice = { ...fork, sessionId: "fork-2", entries: nextEntries(again, ["fork-reply"]) };
    expect(planTurn(twice, [user1, asst1, user2b]).resume).toBe("session-1");
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
    const plan = planTurn(seed([user1]), [user1, asst1, msg("assistant", "second")]);
    const entries = nextEntries(plan, ["asst-uuid-1"]);
    expect(entries[1]?.uuid).toBe("asst-uuid-1");
    expect(entries[2]?.uuid).toBeUndefined();
  });

  test("a cold start never adopts assistant UUIDs from an old session", () => {
    const plan = planTurn(undefined, [user1, asst1, user2]);
    expect(nextEntries(plan, ["old-session-reply"]).every((entry) => entry.uuid === undefined)).toBe(true);
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
    character: "heidi",
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

  test("background workflows cannot replace the main chat session", () => {
    const keys = ["message", "heartbeat", "compaction", "subagent"].map((call_type) =>
      conversationKey(request({ ...context(), call_type })));
    expect(new Set(keys).size).toBe(keys.length);
    expect(conversationKey(request({ ...context(), call_type: "heartbeat_tool_loop" }))).toBe(keys[1] ?? "");
    expect(conversationKey(request({ ...context(), call_type: "tool_loop" }))).toBe(keys[0] ?? "");
  });

  test("a keepalive ping reads the main chat session, since that is the cache it keeps warm", () => {
    expect(conversationKey(request({ ...context(), call_type: "keepalive" })))
      .toBe(conversationKey(request({ ...context(), call_type: "message" })));
  });
});

describe("forgetting a thread's sessions", () => {
  const book = (): SessionBook => ({
    [sessionKey("heidi", "/l.db", "main")]: { version: SESSION_BOOK_VERSION, sessionId: "home", entries: [] },
    [sessionKey("heidi", "/l.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "eval", entries: [] },
    [sessionKey("heidi", "/other.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "eval-other", entries: [] },
    [sessionKey("aria", "/l.db", "eval")]: { version: SESSION_BOOK_VERSION, sessionId: "aria-eval", entries: [] },
  });

  test("background session keys retain their owner and thread for cleanup", () => {
    const key = sessionKey("heidi", "/l.db", "main", "heartbeat");
    const record: SessionRecord = { version: SESSION_BOOK_VERSION, sessionId: "heartbeat", entries: [] };
    expect(sessionKeyThread(key)).toBe("main");
    expect(withoutThread({ [key]: record }, "heidi", "main")).toEqual({});
  });

  test("drops every ledger's session for that character's thread", () => {
    const kept = withoutThread(book(), "heidi", "eval");
    expect(Object.values(kept ?? {}).map((r) => r.sessionId).sort()).toEqual([
      "aria-eval",
      "home",
    ]);
  });

  test("another character's identically named thread is left alone", () => {
    const kept = withoutThread(book(), "aria", "eval");
    expect(kept?.[sessionKey("heidi", "/l.db", "eval")]?.sessionId).toBe("eval");
  });

  test("a book with nothing to drop says so rather than rewriting itself", () => {
    expect(withoutThread(book(), "heidi", "nowhere")).toBeUndefined();
  });

  test("home is reachable by name even though its key does not carry one", () => {
    expect(sessionKeyThread(sessionKey("heidi", "/l.db", "main"))).toBe("main");
    expect(sessionKeyThread(sessionKey("heidi", "/l.db", "eval"))).toBe("eval");
    const kept = withoutThread(book(), "heidi", "main");
    expect(kept?.[sessionKey("heidi", "/l.db", "main")]).toBeUndefined();
    expect(kept?.[sessionKey("heidi", "/l.db", "eval")]?.sessionId).toBe("eval");
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
  test("a book that may contain flattened history is not trusted", () => {
    const stale = { ...seed([user1, asst1, user2]), version: 6 };
    expect(planTurn(stale, [user1, asst1, user2, msg("assistant", "reply"), msg("user", "continue")]).resume).toBeUndefined();
  });

  test("a book written before the hash changed is not trusted", () => {
    const stale = { ...seed([user1]), version: 1 };
    const plan = planTurn(stale, [user1, asst1, user2]);
    expect(plan.resume).toBeUndefined();
    expect(plan.fork).toBe(false);
  });

  test("a book from before rounds were anchored one by one is not trusted", () => {
    const stale = { ...seed([user1]), version: 2 };
    expect(planTurn(stale, [user1, asst1, user2]).resume).toBeUndefined();
  });

  test("a book from before forked UUIDs were dropped is not trusted", () => {
    const stale = { ...seed([user1]), version: 3 };
    expect(planTurn(stale, [user1, asst1, user2]).resume).toBeUndefined();
  });

  test("a book with no version at all is not trusted either", () => {
    const { version: _dropped, ...legacy } = seed([user1]);
    const plan = planTurn(legacy as SessionRecord, [user1, asst1, user2]);
    expect(plan.resume).toBeUndefined();
  });
});



describe("anchoring several rounds in one turn", () => {
  test("each assistant turn is given its own frame, in order", () => {
    const plan = planTurn(seed([user1]), [
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
    const plan = planTurn(seed([user1]), [
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
