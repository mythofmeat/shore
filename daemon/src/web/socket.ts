import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { admitClientMessage, sanitiseRid } from "../swp/admission.ts";
import { SWP_V1 } from "../swp/connection.ts";
import { decodeClientMessage, rustTrim } from "../swp/framing.ts";
import type { LocalPeer, Server } from "../swp/server.ts";
import { REQUEST_LIFECYCLE_CAPABILITY, sessionMetaOf } from "../swp/session.ts";
import type { WebSession } from "./auth.ts";
import { WEB_LIMITS } from "./policy.ts";
import { RequestHistory, RequestHistoryError } from "./requests.ts";

interface PendingRequest {
  bytes: number;
  historyId?: string;
}

export interface WebSocketState {
  readonly auth: WebSession;
  readonly abort: AbortController;
  readonly pending: Map<string, PendingRequest>;
  phase: "hello" | "attaching" | "ready" | "closed";
  peer?: LocalPeer;
  helloTimer?: ReturnType<typeof setTimeout>;
  drain?: () => void;
  detachAuth?: () => void;
  windowStart: number;
  requests: number;
  bytesInWindow: number;
  pendingBytes: number;
  controls: number;
}

export const socketState = (auth: WebSession): WebSocketState => ({
  auth, abort: new AbortController(), pending: new Map(), phase: "hello",
  windowStart: Date.now(), requests: 0, bytesInWindow: 0, pendingBytes: 0, controls: 0,
});

export class WebSocketPeers {
  readonly #server: Server;
  readonly #maxBytes: number;
  readonly #sockets = new Set<ServerWebSocket<WebSocketState>>();
  readonly #work = new Set<Promise<void>>();
  readonly #helloTimeout: number;
  readonly #drainTimeout: number;

  constructor(server: Server, maxBytes: number, helloTimeout: number, drainTimeout: number, readonly history: RequestHistory) {
    this.#server = server;
    this.#maxBytes = maxBytes;
    this.#helloTimeout = helloTimeout;
    this.#drainTimeout = drainTimeout;
  }

  get size(): number { return this.#sockets.size; }

  #track(work: Promise<void>): void {
    this.#work.add(work);
    void work.finally(() => { this.#work.delete(work); });
  }

  open(socket: ServerWebSocket<WebSocketState>): void {
    this.#sockets.add(socket);
    const expired = (): void => { this.close(socket, 4001, "Sign in again"); };
    socket.data.auth.signal.addEventListener("abort", expired, { once: true });
    socket.data.detachAuth = () => { socket.data.auth.signal.removeEventListener("abort", expired); };
    if (socket.data.auth.signal.aborted) { expired(); return; }
    socket.data.helloTimer = setTimeout(() => { this.close(socket, 1008, "Handshake timed out"); }, this.#helloTimeout);
  }

  close(socket: ServerWebSocket<WebSocketState>, code = 1000, reason = "Connection closed"): void {
    const state = socket.data;
    if (state.phase === "closed") return;
    state.phase = "closed";
    clearTimeout(state.helloTimer);
    state.detachAuth?.();
    state.abort.abort();
    state.drain?.();
    for (const pending of state.pending.values()) {
      if (pending.historyId !== undefined) this.history.interrupt(state.auth, pending.historyId);
    }
    state.pending.clear();
    state.pendingBytes = 0;
    this.#sockets.delete(socket);
    socket.close(code, reason);
    if (state.peer !== undefined) this.#track(state.peer.detach().catch(() => {}));
  }

  #send(socket: ServerWebSocket<WebSocketState>, message: ServerMessage): number {
    if (socket.data.phase === "closed") return 0;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) + socket.getBufferedAmount() > this.#maxBytes) {
      this.close(socket, 1013, "Outgoing limit reached; reconnect to refresh history");
      return 0;
    }
    const sent = socket.send(text);
    if (sent === 0) this.close(socket, 1013, "Delivery interrupted; reconnect to refresh history");
    return sent;
  }

