import { describe, expect, test, afterEach } from "bun:test";
import { type ClientMessage } from "../src/protocol/ClientMessage";
import { WireError, WireReader, MAX_PRE_AUTH_WIRE_MESSAGE_SIZE, type ByteSink } from "../src/swp/framing";
import { type ServerMessage } from "../src/protocol/ServerMessage";
import { Broadcast } from "../src/swp/broadcast";
import { handleConnection, messageLoop, type ConnectionContext, type PingClock } from "../src/swp/connection";
import { SessionRouter, type RoutedMessage, type SessionMeta } from "../src/swp/session";
import { Server } from "../src/swp/server.ts";
import { MAX_TOTAL_ATTACHMENT_BYTES, AdmissionError, admitCapabilities, admitClientMessage, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_CAPABILITIES } from "../src/swp/admission.ts";
import { rejectionOf } from "./support/outcome.ts";

type Read = { ok: ClientMessage } | { eof: true } | { err: string };

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function* byteAtATime(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const b of bytes) yield new Uint8Array([b]);
}

async function readAll(source: AsyncIterable<Uint8Array>, maxMessageSize?: number): Promise<Read[]> {
  const reader = new WireReader(source, maxMessageSize);
  const out: Read[] = [];
  for (;;) {
    try {
      const msg = await reader.readMessage();
      if (msg === null) {
        out.push({ eof: true });
        return out;
      }
      out.push({ ok: msg });
    } catch (e) {
      out.push({ err: e instanceof WireError ? e.message : String(e) });
      return out;
    }
    if (out.length > 16) return out;
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const CANCEL = '{"type":"cancel"}';

const CASES: { name: string; input: Uint8Array; reads: ("cancel" | "eof" | "err")[] }[] = [
  { name: "one frame", input: bytes(`${CANCEL}\n`), reads: ["cancel", "eof"] },
  { name: "two frames in one buffer", input: bytes(`${CANCEL}\n${CANCEL}\n`), reads: ["cancel", "cancel", "eof"] },
  { name: "clean eof, nothing buffered", input: bytes(""), reads: ["eof"] },
  { name: "an unterminated final frame is still parsed", input: bytes(CANCEL), reads: ["cancel", "eof"] },
  { name: "a crlf terminator", input: bytes(`${CANCEL}\r\n`), reads: ["cancel", "eof"] },
  { name: "surrounding spaces are trimmed", input: bytes(`   ${CANCEL}   \n`), reads: ["cancel", "eof"] },
  { name: "a bare newline is an error", input: bytes("\n"), reads: ["err"] },
  { name: "invalid utf-8 is an error", input: Uint8Array.from([0xff, 0xfe, 0x0a]), reads: ["err"] },
  { name: "json that is not a client message is an error", input: bytes('{"type":"nope"}\n'), reads: ["err"] },
  { name: "unknown fields are ignored", input: bytes('{"type":"cancel","extra":1}\n'), reads: ["cancel", "eof"] },
];

describe("framing", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const reads = await readAll(once(c.input));
      expect(reads.map((r) => ("ok" in r ? r.ok.type : "eof" in r ? "eof" : "err"))).toEqual(c.reads);
    });

    test(`${c.name}, one byte per chunk`, async () => {
      expect(await readAll(byteAtATime(c.input))).toEqual(await readAll(once(c.input)));
    });
  }

  test("a message frame keeps its fields and fills its defaults", async () => {
    expect(await readAll(once(bytes('{"type":"message","rid":"r1","text":"hi","stream":true}\n')))).toEqual([
      { ok: { type: "message", rid: "r1", text: "hi", stream: true, images: [], image_data: [] } as ClientMessage },
      { eof: true },
    ]);
  });

  test("a frame over the size limit is refused, terminated or not", async () => {
    const limit = 64;
    const over = "a".repeat(limit);
    expect(await readAll(once(bytes(`${over}\n`)), limit)).toEqual([{ err: "Message exceeds maximum size" }]);
    expect(await readAll(once(bytes(`${over}a`)), limit)).toEqual([{ err: "Message exceeds maximum size" }]);
    const atLimit = await readAll(once(bytes(`${"a".repeat(limit - 1)}\n`)), limit);
    expect(atLimit).toHaveLength(1);
    expect(atLimit[0]).not.toEqual({ err: "Message exceeds maximum size" });
  });
});

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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(characters: string[] = ["ada", "bee"]) {
  const server = new Server({
    addr: "127.0.0.1:0",
    serverName: "shore-test",
    authenticate: () => true,
    handshake: {
      hello: () => Promise.resolve({ characters: characters.map((name) => ({ name })) }),
      history: (selected) =>
        Promise.resolve({
          messages: [],
          previousSegment: null,
          config: { active_model: "test:model" },
          selectedCharacter: selected,
          selectedThread: null,
          revision: 3,
        }),
    },
  });
  const { host, port } = await server.bind();
  const running = server.serve();

  const routed: RoutedMessage[] = [];
  const routing = (async () => {
    for await (const message of server.routes()) if (message.kind !== "session_connected") routed.push(message);
  })();

  cleanups.push(async () => {
    server.stop();
    await Promise.allSettled([running, routing]);
  });

  return { server, routed, addr: `${host}:${port}` };
}

