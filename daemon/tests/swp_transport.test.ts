import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage";
import { Broadcast } from "../src/swp/broadcast";
import { handleConnection, messageLoop, type ConnectionContext, type PingClock } from "../src/swp/connection";
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

type RecvResultLike =
  | { kind: "message"; msg: ServerMessage }
  | { kind: "lagged"; skipped: number }
  | { kind: "closed" };

interface Subscriptionish {
  recv(): Promise<RecvResultLike>;
  unsubscribe(): void;
}

function harness(
  pingIntervalMs = 3_600_000,
  events?: Subscriptionish,
  pingClock?: PingClock,
): LoopHarness {
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
      ...(pingClock === undefined ? {} : { pingClock }),
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
              previousSegment: null,
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
});
