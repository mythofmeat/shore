import { afterEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";

import { BrowserConnection, InterruptedRequestError, type BrowserConnectionOptions, type BrowserRequest, type ConnectionUpdate } from "../src/browser/connection.ts";
import type { WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";

const ORIGIN = "http://shore.test:7340";
const HOUR = 60 * 60 * 1000;
const SESSION: WebSessionInfo = { contract: "c1", protocol: 2, expires_at: 0, max_message_bytes: 4096, max_pending_requests: 2 };
const HELLO = { type: "hello", v: 1, server_name: "shore", characters: [] };
const HISTORY = { type: "history", messages: [], config: {}, revision: 1, selected_character: "ada", selected_thread: "story" };
const MESSAGE: BrowserRequest = { type: "message", text: "hi", stream: true, images: [] };

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

interface SocketEvent { data?: unknown; code?: number; reason?: string }

class FakeSocket {
  readonly raw: string[] = [];
  readonly #listeners = new Map<string, ((event: SocketEvent) => void)[]>();
  bufferedAmount = 0;
  closed = false;
  broken = false;

  constructor(readonly url: string, readonly protocol: string) {}

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(text: string): void {
    if (this.broken) throw new Error("broken pipe");
    this.raw.push(text);
  }

  close(): void { this.closed = true; }
  fire(type: string, event: SocketEvent = {}): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  receive(frame: unknown): void { this.fire("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }); }
  frames(): unknown[] { return this.raw.map((text) => JSON.parse(text) as unknown); }
}

const session = (overrides: Partial<WebSessionInfo> = {}): Response => Response.json({ ...SESSION, expires_at: Date.now() + HOUR, ...overrides });
const problem = (status: number, message?: string): Response => Response.json(message === undefined ? { nope: true } : { code: "forbidden", message }, { status });

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function rig(options: Partial<BrowserConnectionOptions> = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  const replies = new Map<string, ((init: RequestInit) => Response | Promise<Response>)[]>();
  const sockets: FakeSocket[] = [];
  const connection = new BrowserConnection({
    origin: ORIGIN, contract: "c1", protocol: 2,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      const next = replies.get(path)?.shift();
      if (next !== undefined) return await next(init);
      return path === "/api/session" ? session() : Response.json({});
    },
    socket: (url, subprotocol) => {
      const socket = new FakeSocket(url, subprotocol);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...options,
  });
  const updates: ConnectionUpdate[] = [];
  connection.subscribe((update) => { updates.push(update); });
  const answer = (path: string, ...next: ((init: RequestInit) => Response | Promise<Response>)[]) => { replies.set(path, [...(replies.get(path) ?? []), ...next]); };
  const statuses = () => updates.flatMap((update) => update.kind === "status" ? [`${update.status}: ${update.detail}`] : []);
  return { connection, calls, sockets, updates, answer, statuses };
}

async function ready(options: Partial<BrowserConnectionOptions> = {}) {
  const link = rig(options);
  link.connection.connect();
  await settle();
  const socket = link.sockets.at(-1);
  if (socket === undefined) throw new Error("no socket opened");
  socket.fire("open");
  socket.receive(HELLO);
  socket.receive(HISTORY);
  return { ...link, socket };
}

describe("connecting", () => {
  test("checks the session, opens the socket for its contract, says hello for the chosen conversation, and is ready once it arrives", async () => {
    const link = rig({ character: "ada", thread: "story" });
    expect(link.connection.status).toBe("idle");
    expect(link.connection.selection).toEqual({ character: "ada", thread: "story", messageRevision: 0, snapshotRevision: 0 });
    link.connection.connect();
    link.connection.connect();
    expect(link.connection.status).toBe("connecting");
    await settle();
    expect(link.calls.map((call) => call.path)).toEqual(["/api/session"]);
    const init = link.calls[0]?.init ?? {};
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(["cache", "credentials", "method", "redirect", "signal"]);
    const socket = link.sockets[0];
    expect([socket?.url, socket?.protocol]).toEqual(["ws://shore.test:7340/api/swp", "shore-web-2.c1"]);
    socket?.fire("open");
    expect(socket?.frames()).toEqual([{ type: "hello", client_type: "web", client_name: "shore-browser", capabilities: ["streaming", "history-deltas", "request-lifecycle", "multimodal-tool-results"], character: "ada", thread: "story" }]);
    socket?.receive(HELLO);
    expect(link.connection.status).toBe("connecting");
    socket?.receive(HISTORY);
    expect(link.connection.status).toBe("ready");
    expect(link.connection.selection).toEqual({ character: "ada", thread: "story", messageRevision: 0, snapshotRevision: 1 });
    expect(link.updates.map((update) => update.kind === "frame" ? update.message.type : update.kind === "status" ? update.status : update.kind)).toEqual(["connecting", "hello", "history", "ready"]);
    expect(link.connection.generation).toBe(1);
  });

  test("without a chosen conversation says hello for none, and a secure page uses a secure socket", async () => {
    const link = rig({ origin: "https://shore.test" });
    expect(link.connection.selection).toEqual({ character: null, thread: null, messageRevision: 0, snapshotRevision: 0 });
    link.connection.connect();
    await settle();
    link.sockets[0]?.fire("open");
    expect(link.sockets[0]?.url).toBe("wss://shore.test/api/swp");
    expect(link.sockets[0]?.frames()).toMatchObject([{ character: null, thread: null }]);
  });

  test("needs an exact HTTP(S) origin", () => {
    for (const origin of ["http://shore.test:7340/", "http://shore.test/path", "ftp://shore.test", "ws://shore.test"]) {
      expect(() => new BrowserConnection({ origin, contract: "c1", protocol: 2 }), origin).toThrow("Browser connection requires an exact HTTP(S) origin");
    }
    expect(() => new BrowserConnection({ origin: "https://shore.test", contract: "c1", protocol: 2 })).not.toThrow();
  });

  test("uses the page's own fetch and sockets when it is given none", async () => {
    const fetching = spyOn(globalThis, "fetch").mockImplementation((async () => await Promise.resolve(session())) as unknown as typeof fetch);
    const original = globalThis.WebSocket;
    const opened: FakeSocket[] = [];
    globalThis.WebSocket = class extends FakeSocket { constructor(url: string, protocol: string) { super(url, protocol); opened.push(this); } } as unknown as typeof WebSocket;
    try {
      const connection = new BrowserConnection({ origin: ORIGIN, contract: "c1", protocol: 2 });
      connection.connect();
      await settle();
      expect(fetching.mock.calls[0]?.[0]).toBe(`${ORIGIN}/api/session`);
      expect(opened.map((socket) => [socket.url, socket.protocol])).toEqual([["ws://shore.test:7340/api/swp", "shore-web-2.c1"]]);
      connection.stop();
    } finally {
      globalThis.WebSocket = original;
      fetching.mockRestore();
    }
  });

  test("a session check that is refused says why, and only an unexplained failure keeps trying", async () => {
    const cases: [Response, string][] = [
      [problem(401, "Sign in again"), "signed_out: Sign in again"],
      [problem(409, "Old page"), "reload_required: Old page"],
      [problem(403, "Wrong origin"), "error: Wrong origin"],
      [problem(503), "reconnecting: Could not check the browser session"],
    ];
    for (const [reply, status] of cases) {
      const link = rig({ retryDelayMs: HOUR });
      link.answer("/api/session", () => reply);
      link.connection.connect();
      await settle();
      expect(link.statuses().at(-1), status).toBe(status);
      expect(link.sockets).toHaveLength(0);
      link.connection.connect();
      await settle();
      expect(link.calls.length, `${status} stops trying, so connecting again starts over`).toBe(status.startsWith("reconnecting") ? 1 : 2);
      link.connection.stop();
    }
  });

  test("a session for another build, or one that makes no sense, stops with a reason", async () => {
    const cases: [Response, string][] = [
      [Response.json({ contract: "c1" }), "error: The daemon returned an invalid session contract"],
      [session({ contract: "c2" }), "reload_required: Shore was upgraded. Reload this page to continue."],
      [session({ protocol: 3 }), "reload_required: Shore was upgraded. Reload this page to continue."],
    ];
    for (const [reply, status] of cases) {
      const link = rig();
      link.answer("/api/session", () => reply);
      link.connection.connect();
      await settle();
      expect(link.statuses().at(-1)).toBe(status);
      expect(link.sockets).toHaveLength(0);
    }
  });
});

describe("staying connected", () => {
  test("a failing session check retries after a delay that doubles to a cap", async () => {
    jest.useFakeTimers();
    for (const [base, delays] of [[100, [100, 200, 400, 800, 1600, 3200, 3200]], [1000, [1000, 2000, 4000, 8000, 10_000, 10_000]]] as const) {
      const link = rig({ retryDelayMs: base });
      link.answer("/api/session", ...Array.from({ length: 10 }, () => async () => await Promise.reject(new Error("offline"))));
      link.connection.connect();
      await settle();
      expect(link.statuses()).toEqual(["connecting: ", "reconnecting: offline"]);
      for (const delay of delays) {
        const before = link.calls.length;
        jest.advanceTimersByTime(delay - 1);
        await settle();
        expect(link.calls.length, `${String(base)}: not before ${String(delay)}`).toBe(before);
        jest.advanceTimersByTime(1);
        await settle();
        expect(link.calls.length, `${String(base)}: after ${String(delay)}`).toBe(before + 1);
      }
      expect(link.statuses().at(-2)).toBe("reconnecting: ");
      link.connection.stop();
    }
  });

  test("retries after half a second unless told otherwise, and a failure that is not an error still says it could not connect", async () => {
    jest.useFakeTimers();
    const link = rig();
    link.answer("/api/session", async () => await Promise.reject(new TypeError("refused")), async () => { await Promise.resolve(); throw "refused"; });
    link.connection.connect();
    await settle();
    jest.advanceTimersByTime(499);
    await settle();
    expect(link.calls).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(link.calls).toHaveLength(2);
    expect(link.statuses().slice(-1)).toEqual(["reconnecting: Could not connect to the daemon"]);
    link.connection.stop();
  });

  test("a handshake that does not finish in time is given up and tried again", async () => {
    jest.useFakeTimers();
    for (const [timeout, options] of [[10_000, {}], [1000, { handshakeTimeoutMs: 1000 }]] as const) {
      const link = rig({ retryDelayMs: HOUR, ...options });
      link.connection.connect();
      await settle();
      link.sockets[0]?.fire("open");
      link.sockets[0]?.receive(HELLO);
      jest.advanceTimersByTime(timeout - 1);
      expect(link.connection.status).toBe("connecting");
      jest.advanceTimersByTime(1);
      expect(link.statuses().at(-1)).toBe("reconnecting: Connection setup timed out");
      expect(link.sockets[0]?.closed).toBe(true);
      link.connection.stop();
    }
    const link = await ready();
    jest.advanceTimersByTime(20_000);
    expect(link.connection.status, "a finished handshake has no deadline").toBe("ready");
  });

  test("a socket that closes or fails says how, and one that sends bytes is refused", async () => {
    const closes: [SocketEvent, string][] = [
      [{ code: 4001, reason: "Signed out elsewhere" }, "signed_out: Signed out elsewhere"],
      [{ code: 1008, reason: "Policy" }, "error: Policy"],
      [{ code: 1009, reason: "Too big" }, "error: Too big"],
      [{ code: 1006, reason: "" }, "reconnecting: Connection interrupted; refreshing state"],
    ];
    for (const [event, status] of closes) {
      const link = await ready({ retryDelayMs: HOUR });
      link.socket.fire("close", event);
      expect(link.statuses().at(-1)).toBe(status);
      link.connection.stop();
    }
    const failed = await ready({ retryDelayMs: HOUR });
    failed.socket.fire("error");
    expect(failed.statuses().at(-1)).toBe("reconnecting: Could not connect to the daemon");
    failed.connection.stop();
    const binary = await ready();
    binary.socket.fire("message", { data: new ArrayBuffer(2) });
    expect(binary.statuses().at(-1)).toBe("error: The daemon sent an unsupported binary frame");
  });

  test("an old socket's events are ignored once the connection has moved on", async () => {
    jest.useFakeTimers();
    const link = await ready();
    const old = link.socket;
    link.connection.reconnect();
    expect(old.closed).toBe(true);
    expect(link.statuses().at(-1)).toBe("reconnecting: Refreshing conversation state");
    jest.advanceTimersByTime(0);
    await settle();
    expect(link.sockets).toHaveLength(2);
    expect(link.statuses().at(-1), "a refresh is not a retry").toBe("connecting: ");
    const count = link.updates.length;
    old.fire("open");
    old.receive(HELLO);
    old.fire("message", { data: new ArrayBuffer(1) });
    old.fire("close", { code: 4001, reason: "late" });
    old.fire("error");
    expect(old.raw).toHaveLength(1);
    expect(link.updates).toHaveLength(count);
    link.connection.stop();
  });

  test("the session is renewed halfway to its expiry, kept between a second and twelve hours, and retried a minute after a failure", async () => {
    jest.useFakeTimers();
    setSystemTime(new Date("2026-11-10T00:00:00Z"));
    const now = Date.now();
    const link = rig();
    link.answer("/api/session", () => session({ expires_at: now + 10_000 }), () => session({ expires_at: now + 20 * 24 * HOUR }), () => problem(500), async () => await Promise.reject(new Error("offline")), () => Response.json({ contract: "c1" }), () => new Response("not json"), () => session({ expires_at: now - 5000 }));
    const timeouts = spyOn(AbortSignal, "timeout");
    link.connection.connect();
    await settle();
    link.sockets[0]?.fire("open");
    link.sockets[0]?.receive(HELLO);
    link.sockets[0]?.receive(HISTORY);
    const renewals = () => link.calls.length - 1;
    jest.advanceTimersByTime(4999);
    await settle();
    expect(renewals()).toBe(0);
    jest.advanceTimersByTime(1);
    await settle();
    expect(renewals()).toBe(1);
    expect(link.calls[1]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(timeouts.mock.calls).toEqual([[10_000]]);
    timeouts.mockRestore();
    jest.advanceTimersByTime(12 * HOUR - 1);
    await settle();
    expect(renewals()).toBe(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(renewals()).toBe(2);
    for (const renewal of [3, 4, 5, 6]) {
      jest.advanceTimersByTime(59_999);
      await settle();
      expect(renewals(), "a failed renewal waits a minute").toBe(renewal - 1);
      jest.advanceTimersByTime(1);
      await settle();
      expect(renewals()).toBe(renewal);
    }
    jest.advanceTimersByTime(999);
    await settle();
    expect(renewals()).toBe(6);
    jest.advanceTimersByTime(1);
    await settle();
    expect(renewals(), "an expired session is renewed a second later").toBe(7);
    expect(link.connection.status).toBe("ready");
    link.connection.stop();
    jest.advanceTimersByTime(24 * HOUR);
    await settle();
    expect(renewals()).toBe(7);
  });

  test("giving up resets the retry count, so connecting again starts afresh", async () => {
    jest.useFakeTimers();
    const link = rig({ retryDelayMs: 100 });
    link.answer("/api/session", async () => await Promise.reject(new Error("offline")), async () => await Promise.reject(new Error("offline")), () => problem(401, "Sign in"));
    link.connection.connect();
    await settle();
    jest.advanceTimersByTime(100);
    await settle();
    jest.advanceTimersByTime(200);
    await settle();
    expect(link.statuses().at(-1)).toBe("signed_out: Sign in");
    link.connection.connect();
    expect(link.statuses().at(-1)).toBe("connecting: ");
    link.connection.stop();
  });

  test("a connection that succeeds starts its retries from the shortest delay again", async () => {
    jest.useFakeTimers();
    const link = rig({ retryDelayMs: 100 });
    link.answer("/api/session", async () => await Promise.reject(new Error("offline")), async () => await Promise.reject(new Error("offline")));
    link.connection.connect();
    await settle();
    jest.advanceTimersByTime(100);
    await settle();
    jest.advanceTimersByTime(200);
    await settle();
    const socket = link.sockets[0];
    socket?.fire("open");
    socket?.receive(HELLO);
    socket?.receive(HISTORY);
    expect(link.connection.status).toBe("ready");
    socket?.fire("close", { code: 1006, reason: "" });
    const before = link.calls.length;
    jest.advanceTimersByTime(99);
    await settle();
    expect(link.calls).toHaveLength(before);
    jest.advanceTimersByTime(1);
    await settle();
    expect(link.calls).toHaveLength(before + 1);
    link.connection.stop();
  });

  test("a listener that stops the connection as the conversation arrives keeps it stopped", async () => {
    const link = rig();
    link.connection.subscribe((update) => { if (update.kind === "frame" && update.message.type === "history") link.connection.stop(); });
    link.connection.connect();
    await settle();
    link.sockets[0]?.fire("open");
    link.sockets[0]?.receive(HELLO);
    link.sockets[0]?.receive(HISTORY);
    expect(link.connection.status).toBe("stopped");
  });

  test("refreshing twice in a row opens one new connection", async () => {
    jest.useFakeTimers();
    const link = await ready();
    link.connection.reconnect();
    link.connection.reconnect();
    jest.advanceTimersByTime(0);
    await settle();
    expect(link.sockets).toHaveLength(2);
    expect(link.calls.filter((call) => call.path === "/api/session")).toHaveLength(2);
    link.connection.stop();
  });

  test("stopping aborts a session check under way, and its late answer changes nothing", async () => {
    let release: (response: Response) => void = () => {};
    const link = rig();
    link.answer("/api/session", async () => await new Promise<Response>((resolve) => { release = resolve; }));
    link.connection.connect();
    await settle();
    link.connection.stop();
    expect(link.calls[0]?.init.signal?.aborted).toBe(true);
    release(session());
    await settle();
    expect(link.sockets).toHaveLength(0);
    expect(link.statuses().at(-1)).toBe("stopped: Connection stopped");

    const failing = rig();
    failing.answer("/api/session", async (init) => await new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }); }));
    failing.connection.connect();
    await settle();
    failing.connection.stop();
    await settle();
    expect(failing.statuses().at(-1)).toBe("stopped: Connection stopped");
  });

  test("says what it is doing, to every listener until it leaves", () => {
    const link = rig();
    let heard = 0;
    const leave = link.connection.subscribe(() => { heard += 1; });
    link.connection.stop();
    expect(link.connection.detail).toBe("Connection stopped");
    expect(heard).toBe(1);
    leave();
    link.connection.stop();
    expect(heard).toBe(1);
    expect(link.statuses()).toHaveLength(2);
  });

  test("a renewal that comes back after the connection moved on changes nothing", async () => {
    jest.useFakeTimers();
    setSystemTime(new Date("2026-11-10T00:00:00Z"));
    let release: (response: Response) => void = () => {};
    const link = rig();
    link.answer("/api/session", () => session({ expires_at: Date.now() + 10_000 }), async () => await new Promise<Response>((resolve) => { release = resolve; }));
    link.connection.connect();
    await settle();
    jest.advanceTimersByTime(5000);
    await settle();
    expect(link.calls).toHaveLength(2);
    link.connection.stop();
    release(problem(500));
    await settle();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(link.calls).toHaveLength(2);
  });
});

describe("frames from the daemon", () => {
  test("must start with one hello, then a whole conversation", async () => {
    const cases: [unknown[], string][] = [
      [[HISTORY], "error: Expected the daemon hello before events"],
      [[HELLO, HELLO], "error: Unexpected Shore handshake"],
      [[{ ...HELLO, v: 2 }], "error: Unexpected Shore handshake"],
      [[HELLO, { ...HISTORY, delta: { base_revision: 0, after: null } }], "error: Expected a full conversation after connecting"],
      [["not json"], "error: Server sent invalid JSON"],
      [[{ type: "history" }], "error: Server sent an invalid history event"],
    ];
    for (const [frames, status] of cases) {
      const link = rig();
      link.connection.connect();
      await settle();
      for (const frame of frames) link.sockets[0]?.receive(frame);
      expect(link.statuses().at(-1), status).toBe(status);
    }
  });

  test("passes on frames it does not know yet, and a shutdown before reconnecting", async () => {
    const link = await ready({ retryDelayMs: HOUR });
    link.socket.receive({ type: "from_the_future", x: 1 });
    expect(link.updates.at(-1)).toEqual({ kind: "future", message: { type: "from_the_future", x: 1 } });
    link.socket.receive({ type: "shutdown" });
    expect(link.updates.slice(-2)).toEqual([{ kind: "frame", message: { type: "shutdown" } }, { kind: "status", status: "reconnecting", detail: "Daemon is restarting" }]);
    link.connection.stop();
  });

  test("drops stale conversation updates and refreshes at once when one was missed", async () => {
    jest.useFakeTimers();
    const link = await ready({ retryDelayMs: HOUR });
    const count = link.updates.length;
    link.socket.receive({ ...HISTORY, revision: 1, delta: { base_revision: 1, after: null } });
    expect(link.updates).toHaveLength(count);
    link.socket.receive({ ...HISTORY, revision: 3, delta: { base_revision: 2, after: null } });
    expect(link.statuses().at(-1)).toBe("reconnecting: Conversation updates were missed; refreshing state");
    jest.advanceTimersByTime(0);
    await settle();
    expect(link.sockets).toHaveLength(2);
    link.connection.stop();
  });
});

describe("sending requests", () => {
  test("waits for the connection, then sends each with its id until the daemon says it finished", async () => {
    const early = rig();
    expect(() => early.connection.submit(MESSAGE)).toThrow("Wait for Shore to reconnect before sending");
    expect(() => early.connection.cancel()).toThrow("Cancellation needs an active connection");
    const link = await ready();
    const sent = link.connection.submit(MESSAGE, "r_1");
    expect(sent.rid).toBe("r_1");
    expect(link.socket.frames().at(-1)).toEqual({ ...MESSAGE, rid: "r_1" });
    expect(link.connection.pendingCount).toBe(1);
    link.socket.receive({ type: "request_finished", rid: "r_1", outcome: "completed" });
    const finished: unknown = await sent.finished;
    expect(finished).toEqual({ type: "request_finished", rid: "r_1", outcome: "completed" });
    expect(link.connection.pendingCount).toBe(0);
    expect(link.updates.at(-1)).toEqual({ kind: "frame", message: { type: "request_finished", rid: "r_1", outcome: "completed" } });
    link.socket.receive({ type: "request_finished", rid: "someone-else", outcome: "completed" });
    expect(link.updates.at(-1)).toMatchObject({ kind: "frame" });
    expect(link.connection.submit(MESSAGE).rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    link.connection.cancel();
    expect(link.socket.frames().at(-1)).toEqual({ type: "cancel" });
  });

  test("nothing can be sent or cancelled while the handshake is still under way", async () => {
    const link = rig();
    link.connection.connect();
    await settle();
    link.sockets[0]?.fire("open");
    link.sockets[0]?.receive(HELLO);
    expect(() => link.connection.submit(MESSAGE)).toThrow("Wait for Shore to reconnect before sending");
    expect(() => link.connection.cancel()).toThrow("Cancellation needs an active connection");
  });

  test("refuses a request that is malformed, already in flight, or one too many", async () => {
    const link = await ready();
    expect(() => link.connection.submit({ type: "message", text: 3 } as unknown as BrowserRequest)).toThrow("Invalid conversation request fields");
    link.connection.submit(MESSAGE, "r_1");
    expect(() => link.connection.submit(MESSAGE, "r_1")).toThrow("This request is already in flight");
    link.connection.submit(MESSAGE, "r_2");
    expect(() => link.connection.submit(MESSAGE, "r_3")).toThrow("Wait for a pending request to finish");
    const many = await ready();
    many.answer("/api/session", () => session({ max_pending_requests: 100, max_message_bytes: HOUR }));
    many.connection.reconnect();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await settle();
    many.socket.fire("open");
    const socket = many.sockets.at(-1);
    socket?.fire("open");
    socket?.receive(HELLO);
    socket?.receive(HISTORY);
    for (let index = 0; index < 32; index += 1) many.connection.submit(MESSAGE, `r_${String(index)}`);
    expect(() => many.connection.submit(MESSAGE, "r_32"), "never more than 32 at once").toThrow("Wait for a pending request to finish");
  });

  test("keeps every request within the size the daemon accepts, counting what is buffered and what is still pending", async () => {
    const size = (rid: string, text: string) => new TextEncoder().encode(JSON.stringify({ ...MESSAGE, text, rid })).byteLength;
    const fill = (rid: string, bytes: number) => "x".repeat(bytes - size(rid, ""));
    const link = await ready();
    expect(() => link.connection.submit({ ...MESSAGE, text: fill("r_1", 4097) }, "r_1")).toThrow("Request exceeds the browser connection limit");
    link.connection.submit({ ...MESSAGE, text: fill("r_1", 4096) }, "r_1");
    link.socket.receive({ type: "request_finished", rid: "r_1", outcome: "completed" });
    link.socket.bufferedAmount = 100;
    expect(() => link.connection.submit({ ...MESSAGE, text: fill("r_2", 3997) }, "r_2")).toThrow("Request exceeds the browser connection limit");
    link.connection.submit({ ...MESSAGE, text: fill("r_2", 3996) }, "r_2");
    link.socket.bufferedAmount = 0;
    expect(() => link.connection.submit({ ...MESSAGE, text: fill("r_3", 101) }, "r_3")).toThrow("Request exceeds the browser connection limit");
    link.connection.submit({ ...MESSAGE, text: fill("r_3", 100) }, "r_3");
  });

  test("never sends more than 32 MiB at once, whatever the daemon allows", async () => {
    const link = rig();
    link.answer("/api/session", () => session({ max_message_bytes: 64 * 1024 * 1024 }));
    link.connection.connect();
    await settle();
    const socket = link.sockets[0];
    socket?.fire("open");
    socket?.receive(HELLO);
    socket?.receive(HISTORY);
    expect(() => link.connection.submit({ ...MESSAGE, text: "x".repeat(32 * 1024 * 1024) }, "r_1")).toThrow("Request exceeds the browser connection limit");
  });

  test("a lost connection fails every pending request as uncertain, and a request it could not deliver too", async () => {
    const link = await ready({ retryDelayMs: HOUR, character: "ada", thread: "story" });
    const request: BrowserRequest = { ...MESSAGE, images: ["a.png"] };
    const sent = link.connection.submit(request, "r_1");
    const failure = sent.finished.then(() => undefined, (error: unknown) => error);
    link.socket.fire("close", { code: 1006, reason: "gone" });
    const error = await failure;
    expect(error).toBeInstanceOf(InterruptedRequestError);
    expect(error).toMatchObject({ name: "InterruptedRequestError", rid: "r_1", message: "Connection interrupted. This request may have completed. Refresh and inspect its outcome before trying again." });
    const uncertain = link.updates.find((update) => update.kind === "uncertain");
    expect(uncertain).toEqual({ kind: "uncertain", rid: "r_1", request, selection: { character: "ada", thread: "story", messageRevision: 0, snapshotRevision: 1 } });
    expect(uncertain?.kind === "uncertain" ? uncertain.request : undefined).not.toBe(request);
    expect(link.updates.findIndex((update) => update.kind === "uncertain")).toBeLessThan(link.updates.findIndex((update) => update.kind === "status" && update.status === "reconnecting"));
    expect(link.connection.pendingCount).toBe(0);
    link.connection.stop();

    const broken = await ready({ retryDelayMs: HOUR });
    broken.socket.broken = true;
    const lost = broken.connection.submit(MESSAGE, "r_9");
    expect(await lost.finished.then(() => "", (reason: unknown) => (reason as Error).name)).toBe("InterruptedRequestError");
    expect(broken.statuses().at(-1)).toBe("reconnecting: Request delivery was interrupted");
    broken.connection.stop();
  });

  test("a request lost with nobody waiting on it raises no unhandled failure, and the room it took is free again", async () => {
    jest.useFakeTimers();
    const link = await ready();
    link.connection.submit({ ...MESSAGE, text: "x".repeat(4000) }, "r_1");
    link.connection.reconnect();
    jest.advanceTimersByTime(0);
    await settle();
    const socket = link.sockets.at(-1);
    socket?.fire("open");
    socket?.receive(HELLO);
    socket?.receive(HISTORY);
    expect(() => link.connection.submit({ ...MESSAGE, text: "x".repeat(4000) }, "r_2")).not.toThrow();
  });
});

describe("signing in and out", () => {
  test("signing in stops any connection, sends the token, and connects once it is accepted", async () => {
    const link = await ready();
    await link.connection.signIn("secret");
    expect(link.statuses()).toContain("stopped: Connection stopped");
    const login = link.calls.find((call) => call.path === "/api/login");
    expect(login?.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret" }) });
    expect(login?.init.signal).toBeInstanceOf(AbortSignal);
    await settle();
    expect(link.calls.at(-1)?.path).toBe("/api/session");
    expect(link.connection.status).toBe("connecting");
  });

  test("a refused sign-in says why, in the caller's words for a wrong token", async () => {
    const cases: [Response, string | undefined, string][] = [
      [problem(401, "Bad token"), "That code didn’t work", "That code didn’t work"],
      [problem(401, "Bad token"), undefined, "Bad token"],
      [problem(403, "Wrong origin"), "That code didn’t work", "Wrong origin"],
      [problem(500), undefined, "Sign-in failed"],
    ];
    for (const [reply, rejected, detail] of cases) {
      const link = rig();
      link.answer("/api/login", () => reply);
      expect(await link.connection.signIn("secret", rejected).then(() => "", (error: unknown) => (error as Error).message)).toBe(detail);
      expect(link.statuses().at(-1)).toBe(`signed_out: ${detail}`);
      expect(link.calls.map((call) => call.path)).toEqual(["/api/login"]);
    }
  });

  test("a sign-in or sign-out overtaken by another change does nothing more", async () => {
    let release: (response: Response) => void = () => {};
    const link = rig();
    link.answer("/api/login", async () => await new Promise<Response>((resolve) => { release = resolve; }));
    const signing = link.connection.signIn("secret");
    await settle();
    link.connection.stop();
    release(problem(401, "Bad token"));
    await signing;
    expect(link.statuses().at(-1)).toBe("stopped: Connection stopped");
    expect(link.calls.map((call) => call.path)).toEqual(["/api/login"]);

    link.answer("/api/logout", async () => await new Promise<Response>((resolve) => { release = resolve; }));
    const leaving = link.connection.signOut();
    await settle();
    link.connection.stop();
    release(Response.json({}));
    await leaving;
    expect(link.statuses().at(-1)).toBe("stopped: Connection stopped");
  });

  test("signing out ends the server session, or says it could not", async () => {
    const link = await ready();
    await link.connection.signOut();
    expect(link.calls.at(-1)?.path).toBe("/api/logout");
    expect(link.calls.at(-1)?.init.signal).toBeInstanceOf(AbortSignal);
    expect(link.statuses().slice(-2)).toEqual(["stopped: Connection stopped", "signed_out: "]);
    link.answer("/api/logout", () => problem(500));
    expect(await link.connection.signOut().then(() => "", (error: unknown) => (error as Error).message)).toBe("Could not end the server session. Try signing out again.");
  });

  test("each sign-in request has a deadline, ten seconds unless told otherwise", async () => {
    const timeouts = spyOn(AbortSignal, "timeout");
    try {
      for (const options of [{}, { handshakeTimeoutMs: 250 }]) {
        const link = rig(options);
        await link.connection.signIn("secret");
        await link.connection.loginCode().catch(() => undefined);
        await link.connection.signOut();
      }
      expect(timeouts.mock.calls.map(([delay]) => delay)).toEqual([10_000, 10_000, 10_000, 250, 250, 250]);
    } finally {
      timeouts.mockRestore();
    }
  });

  test("a sign-in code is fetched and checked", async () => {
    const link = rig();
    link.answer("/api/login-code", () => Response.json({ code: "abc", expires_at: 5 }), () => problem(403, "Not here"), () => problem(500), () => Response.json({ code: 5 }));
    expect(await link.connection.loginCode()).toEqual({ code: "abc", expires_at: 5 });
    expect(link.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const failure = async () => await link.connection.loginCode().then(() => "", (error: unknown) => (error as Error).message);
    expect(await failure()).toBe("Not here");
    expect(await failure()).toBe("Could not create a sign-in code");
    expect(await failure()).toBe("The daemon sent an unexpected sign-in code. Reload the page.");
  });
});
