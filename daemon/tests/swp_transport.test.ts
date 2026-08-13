/**
 * Behavioural tests for the parts of the transport a value fixture cannot pin.
 *
 * **These are not fixture-derived.** `swp_parity.test.ts` replays values the
 * Rust actually produced; everything here is a policy read out of
 * `the deleted port` and asserted directly, because the
 * behaviour is a property of a *loop over channels and time* rather than a
 * value some function returned. Driving the Rust to emit "and then it hung up
 * after the third lag" as fixture data would mean building the same harness in
 * Rust and trusting it instead.
 *
 * Each test names the Rust it encodes. They exist because mutation testing
 * found the fixture blind to all of it: the lag ceiling, the streak reset, the
 * broadcast's drop-oldest ring, `AllClientsDisconnected` firing once, and the
 * ordering guarantee that replaced the per-session channel all survived
 * deliberate breakage while the fixture stayed green.
 *
 * # The two mutants that survive on purpose
 *
 * 33 mutations, 31 killed. The two survivors are equivalent rather than
 * uncovered, and are recorded here so the next person does not re-derive them:
 *
 * - **Moving the size check after the bytes are retained.** Same result for
 *   every input; the difference is only whether the reader allocates the frame
 *   before rejecting it. That is a resource property — it is what stops a
 *   hostile client making the daemon allocate 128 MiB to discover a line is
 *   too long — and no value-based assertion can observe it. The ordering is
 *   commented at the call site instead.
 * - **Having `cancel` propagate a rid.** Unreachable: `decodeClientMessage`
 *   drops unknown fields, so a decoded `cancel` never carries one. The
 *   fixture's "cancel carrying a stray rid" case is what makes it unreachable,
 *   so the behaviour is pinned — just not through this mutation.
 */

import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage";
import { Broadcast } from "../src/swp/broadcast";
import {
  MAX_CONSECUTIVE_LAGS,
  handleConnection,
  messageLoop,
  serialSink,
  type ConnectionContext,
} from "../src/swp/connection";
import { WireReader, type ByteSink } from "../src/swp/framing";
import { SessionRouter, type RoutedMessage, type SessionMeta } from "../src/swp/session";

/** Accept any token; authentication is `swp_auth.test.ts`'s subject, not this
 *  file's. `authenticate` is required so that opting out is written down. */
const OPEN = (): boolean => true;


const SESSION: SessionMeta = {
  clientId: 1,
  sessionId: 1,
  clientType: "tui",
  clientName: "t",
  capabilities: [],
  selectedCharacter: "alice",
};

const PING: ServerMessage = { type: "ping" };
function chunk(n: number): ServerMessage {
  return { type: "stream_chunk", text: String(n), content_type: "text" };
}

/** A byte source the test feeds by hand and closes when it chooses. */
function controlledSource(): {
  source: AsyncIterable<Uint8Array>;
  send: (line: string) => void;
  close: () => void;
} {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const bump = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    source: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      },
    },
    send: (line) => {
      queue.push(new TextEncoder().encode(line));
      bump();
    },
    close: () => {
      closed = true;
      bump();
    },
  };
}

function collectingSink(): { sink: ByteSink; frames: () => ServerMessage[] } {
  const parts: string[] = [];
  return {
    sink: { write: (b) => void parts.push(new TextDecoder().decode(b)) },
    frames: () =>
      parts
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as ServerMessage),
  };
}