describe("what the peer sends", () => {

  test("a connector cannot bypass aggregate attachment admission", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    const events = peer.events();
    await events.next();
    const data = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 4).toString("base64");

    await peer.send({
      type: "message",
      text: "",
      stream: true,
      images: [],
      image_data: Array.from({ length: 5 }, (_, i) => ({
        filename: `${String(i)}.png`,
        data,
      })),
    });

    const rejection = await events.next();
    if (rejection.done || rejection.value.type !== "error") throw new Error("expected an error frame");
    expect(rejection.value).toMatchObject({ type: "error", code: "invalid_request" });
    expect(rejection.value.message).toContain("total");
    expect(routed).toHaveLength(0);
  });
});

const upload = (filename: string, data: string) => ({ filename, data, mime_type: "image/png" });

const message = <T,>(imageData: T[] = []) => ({
  type: "message" as const,
  text: "hello",
  stream: true,
  images: [],
  image_data: imageData,
});

describe("client request admission", () => {
  test("accepts and preserves a well-formed attachment", () => {
    expect(admitClientMessage(message([upload("shot.png", "AQIDBA==")]))).toEqual(
      message([upload("shot.png", "AQIDBA==")]),
    );
  });

  test("checks attachment objects even when a connector constructed the typed value", () => {
    expect(() => admitClientMessage(message([null]))).toThrow(AdmissionError);
    expect(() => admitClientMessage(message([{ filename: "x.png", data: 42 }]))).toThrow(
      /data.*is not a string/,
    );
    expect(() => admitClientMessage(message([upload("x.png", "not base64")]))).toThrow(
      /not valid base64/,
    );
  });

  test("caps attachment and capability counts", () => {
    expect(() =>
      admitClientMessage(
        message(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => upload(`${String(i)}.png`, ""))),
      ),
    ).toThrow(/maximum/);
    expect(() =>
      admitCapabilities(Array.from({ length: MAX_CAPABILITIES + 1 }, () => "streaming")),
    ).toThrow(/maximum/);
  });

  test("caps each decoded attachment rather than trusting base64 length vaguely", () => {
    const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64");
    const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");

    expect(() => admitClientMessage(message([upload("exact.png", exact)]))).not.toThrow();
    expect(() => admitClientMessage(message([upload("over.png", over)]))).toThrow(
      new RegExp(`maximum is ${String(MAX_ATTACHMENT_BYTES)}`),
    );
  });

  test("caps aggregate decoded bytes across otherwise valid attachments", () => {
    const eachBytes = MAX_TOTAL_ATTACHMENT_BYTES / 4;
    const data = Buffer.alloc(eachBytes).toString("base64");
    const four = Array.from({ length: 4 }, (_, i) => upload(`${String(i)}.png`, data));

    expect(() => admitClientMessage(message(four))).not.toThrow();
    expect(() => admitClientMessage(message([...four, upload("extra.png", "AAAA")]))).toThrow(
      /Attachments total/,
    );
  });
});

describe("wire array decoding", () => {
  async function decode(value: unknown) {
    const line = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    async function* source() {
      yield line;
    }
    return await new WireReader(source()).readMessage();
  }

  for (const [label, value] of [
    ["non-array images", { ...message(), images: "shot.png" }],
    ["non-string image path", { ...message(), images: [42] }],
    ["non-boolean stream flag", { ...message(), stream: "yes" }],
    ["non-object upload", message(["base64"])],
    ["missing upload data", message([{ filename: "shot.png" }])],
    ["non-string MIME type", message([{ filename: "shot.png", data: "AAAA", mime_type: 42 }])],
    ["non-string capability", { type: "hello", client_type: "tui", client_name: "t", capabilities: [42] }],
  ] as const) {
    test(`rejects ${label}`, async () => {
      expect(await rejectionOf(decode(value))).toBeInstanceOf(WireError);
    });
  }
});
