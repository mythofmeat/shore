import { describe, expect, test } from "bun:test";

import {
  agentEffort,
  nextEntries,
  planTurn,
  type SessionRecord,
} from "../src/llm/providers/claude_agent.ts";
import type { WireMessage } from "../src/llm/types.ts";

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
    sessionId: "session-1",
    entries: nextEntries(plan, undefined),
    ...(assistantUuid === undefined ? {} : { pendingAssistantUuid: assistantUuid }),
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
      sessionId: "session-1",
      entries: [
        { hash: "h-user1" },
        { hash: "h-asst1", uuid: "asst-uuid-1" },
        { hash: "h-user2" },
      ],
      pendingAssistantUuid: "asst-uuid-2",
    };
    const seeded = planTurn(undefined, [user1, asst1, user2]);
    record.entries = nextEntries(seeded, "asst-uuid-1");

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
    const first: SessionRecord = { sessionId: "session-1", entries: nextEntries(cold, undefined) };
    const second = planTurn(first, [user1, asst1, user2]);
    return {
      sessionId: "session-1",
      entries: nextEntries(second, "asst-uuid-1"),
      pendingAssistantUuid: "asst-uuid-2",
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
    expect(nextEntries(plan, "asst-uuid-2")).toHaveLength(3);
  });

  test("regenerating the very first reply cold starts, since nothing can anchor a fork", () => {
    const cold = planTurn(undefined, [user1]);
    const record: SessionRecord = {
      sessionId: "session-1",
      entries: nextEntries(cold, undefined),
      pendingAssistantUuid: "asst-uuid-1",
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
    const entries = nextEntries(plan, "asst-uuid-1");

    expect(entries).toHaveLength(3);
    expect(entries[1]?.uuid).toBe("asst-uuid-1");
    expect(entries[0]?.uuid).toBeUndefined();
    expect(entries[2]?.uuid).toBeUndefined();
  });

  test("consumes the pending uuid once so later assistants stay unanchored", () => {
    const plan = planTurn(undefined, [user1, asst1, msg("assistant", "second")]);
    const entries = nextEntries(plan, "asst-uuid-1");
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
