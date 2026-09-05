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
import { MAX_PRE_AUTH_WIRE_MESSAGE_SIZE, WireReader, type ByteSink } from "../src/swp/framing";
import { SessionRouter, type RoutedMessage, type SessionMeta } from "../src/swp/session";

const OPEN = (): boolean => true;

const SESSION: SessionMeta = {
  clientId: 1,
  sessionId: 1,
  clientType: "tui",
  clientName: "t",
  capabilities: [],
  selectedCharacter: "alice",
  selectedThread: null,
};

const PING: ServerMessage = { type: "ping" };
function chunk(n: number): ServerMessage {
  return { type: "stream_chunk", text: String(n), content_type: "text" };
}

function messageType(line: string): string {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a server message object");
  }
  const type = (parsed as Record<string, unknown>)["type"];
  if (typeof type !== "string") throw new Error("expected a server message type");
  return type;
}

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
          await new Promise<void>((resolve) => {
            wake = resolve;
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
    expect(survived).toEqual(["2", "3", "4", "5"]);
  });

  test("the lag is reported before the frames that survived it", async () => {
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
    const router = new SessionRouter();
    for (const id of [1, 2]) {
      router.registerSession(
        { id, clientType: "tui", clientName: "t", capabilities: [], character: null, thread: null },
        async () => {},
      );
    }
    expect(router.unregisterSession(1).allGone).toBe(false);
    expect(router.unregisterSession(2).allGone).toBe(true);
  });

  test("sending to a session that has already gone is a no-op", async () => {
    const router = new SessionRouter();
    expect(router.sendToSession(99, PING)).resolves.toBeUndefined();
  });

  test("the live character survives a mid-session move", () => {
    const router = new SessionRouter();
    router.registerSession(
      { id: 1, clientType: "tui", clientName: "t", capabilities: [], character: "alice", thread: null },
      async () => {},
    );
    expect(router.setSelectedCharacter(1, "bob")).toBe(true);
    expect(router.characterFor(1)).toBe("bob");
    expect(router.setSelectedCharacter(99, "bob")).toBe(false);
  });
});

describe("serialSink", () => {
  test("concurrent writes never interleave", async () => {
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
    expect(sink.write(new Uint8Array([1]))).rejects.toThrow("boom");
    expect(sink.write(new Uint8Array([2]))).resolves.toBeUndefined();
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
    { id: 1, clientType: "tui", clientName: "t", capabilities: [], character: "alice", thread: null },
    async (m) => {
      await Promise.resolve();
      void m;
    },
  );
  const routed: RoutedMessage[] = [];
  let shutdown!: () => void;
  const shutdownSignal = new Promise<void>((resolve) => {
    shutdown = resolve;
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
  function connect(opts: { slowSink?: boolean } = {}) {
    const { source, send, close } = controlledSource();
    const chars: string[] = [];
    const output: ByteSink = opts.slowSink === true
      ? {
          write: async (b) => {
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
              selectedThread: null,
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

    expect(c.router.sessions()).toEqual([[1, "alice"]]);

    c.send('{"type":"cancel"}\n');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    c.close();
    await c.done;

    expect(c.lines().map((l) => (JSON.parse(l) as ServerMessage).type)).toEqual([
      "hello",
      "history",
    ]);
    expect(c.routed.map((r) => r.kind)).toEqual([
      "engine",
      "session_disconnected",
      "all_clients_disconnected",
    ]);
    expect(c.router.sessions()).toEqual([]);
  });

  test("a direct send and a broadcast racing each other stay on separate lines", async () => {
    const c = connect({ slowSink: true });
    c.send('{"type":"hello","client_type":"tui","client_name":"t"}\n');
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

    for (const line of c.lines()) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
    const types = c.lines().map(messageType);
    expect(types).toContain("command_output");
    expect(types).toContain("ping");
  });

  test("a handshake failure still unregisters and reports nothing routed", async () => {
    const c = connect();
    c.send('{"type":"cancel"}\n');
    await c.done.catch(() => {});
    expect(c.router.sessions()).toEqual([]);
    expect(c.routed).toEqual([]);
    expect(c.lines().map((l) => (JSON.parse(l) as ServerMessage).type)).toEqual(["hello", "error"]);
  });

  test("the small pre-auth limit becomes the normal limit only after authentication", async () => {
    const rejected = connect();
    rejected.send(
      `${JSON.stringify({
        type: "hello",
        client_type: "tui",
        client_name: "x".repeat(MAX_PRE_AUTH_WIRE_MESSAGE_SIZE),
      })}\n`,
    );
    await rejected.done.catch(() => {});
    expect(rejected.router.sessions()).toEqual([]);

    const accepted = connect();
    accepted.send('{"type":"hello","client_type":"tui","client_name":"t"}\n');
    for (let i = 0; i < 2000 && accepted.router.sessions().length === 0; i += 1) {
      await Promise.resolve();
    }
    accepted.send(
      `${JSON.stringify({
        type: "message",
        text: "x".repeat(MAX_PRE_AUTH_WIRE_MESSAGE_SIZE),
        stream: false,
        images: [],
        image_data: [],
      })}\n`,
    );
    for (let i = 0; i < 100 && accepted.routed.length === 0; i += 1) await Promise.resolve();
    accepted.close();
    await accepted.done;
    expect(accepted.routed.some((r) => r.kind === "engine")).toBe(true);
  });
});

describe("message loop", () => {
  test("three consecutive lags disconnect the client", async () => {
    const lag = { kind: "lagged", skipped: 2 } as const;
    const h = harness(3_600_000, scriptedEvents([lag, lag, lag]));
    await messageLoop(h.reader, h.sink, SESSION, h.ctx);
    expect(h.routed).toEqual([]);
    expect(h.frames()).toEqual([]);
  });

  test("exactly MAX_CONSECUTIVE_LAGS is the ceiling, not one more", async () => {
    const lag = { kind: "lagged", skipped: 1 } as const;
    const h = harness(3_600_000, scriptedEvents(Array.from({ length: MAX_CONSECUTIVE_LAGS - 1 }, () => lag)));
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(finished).toBe(false);
    h.shutdown();
    await done;
  });

  test("a successful receive resets the streak", async () => {
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

    expect(finished).toBe(false);
    expect(h.frames()).toEqual([PING]);

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
      { type: "error", code: "protocol_error", message: "Duplicate hello" },
    ]);
    expect(h.routed).toEqual([]);

    h.send('{"type":"cancel"}\n');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(h.routed.map((r) => r.kind)).toEqual(["engine"]);

    h.shutdown();
    await done;
  });

  test("a structurally invalid post-auth frame gets an invalid-request response", async () => {
    const h = harness();
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    h.send('{"type":"message","text":"hello","images":[42]}\n');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(h.frames()).toEqual([
      {
        type: "error",
        code: "invalid_request",
        message: 'Frame field "images" element 1 is not a string',
      },
    ]);
    expect(h.routed).toEqual([]);

    h.send('{"type":"cancel"}\n');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
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
    await new Promise((resolve) => {
      setTimeout(resolve, 55);
    });
    h.shutdown();
    await done;
    const pings = h.frames().filter((f) => f.type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(pings.length).toBeLessThanOrEqual(7);
  });

  test("a stalled loop does not burst missed pings", async () => {
    const h = harness(5);
    const done = messageLoop(h.reader, h.sink, SESSION, h.ctx);
    const until = Date.now() + 60;
    for (;;) {
      if (Date.now() >= until) break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    h.shutdown();
    await done;
    const pings = h.frames().filter((f) => f.type === "ping").length;
    expect(pings).toBeLessThanOrEqual(5);
  });
});