  async #write(socket: ServerWebSocket<WebSocketState>, message: ServerMessage): Promise<void> {
    if (this.#send(socket, message) !== -1) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.close(socket, 1013, "Slow connection; reconnect to refresh history"); }, this.#drainTimeout);
      socket.data.drain = () => {
        clearTimeout(timer);
        delete socket.data.drain;
        resolve();
      };
    });
  }

  #complete(state: WebSocketState, message: ServerMessage): void {
    if (message.type !== "request_finished") return;
    const pending = state.pending.get(message.rid);
    if (pending === undefined) return;
    state.pending.delete(message.rid);
    state.pendingBytes -= pending.bytes;
  }

  async #attach(socket: ServerWebSocket<WebSocketState>, hello: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    const state = socket.data;
    try {
      const peer = await this.#server.attachLocal({
        clientType: "web", clientName: hello.client_name, capabilities: [...new Set([...hello.capabilities, REQUEST_LIFECYCLE_CAPABILITY])],
        ...(hello.character === null || hello.character === undefined ? {} : { character: hello.character }),
        ...(hello.thread === null || hello.thread === undefined ? {} : { thread: hello.thread }),
        signal: state.abort.signal,
        outboundLimits: { messages: WEB_LIMITS.queuedMessages, bytes: this.#maxBytes,
          onOverflow: () => { this.close(socket, 1013, "Outgoing limit reached; reconnect to refresh history"); } },
      });
      state.peer = peer;
      if (state.abort.signal.aborted) { await peer.detach(); return; }
      clearTimeout(state.helloTimer);
      state.phase = "ready";
      await this.#write(socket, { type: "hello", v: SWP_V1, server_name: "shore-daemon", characters: [...peer.characters] });
      for await (const message of peer.events()) {
        if (state.abort.signal.aborted) break;
        const id = "rid" in message && typeof message.rid === "string" ? state.pending.get(message.rid)?.historyId : undefined;
        if (id !== undefined) this.history.observe(state.auth, id, message);
        this.#complete(state, message);
        await this.#write(socket, message);
      }
    } catch {
      if (!state.abort.signal.aborted) this.#send(socket, { type: "error", code: "internal_error", message: "Could not attach the browser session" });
    } finally {
      this.close(socket, 1012, "Session ended; reconnect to refresh history");
    }
  }

  message(socket: ServerWebSocket<WebSocketState>, text: string | Buffer): void {
    const state = socket.data;
    if (state.phase === "closed") return;
    const now = Date.now();
    if (now - state.windowStart >= 1000) { state.windowStart = now; state.requests = 0; state.bytesInWindow = 0; }
    state.requests += 1;
    if (state.requests > WEB_LIMITS.requestsPerSecond) { this.close(socket, 1008, "Request rate limit reached"); return; }
    const bytes = Buffer.byteLength(text);
    state.bytesInWindow += bytes;
    if (typeof text !== "string" || bytes > (state.phase === "hello" ? WEB_LIMITS.helloBytes : WEB_LIMITS.messageBytes) || state.bytesInWindow > WEB_LIMITS.messageBytes) {
      this.close(socket, 1009, "Expected a bounded JSON text message"); return;
    }
    let message: ClientMessage;
    try { message = admitClientMessage(decodeClientMessage(JSON.parse(rustTrim(text)) as unknown)); }
    catch {
      this.close(socket, 1008, "Invalid client message"); return;
    }
    if (state.phase === "hello") {
      if (message.type !== "hello" || message.client_type !== "web" || (message.token !== null && message.token !== undefined)) {
        this.close(socket, 1008, "Expected a browser hello after sign-in"); return;
      }
      state.phase = "attaching";
      this.#track(this.#attach(socket, message));
      return;
    }
    if (state.phase !== "ready" || state.peer === undefined || message.type === "hello") {
      this.close(socket, 1008, "Wait for the server hello before sending requests"); return;
    }
    if (message.type !== "cancel") {
      const rid = message.rid;
      if (typeof rid !== "string" || rid.length === 0 || sanitiseRid(rid) === null || Buffer.byteLength(rid) > 128 || state.pending.has(rid)) {
        this.close(socket, 1008, "Requests need distinct correlation IDs"); return;
      }
      if (state.pending.size >= WEB_LIMITS.pendingRequests || state.pendingBytes + bytes > this.#maxBytes) {
        const error = { rid, code: "invalid_request", message: "Too many pending requests; wait for a result" } as const;
        this.#send(socket, { type: "error", ...error });
        this.#send(socket, { type: "request_finished", rid, outcome: "failed", error });
        return;
      }
      let historyId: string | undefined;
      try {
        const selected = this.#server.sessionRouter.client(state.peer.session.sessionId);
        if (selected === undefined) throw new Error("Browser session detached");
        historyId = this.history.begin(state.auth, sessionMetaOf(selected), message);
      } catch (failure) {
        const error = { rid, code: "invalid_request", message: failure instanceof RequestHistoryError ? failure.message : "Could not record this request. Nothing was dispatched; try again after recovery storage is available." } as const;
        this.#send(socket, { type: "error", ...error });
        this.#send(socket, { type: "request_finished", rid, outcome: "failed", error });
        return;
      }
      state.pending.set(rid, { bytes, ...(historyId === undefined ? {} : { historyId }) });
      state.pendingBytes += bytes;
    } else {
      if (state.controls >= WEB_LIMITS.pendingRequests) { this.close(socket, 1008, "Too many control requests"); return; }
      state.controls += 1;
    }
    const control = message.type === "cancel";
    this.#track(state.peer.send(message)
      .catch(() => { this.close(socket, 1011, "Request delivery failed"); })
      .finally(() => { if (control) state.controls -= 1; }));
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) {
      this.#send(socket, { type: "shutdown" });
      this.close(socket, 1001, "Daemon shutting down");
    }
    await Promise.allSettled(this.#work);
  }
}