describe("broadcast — tokio broadcast(256) semantics", () => {
  test("a subscriber past capacity loses the OLDEST frames, not the newest", async () => {
    // `broadcast::channel` is a ring: the writer overwrites the slot the slow
    // reader has not reached. A client that recovers is therefore holding the
    // most recent frames, which is what makes disconnecting only after three
    // consecutive lags safe.
    const bus = new Broadcast(4);
    const sub = bus.subscribe();
    for (let i = 0; i < 6; i += 1) bus.send(chunk(i));

    const lag = await sub.recv();
    expect(lag).toEqual({ kind: "lagged", skipped: 2 });

    const survived: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await sub.recv();
      expect(r.kind).toBe("message");
      survived.push(((r as { msg: ServerMessage }).msg as { text: string }).text);
    }
    // 0 and 1 were overwritten; 2..5 are what is left.
    expect(survived).toEqual(["2", "3", "4", "5"]);
  });

  test("the lag is reported before the frames that survived it", async () => {
    // tokio tells the receiver it fell behind at the point it fell behind. A
    // receiver that drained the ring first would act on stale frames while
    // believing it was current.
    const bus = new Broadcast(2);
    const sub = bus.subscribe();
    bus.send(chunk(0));
    bus.send(chunk(1));
    bus.send(chunk(2));
    expect(await sub.recv()).toEqual({ kind: "lagged", skipped: 1 });
    expect((await sub.recv()).kind).toBe("message");
  });

  test("sending with no subscribers is not an error", () => {
    const bus = new Broadcast();
    expect(() => bus.send(PING)).not.toThrow();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("session router", () => {
  test("AllClientsDisconnected is reported only for the last session", () => {
    // The Rust holds the write lock across `remove` + `is_empty` so two
    // concurrent disconnects cannot both observe an empty map and both cancel
    // generation. Here the same pair runs without an intervening await.
    const router = new SessionRouter();
    for (const id of [1, 2]) {
      router.registerSession(
        { id, clientType: "tui", clientName: "t", capabilities: [], character: null },
        async () => {},
      );
    }
    expect(router.unregisterSession(1).allGone).toBe(false);
    expect(router.unregisterSession(2).allGone).toBe(true);
  });

  test("sending to a session that has already gone is a no-op", async () => {
    // `send_to_session` returns `Ok(())` for an absent sender: a client
    // disconnecting while its command is in flight is ordinary, and throwing
    // here would turn it into a handler error.
    const router = new SessionRouter();
    await expect(router.sendToSession(99, PING)).resolves.toBeUndefined();
  });

  test("the live character survives a mid-session move", () => {
    const router = new SessionRouter();
    router.registerSession(
      { id: 1, clientType: "tui", clientName: "t", capabilities: [], character: "alice" },
      async () => {},
    );
    expect(router.setSelectedCharacter(1, "bob")).toBe(true);
    expect(router.characterFor(1)).toBe("bob");
    expect(router.setSelectedCharacter(99, "bob")).toBe(false);
  });
});

describe("serialSink", () => {
  test("concurrent writes never interleave", async () => {
    // This is what replaced the per-session mpsc. Without it a broadcast frame
    // and a direct frame written at the same instant can splice their bytes
    // into a line no client can parse.
    const out: string[] = [];
    const slow: ByteSink = {
      write: async (b) => {
        const text = new TextDecoder().decode(b);
        for (const ch of text) {
          await Promise.resolve();
          out.push(ch);
        }
      },
    };
    const sink = serialSink(slow);
    await Promise.all([sink.write(new TextEncoder().encode("AAAA")), sink.write(new TextEncoder().encode("BBBB"))]);
    expect(out.join("")).toBe("AAAABBBB");
  });

  test("a failed write does not wedge the chain", async () => {
    let first = true;
    const flaky: ByteSink = {
      write: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve();
      },
    };
    const sink = serialSink(flaky);
    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow("boom");
    await expect(sink.write(new Uint8Array([2]))).resolves.toBeUndefined();
  });
});

interface LoopHarness {
  readonly ctx: ConnectionContext;
  readonly reader: WireReader;
  readonly sink: ByteSink;
  readonly frames: () => ServerMessage[];
  readonly routed: RoutedMessage[];
  readonly bus: Broadcast;
  readonly send: (line: string) => void;
  readonly close: () => void;
  readonly shutdown: () => void;
}

/**
 * An event source that hands out a scripted sequence, then blocks.
 *
 * The lag policy is about *consecutive* lags, and driving that through a real
 * ring means racing the loop: after a lag the surviving frames are still
 * queued, they deliver, and the streak resets — which is correct behaviour and
 * exactly what makes the ceiling hard to reach by accident. Scripting the
 * sequence tests the policy rather than the scheduler.
 */
function scriptedEvents(script: readonly RecvResultLike[]): Subscriptionish {
  let at = 0;
  return {
    recv: () => {
      const next = script[at];
      at += 1;
      return next === undefined ? new Promise<never>(() => {}) : Promise.resolve(next);
    },
    unsubscribe: () => {},
  };
}

type RecvResultLike =
  | { kind: "message"; msg: ServerMessage }
  | { kind: "lagged"; skipped: number }
  | { kind: "closed" };

interface Subscriptionish {
  recv(): Promise<RecvResultLike>;
  unsubscribe(): void;
}

function harness(pingIntervalMs = 3_600_000, events?: Subscriptionish): LoopHarness {
  const { source, send, close } = controlledSource();
  const { sink, frames } = collectingSink();
  const bus = new Broadcast(4);
  const router = new SessionRouter();
  router.registerSession(
    { id: 1, clientType: "tui", clientName: "t", capabilities: [], character: "alice" },
    async (m) => {
      await Promise.resolve();
      void m;
    },
  );
  const routed: RoutedMessage[] = [];
  let shutdown!: () => void;
  const shutdownSignal = new Promise<void>((r) => {
    shutdown = r;
  });

  return {
    ctx: {
      clientId: 1,
      serverName: "shore-test",
      router,
      events: (events ?? bus.subscribe()) as never,
      handshake: null as never,
      authenticate: OPEN,
      route: async (m) => void routed.push(m),
      shutdown: shutdownSignal,
      pingIntervalMs,
    },
    reader: new WireReader(source),
    sink,
    frames,
    routed,
    bus,
    send,
    close,
    shutdown,
  };
}

describe("handleConnection", () => {
  /** Drive a whole connection over an in-memory duplex. */
  function connect(opts: { slowSink?: boolean } = {}) {
    const { source, send, close } = controlledSource();
    const chars: string[] = [];
    const output: ByteSink = opts.slowSink === true
      ? {
          write: async (b) => {
            // One character per microtask: any unserialized concurrent write
            // splices its bytes into the middle of another line.
            for (const ch of new TextDecoder().decode(b)) {
              await Promise.resolve();
              chars.push(ch);
            }
          },
        }
      : { write: (b) => void chars.push(new TextDecoder().decode(b)) };

    const router = new SessionRouter();
    const bus = new Broadcast(16);
    const routed: RoutedMessage[] = [];
    const done = handleConnection(
      { input: source, output },
      {
        clientId: 1,
        serverName: "shore-test",
        router,
        events: bus.subscribe(),
        authenticate: OPEN,
        handshake: {
          hello: () => Promise.resolve({ characters: [{ name: "alice" }] }),
          history: (selected) =>
            Promise.resolve({
              messages: [],
              activeStart: 0,
              config: {},
              selectedCharacter: selected,
              revision: 1,
            }),
        },
        route: async (m) => void routed.push(m),
        shutdown: new Promise<void>(() => {}),
        pingIntervalMs: 3_600_000,
      },
    );
    const lines = () => chars.join("").split("\n").filter((l) => l.length > 0);
    return { done, send, close, router, bus, routed, lines };
  }

  test("handshake, route, disconnect, and report the last client gone", async () => {
    const c = connect();
    c.send('{"type":"hello","client_type":"tui","client_name":"t"}\n');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // Registered with the character the sole-character default resolved to.
    expect(c.router.sessions()).toEqual([[1, "alice"]]);

    c.send('{"type":"cancel"}\n');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    c.close();
    await c.done;

    expect(c.lines().map((l) => (JSON.parse(l) as ServerMessage).type)).toEqual([
      "hello",
      "history",
    ]);
    expect(c.routed.map((r) => r.kind)).toEqual(["engine", "all_clients_disconnected"]);
    // The session is gone from the router, not merely marked dead.
    expect(c.router.sessions()).toEqual([]);
  });

  test("a direct send and a broadcast racing each other stay on separate lines", async () => {
    // The per-session mpsc is gone; `serialSink` is what keeps its ordering
    // guarantee. Without it these two writes interleave and neither line parses.
    const c = connect({ slowSink: true });
    c.send('{"type":"hello","client_type":"tui","client_name":"t"}\n');
    // The slow sink spends a microtask per character, so "wait a few turns" is
    // not enough — wait for the session to actually appear, or `sendToSession`
    // correctly no-ops and the test proves nothing.
    for (let i = 0; i < 2000 && c.router.sessions().length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(c.router.sessions()).toHaveLength(1);

    await Promise.all([
      c.router.sendToSession(1, { type: "command_output", name: "status", data: { ok: true } }),
      Promise.resolve().then(() => c.bus.send(PING)),
    ]);
    for (let i = 0; i < 80; i += 1) await Promise.resolve();
    c.close();
    await c.done;

    // Every line is complete JSON — the real assertion. A spliced write throws.
    for (const line of c.lines()) expect(() => JSON.parse(line)).not.toThrow();
    const types = c.lines().map((l) => (JSON.parse(l) as ServerMessage).type);
    expect(types).toContain("command_output");
    expect(types).toContain("ping");
  });

  test("a handshake failure still unregisters and reports nothing routed", async () => {
    const c = connect();
    c.send('{"type":"cancel"}\n'); // not a hello
    await c.done.catch(() => {});
    expect(c.router.sessions()).toEqual([]);
    // No session was ever registered, so no AllClientsDisconnected either.
    expect(c.routed).toEqual([]);
    expect(c.lines().map((l) => (JSON.parse(l) as ServerMessage).type)).toEqual(["hello", "error"]);
  });
});

describe("message loop", () => {
  test("three consecutive lags disconnect the client", async () => {
    const lag = { kind: "lagged", skipped: 2 } as const;
    const h = harness(3_600_000, scriptedEvents([lag, lag, lag]));
    // Returns rather than hanging: the loop gave up on the client itself,
    // without shutdown and without the client closing.
    await messageLoop(h.reader, h.sink, SESSION, h.ctx);
    expect(h.routed).toEqual([]);
    expect(h.frames()).toEqual([]);
  });

  test("exactly MAX_CONSECUTIVE_LAGS is the ceiling, not one more", async () => {
    const lag = { kind: "lagged", skipped: 1 } as const;
    const h = harness(3_600_000, scriptedEvents(Array(MAX_CONSECUTIVE_LAGS - 1).fill(lag)));
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(finished).toBe(false); // two lags is survivable
    h.shutdown();
    await done;
  });

  test("a successful receive resets the streak", async () => {
    // The policy targets a client that is persistently behind. Two lags either
    // side of a clean delivery must not add up to a disconnect.
    const lag = { kind: "lagged", skipped: 1 } as const;
    const h = harness(
      3_600_000,
      scriptedEvents([lag, lag, { kind: "message", msg: PING }, lag, lag]),
    );
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    for (let i = 0; i < 40; i += 1) await Promise.resolve();

    expect(finished).toBe(false); // four lags total, never three in a row
    expect(h.frames()).toEqual([PING]); // and the clean frame was delivered

    h.shutdown();
    await done;
  });

  test("a closed event channel ends the loop", async () => {
    const h = harness(3_600_000, scriptedEvents([{ kind: "closed" }]));
    await messageLoop(h.reader, h.sink, SESSION, h.ctx);
  });

  test("a clean EOF ends the loop without routing anything", async () => {
    const h = harness();
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    h.close();
    await done;
    expect(h.routed).toEqual([]);
  });

  test("shutdown ends the loop", async () => {
    const h = harness();
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    h.shutdown();
    await done;
  });

  test("a duplicate hello is answered and the connection survives", async () => {
    const h = harness();
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    h.send('{"type":"hello","client_type":"tui","client_name":"t"}\n');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(h.frames()).toEqual([
      { type: "error", code: "protocol_error", message: "Duplicate hello" } as ServerMessage,
    ]);
    expect(h.routed).toEqual([]);

    // Still reading: a protocol error on one frame does not drop the client.
    h.send('{"type":"cancel"}\n');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(h.routed.map((r) => r.kind)).toEqual(["engine"]);

    h.shutdown();
    await done;
  });

  test("a broadcast frame reaches a registered session", async () => {
    const h = harness();
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    h.bus.send(PING);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(h.frames()).toEqual([PING]);
    h.shutdown();
    await done;
  });

  test("pings fire on the interval", async () => {
    const h = harness(10);
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    await new Promise((r) => setTimeout(r, 55));
    h.shutdown();
    await done;
    const pings = h.frames().filter((f) => f.type === "ping");
    // Roughly five in 55ms at a 10ms cadence; the point is that it repeats and
    // does not burst, so a tolerant range rather than an exact count.
    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(pings.length).toBeLessThanOrEqual(7);
  });

  test("a stalled loop does not burst missed pings", async () => {
    // `MissedTickBehavior::Skip`: after a stall the schedule advances to the
    // next deadline rather than firing once per missed period.
    const h = harness(5);
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    // Block the loop's turn for many periods.
    const until = Date.now() + 60;
    while (Date.now() < until) {
      /* busy */
    }
    await new Promise((r) => setTimeout(r, 10));
    h.shutdown();
    await done;
    const pings = h.frames().filter((f) => f.type === "ping").length;
    expect(pings).toBeLessThanOrEqual(5);
  });
});
