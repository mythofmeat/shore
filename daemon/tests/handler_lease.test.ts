import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage";
import { LEASE_TTL_MS, StreamLeases, type LeaseRouter } from "../src/handler/lease";
import { SessionRouter, type ClientInfo, type DirectSender } from "../src/swp/session";

const T0 = 1_700_000_000_000;

function client(id: number): ClientInfo {
  return { id, clientType: "tui", clientName: `test-${id}`, capabilities: [], character: "Alice" };
}

function probe(name: string): ServerMessage {
  return { type: "command_output", rid: null, name, data: {} };
}

function router(...sessionIds: number[]) {
  const received = new Map<number, ServerMessage[]>(sessionIds.map((id) => [id, []]));
  const failing = new Set<number>();
  return {
    senderFor(sessionId: number): DirectSender | undefined {
      const inbox = received.get(sessionId);
      if (inbox === undefined) return undefined;
      return async (msg) => {
        if (failing.has(sessionId)) throw new Error(`session ${sessionId} is gone`);
        inbox.push(msg);
      };
    },
    names: (sessionId: number) => (received.get(sessionId) ?? []).map((m) => (m as { name: string }).name),
    breaks: (sessionId: number) => failing.add(sessionId),
  } satisfies LeaseRouter & Record<string, unknown>;
}

describe("taking the lease", () => {
  test("a user message takes it", () => {
    const leases = new StreamLeases();
    leases.observe("Alice", 1, "message", T0);

    expect(leases.spectator("Alice", 2, router(1), T0)).toBeDefined();
  });

  test.each(["regen", "cancel", "command"] as const)("a %s does not", (kind) => {
    const leases = new StreamLeases();
    leases.observe("Alice", 1, kind, T0);

    expect(leases.spectator("Alice", 2, router(1), T0)).toBeUndefined();
  });

  test("the most recent sender holds it", () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 1, "message", T0);
    leases.observe("Alice", 2, "message", T0 + 1);

    expect(leases.spectator("Alice", 1, sessions, T0 + 2)).toBeDefined();
    expect(leases.spectator("Alice", 2, sessions, T0 + 2)).toBeUndefined();
  });

  test("leases are per character", () => {
    const leases = new StreamLeases();
    leases.observe("Alice", 1, "message", T0);

    expect(leases.spectator("Bob", 2, router(1), T0)).toBeUndefined();
  });
});

describe("resolving it", () => {
  test("a lease held by the issuer yields nobody", () => {
    const leases = new StreamLeases();
    leases.observe("Alice", 1, "message", T0);

    expect(leases.spectator("Alice", 1, router(1), T0)).toBeUndefined();
  });

  test("it lapses exactly at the TTL, and is evicted", () => {
    const leases = new StreamLeases();
    const sessions = router(1);
    leases.observe("Alice", 1, "message", T0);

    expect(leases.spectator("Alice", 2, sessions, T0 + LEASE_TTL_MS - 1)).toBeDefined();
    expect(leases.spectator("Alice", 2, sessions, T0 + LEASE_TTL_MS)).toBeUndefined();
    expect(leases.spectator("Alice", 2, sessions, T0)).toBeUndefined();
  });

  test("an hour, in minutes rather than in the constant", () => {
    const leases = new StreamLeases();
    const sessions = router(1);
    const minutes = (n: number) => T0 + n * 60_000;
    leases.observe("Alice", 1, "message", T0);

    expect(leases.spectator("Alice", 2, sessions, minutes(59))).toBeDefined();
    expect(leases.spectator("Alice", 2, sessions, minutes(61))).toBeUndefined();
  });

  test("a lease on a disconnected session yields nobody, and is evicted", () => {
    const leases = new StreamLeases();
    leases.observe("Alice", 99, "message", T0);

    expect(leases.spectator("Alice", 1, router(1), T0)).toBeUndefined();
    expect(leases.spectator("Alice", 1, router(99), T0)).toBeUndefined();
  });

  test("clearing forgets every character", () => {
    const leases = new StreamLeases();
    const sessions = router(1);
    leases.observe("Alice", 1, "message", T0);
    leases.observe("Bob", 1, "message", T0);

    leases.clear();

    expect(leases.spectator("Alice", 2, sessions, T0)).toBeUndefined();
    expect(leases.spectator("Bob", 2, sessions, T0)).toBeUndefined();
  });
});

describe("the fanout", () => {
  test("delivers to the lease holder as well as the issuer", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 2, "message", T0);

    const issuer = sessions.senderFor(1);
    await leases.fanout("Alice", 1, issuer!, sessions, T0)(probe("chunk"));

    expect(sessions.names(1)).toEqual(["chunk"]);
    expect(sessions.names(2)).toEqual(["chunk"]);
  });

  test("delivers once when the issuer holds the lease", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 1, "message", T0);

    const issuer = sessions.senderFor(1);
    await leases.fanout("Alice", 1, issuer!, sessions, T0)(probe("chunk"));

    expect(sessions.names(1)).toEqual(["chunk"]);
    expect(sessions.names(2)).toEqual([]);
  });

  test("delivers to the issuer alone when there is no lease", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);

    const issuer = sessions.senderFor(1);
    await leases.fanout("Alice", 1, issuer!, sessions, T0)(probe("chunk"));

    expect(sessions.names(1)).toEqual(["chunk"]);
    expect(sessions.names(2)).toEqual([]);
  });

  test("the recipients are fixed when the generation starts", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 2, "message", T0);

    const send = leases.fanout("Alice", 1, sessions.senderFor(1)!, sessions, T0);
    leases.clear();
    await send(probe("chunk"));

    expect(sessions.names(2)).toEqual(["chunk"]);
  });

  test("a dead recipient does not stop the other", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 2, "message", T0);
    sessions.breaks(2);

    const send = leases.fanout("Alice", 1, sessions.senderFor(1)!, sessions, T0);

    await send(probe("chunk"));
    expect(sessions.names(1)).toEqual(["chunk"]);
  });

  test("the real router satisfies what the lease asks of it", async () => {
    const delivered: string[] = [];
    const real = new SessionRouter();
    real.registerSession(client(1), async () => void delivered.push("one"));
    real.registerSession(client(2), async () => void delivered.push("two"));

    const leases = new StreamLeases();
    leases.observe("Alice", 2, "message", T0);
    await leases.fanout("Alice", 1, real.senderFor(1)!, real, T0)(probe("chunk"));
    expect(delivered).toEqual(["two", "one"]);

    real.unregisterSession(2);
    expect(leases.spectator("Alice", 1, real, T0)).toBeUndefined();
  });

  test("a dead issuer does not stop the generation either", async () => {
    const leases = new StreamLeases();
    const sessions = router(1, 2);
    leases.observe("Alice", 2, "message", T0);
    sessions.breaks(1);

    const send = leases.fanout("Alice", 1, sessions.senderFor(1)!, sessions, T0);

    await send(probe("chunk"));
    expect(sessions.names(2)).toEqual(["chunk"]);
  });
});
