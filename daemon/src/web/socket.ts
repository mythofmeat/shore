import { parseOperationResult } from "../operations/contracts.ts";
import { encodeServerMessage } from "../swp/outbound.ts";
import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { admitClientMessage, sanitiseRid } from "../swp/admission.ts";
import { SWP_V1 } from "../swp/handshake.ts";
import { decodeClientMessage, rustTrim } from "../swp/framing.ts";
import type { LocalPeer, Server } from "../swp/server.ts";
import { REQUEST_LIFECYCLE_CAPABILITY, sessionMetaOf } from "../swp/session.ts";
import type { WebSession } from "./auth.ts";
import { WEB_LIMITS } from "./policy.ts";
import { REQUEST_HISTORY_LIMITS, RequestHistory, RequestHistoryError, type SettledRequest } from "./requests.ts";
import { required } from "../util/required.ts";

function clientMessage(text: string): ClientMessage | undefined {
  try { return admitClientMessage(decodeClientMessage(JSON.parse(rustTrim(text)) as unknown)); } catch { return undefined; }
}

interface PendingRequest {
  bytes: number;
  images?: Map<string, string>;
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
  readonly #unannounced = new Map<string, ServerMessage[]>();
  readonly #stopObserving: () => void;

  constructor(server: Server, maxBytes: number, helloTimeout: number, drainTimeout: number, readonly history: RequestHistory) {
    this.#server = server;
    this.#maxBytes = maxBytes;
    this.#helloTimeout = helloTimeout;
    this.#drainTimeout = drainTimeout;
    this.#stopObserving = server.sessionRouter.observeRequests((sessionId, message) => {
      const settled = this.history.settle(sessionId, message);
      if (settled !== undefined && !server.sessionRouter.has(sessionId)) this.#announce(settled);
    });
  }

  #announce({ owner, finished }: SettledRequest): void {
    let delivered = false;
    for (const socket of this.#sockets) {
      if (socket.data.auth.id !== owner || socket.data.phase !== "ready") continue;
      this.#send(socket, finished);
      delivered = true;
    }
    if (delivered) return;
    const waiting = this.#unannounced.get(owner) ?? [];
    this.#unannounced.set(owner, [...waiting, finished].slice(-REQUEST_HISTORY_LIMITS.perSession));
  }


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
    state.pending.clear();
    state.pendingBytes = 0;
    this.#sockets.delete(socket);
    socket.close(code, reason);
    if (state.peer !== undefined) this.#track(state.peer.detach().catch(() => {}));
  }

  #prepare(socket: ServerWebSocket<WebSocketState>, message: ServerMessage): ServerMessage {
    const state = socket.data;
    try {
      this.#complete(state, message);
      const pending = "rid" in message && typeof message.rid === "string" ? socket.data.pending.get(message.rid) : undefined;
      if (pending !== undefined) {
        if (message.type === "send_image" && typeof message.data === "string") {
          (pending.images ??= new Map()).set(message.path, message.data);
        } else if (message.type === "tool_result") {
          for (const image of message.images ?? []) if (typeof image.data === "string" && !pending.images?.has(image.path)) (pending.images ??= new Map()).set(image.path, image.data);
        } else if (message.type === "command_output" && message.name === "run_tool" && pending.images !== undefined) {
          const report = parseOperationResult("run_tool", message.data);
          if (!("mode" in report) && report.images !== undefined) message = { ...message, data: { ...report, images: report.images.map(image => {
            if (image.data !== pending.images?.get(image.path)) return image;
            const { data: _data, ...reference } = image;
            return reference;
          }) } };
        }
      }
      return message;
    } catch {
      this.close(socket, 1011, "Could not retain the request outcome");
      return message;
    }
  }

  #send(socket: ServerWebSocket<WebSocketState>, message: ServerMessage): number {
    if (socket.data.phase === "closed") return 0;
    const { text, bytes } = encodeServerMessage(message);
    if (message.type !== "history" && bytes + socket.getBufferedAmount() > this.#maxBytes) {
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
        clientType: "web", clientName: hello.client_name, owner: state.auth.id, capabilities: [...new Set([...hello.capabilities, REQUEST_LIFECYCLE_CAPABILITY])],
        character: hello.character ?? undefined, thread: hello.thread ?? undefined,
        signal: state.abort.signal,
        prepareMessage: (message) => this.#prepare(socket, message),
        outboundLimits: { messages: WEB_LIMITS.queuedMessages, bytes: this.#maxBytes, largeHistory: true, coalesceStreams: true,
          onOverflow: () => { this.close(socket, 1013, "Outgoing limit reached; reconnect to refresh history"); } },
      });
      state.peer = peer;
      clearTimeout(state.helloTimer);
      state.phase = "ready";
      await this.#write(socket, { type: "hello", v: SWP_V1, server_name: "shore-daemon", characters: [...peer.characters] });
      const unannounced = this.#unannounced.get(state.auth.id) ?? [];
      for await (const message of peer.events()) {
        await this.#write(socket, message);
        if (message.type === "history") for (const finished of unannounced.splice(0)) this.#send(socket, finished);
      }
    } catch {
      if (!state.abort.signal.aborted) this.#send(socket, { type: "error", code: "internal_error", message: "Could not attach the browser session" });
    } finally {
      this.close(socket, 1012, "Session ended; reconnect to refresh history");
    }
  }

  message(socket: ServerWebSocket<WebSocketState>, text: string | Buffer): void {
    const refusal = this.#take(socket, text);
    if (refusal !== undefined) this.close(socket, ...refusal);
  }

  #take(socket: ServerWebSocket<WebSocketState>, text: string | Buffer): readonly [code: number, reason: string] | undefined {
    const state = socket.data;
    const now = Date.now();
    if (now - state.windowStart >= 1000) { state.windowStart = now; state.requests = 0; state.bytesInWindow = 0; }
    state.requests += 1;
    if (state.requests > WEB_LIMITS.requestsPerSecond) return [1008, "Request rate limit reached"];
    const bytes = Buffer.byteLength(text);
    state.bytesInWindow += bytes;
    if (typeof text !== "string" || bytes > (state.phase === "hello" ? WEB_LIMITS.helloBytes : WEB_LIMITS.messageBytes) || state.bytesInWindow > WEB_LIMITS.messageBytes) {
      return [1009, "Expected a bounded JSON text message"];
    }
    const message = clientMessage(text);
    if (message === undefined) return [1008, "Invalid client message"];
    if (state.phase === "hello") {
      if (message.type !== "hello" || message.client_type !== "web") return [1008, "Expected a browser hello after sign-in"];
      state.phase = "attaching";
      this.#track(this.#attach(socket, message));
      return undefined;
    }
    const peer = state.peer;
    if (peer === undefined || message.type === "hello") return [1008, "Wait for the server hello before sending requests"];
    if (message.type === "cancel") {
      if (state.controls >= WEB_LIMITS.pendingRequests) return [1008, "Too many control requests"];
      state.controls += 1;
      this.#track(peer.send(message)
        .catch(() => { this.close(socket, 1011, "Request delivery failed"); })
        .finally(() => { state.controls -= 1; }));
      return undefined;
    }
    const rid = message.rid;
    if (typeof rid !== "string" || rid.length === 0 || sanitiseRid(rid) === null || Buffer.byteLength(rid) > 128 || state.pending.has(rid)) {
      return [1008, "Requests need distinct correlation IDs"];
    }
    if (bytes > this.#maxBytes || state.pending.size >= WEB_LIMITS.pendingRequests || state.pendingBytes + bytes > this.#maxBytes) {
      const error = { rid, code: "invalid_request", message: bytes > this.#maxBytes ? `Request is too large; maximum is ${Math.min(this.#maxBytes, WEB_LIMITS.messageBytes)} bytes` : "Too many pending requests; wait for a result" } as const;
      this.#send(socket, { type: "error", ...error });
      this.#send(socket, { type: "request_finished", rid, outcome: "failed", error });
      return undefined;
    }
    state.pending.set(rid, { bytes });
    state.pendingBytes += bytes;
    this.#track(peer.send(message, () => {
      this.history.begin(state.auth, sessionMetaOf(required(this.#server.sessionRouter.client(peer.session.sessionId))), message);
    }).catch((failure: unknown) => {
      const error = { rid, code: "invalid_request", message: failure instanceof RequestHistoryError ? failure.message : "Could not deliver this request. Nothing was dispatched; try again after the connection and recovery storage are available." } as const;
      this.#complete(state, { type: "request_finished", rid, outcome: "failed", error });
      this.#send(socket, { type: "error", ...error });
      this.#send(socket, { type: "request_finished", rid, outcome: "failed", error });
    }));
    return undefined;
  }

  async stop(): Promise<void> {
    this.#stopObserving();
    for (const socket of this.#sockets) {
      this.#send(socket, { type: "shutdown" });
      this.close(socket, 1001, "Daemon shutting down");
    }
    await Promise.allSettled(this.#work);
  }
}
