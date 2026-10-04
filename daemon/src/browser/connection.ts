import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { RequestFinished } from "../protocol/RequestFinished.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { WebLoginCode } from "../protocol/WebLoginCode.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import { validClientMessage, validWebLoginCode, validWebProblem, validWebSessionInfo } from "./validators.generated.js";
import { SyncState, type SyncSnapshot } from "./sync.ts";
import { parseServerFrame } from "./wire.ts";
import { randomUUID } from "./platform.ts";

export type ConnectionStatus = "idle" | "connecting" | "ready" | "reconnecting" | "signed_out" | "reload_required" | "error" | "stopped";
type RequestBody = Exclude<ClientMessage, { type: "hello" | "cancel" }>;
export type BrowserRequest = RequestBody extends infer R ? R extends RequestBody ? Omit<R, "rid"> : never : never;
export type ConnectionUpdate =
  | { kind: "status"; status: ConnectionStatus; detail: string }
  | { kind: "frame"; message: ServerMessage }
  | { kind: "future"; message: Record<string, unknown> & { type: string } }
  | { kind: "uncertain"; rid: string; request: BrowserRequest; selection: Readonly<SyncSnapshot> };

interface Pending {
  bytes: number;
  request: BrowserRequest;
  selection: Readonly<SyncSnapshot>;
  resolve: (result: RequestFinished) => void;
  reject: (reason: Error) => void;
}

export class InterruptedRequestError extends Error {
  constructor(readonly rid: string) {
    super("Connection interrupted. This request may have completed. Refresh and inspect its outcome before trying again.");
    this.name = "InterruptedRequestError";
  }
}

export interface BrowserConnectionOptions {
  origin: string;
  contract: string;
  protocol: number;
  character?: string | null;
  thread?: string | null;
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
  socket?: (url: string, subprotocol: string) => WebSocket;
  retryDelayMs?: number;
  handshakeTimeoutMs?: number;
}

export class BrowserConnection {
  readonly #options: BrowserConnectionOptions;
  readonly #listeners = new Set<(update: ConnectionUpdate) => void>();
  readonly #pending = new Map<string, Pending>();
  #pendingBytes = 0;
  #status: ConnectionStatus = "idle";
  #detail = "";
  #sync: SyncState;
  #socket: WebSocket | undefined;
  #abort: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #handshake: ReturnType<typeof setTimeout> | undefined;
  #renewal: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #retries = 0;
  #wanted = false;
  #hello = false;
  #session: WebSessionInfo | undefined;

  constructor(options: BrowserConnectionOptions) {
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || !["http:", "https:"].includes(origin.protocol)) throw new Error("Browser connection requires an exact HTTP(S) origin");
    this.#options = options;
    this.#sync = new SyncState(0, options.character ?? null, options.thread ?? null);
  }

  get status(): ConnectionStatus { return this.#status; }
  get generation(): number { return this.#generation; }
  get detail(): string { return this.#detail; }
  get selection(): Readonly<SyncSnapshot> { return this.#sync.snapshot; }
  get pendingCount(): number { return this.#pending.size; }

  subscribe(listener: (update: ConnectionUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(update: ConnectionUpdate): void { for (const listener of this.#listeners) listener(update); }
  #setStatus(status: ConnectionStatus, detail = ""): void {
    this.#status = status;
    this.#detail = detail;
    this.#emit({ kind: "status", status, detail });
  }

  async #post(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const fetcher = this.#options.fetch ?? ((url: string, options: RequestInit) => fetch(url, options));
    return fetcher(this.#options.origin + path, {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async signIn(token: string, rejected?: string): Promise<void> {
    this.stop();
    const generation = this.#generation;
    const response = await this.#post("/api/login", { token }, AbortSignal.timeout(this.#options.handshakeTimeoutMs ?? 10_000));
    if (generation !== this.#generation) return;
    if (!response.ok) {
      const problem: unknown = await response.json();
      this.#setStatus("signed_out", response.status === 401 && rejected !== undefined ? rejected : validWebProblem(problem) ? problem.message : "Sign-in failed");
      throw new Error(this.#detail);
    }
    this.connect();
  }

  async loginCode(): Promise<WebLoginCode> {
    const response = await this.#post("/api/login-code", undefined, AbortSignal.timeout(this.#options.handshakeTimeoutMs ?? 10_000));
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(validWebProblem(body) ? body.message : "Could not create a sign-in code");
    if (!validWebLoginCode(body)) throw new Error("The daemon sent an unexpected sign-in code. Reload the page.");
    return body;
  }

  async signOut(): Promise<void> {
    this.stop();
    const generation = this.#generation;
    const response = await this.#post("/api/logout", undefined, AbortSignal.timeout(this.#options.handshakeTimeoutMs ?? 10_000));
    if (generation !== this.#generation) return;
    if (!response.ok) throw new Error("Could not end the server session. Try signing out again.");
    this.#setStatus("signed_out");
  }

  connect(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#retries = 0;
    void this.#open();
  }

  reconnect(): void {
    this.#wanted = true;
    this.#lost("reconnecting", "Refreshing conversation state", 0);
  }

  stop(): void {
    this.#wanted = false;
    this.#lost("stopped", "Connection stopped");
  }

  #lost(status: ConnectionStatus, detail: string, delay?: number): void {
    this.#generation += 1;
    clearTimeout(this.#timer);
    clearTimeout(this.#handshake);
    clearTimeout(this.#renewal);
    this.#abort?.abort();
    this.#abort = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#session = undefined;
    const interrupted = [...this.#pending];
    this.#pending.clear();
    this.#pendingBytes = 0;
    for (const [rid, pending] of interrupted) {
      pending.reject(new InterruptedRequestError(rid));
      this.#emit({ kind: "uncertain", rid, request: pending.request, selection: pending.selection });
    }
    this.#setStatus(status, detail);
    if (this.#wanted && status === "reconnecting") {
      const retry = delay ?? Math.min((this.#options.retryDelayMs ?? 500) * 2 ** Math.min(this.#retries++, 5), 10_000);
      this.#timer = setTimeout(() => { void this.#open(); }, retry);
    } else this.#wanted = false;
  }

  async #open(): Promise<void> {
    if (!this.#wanted) return;
    const generation = ++this.#generation;
    this.#setStatus(this.#retries === 0 ? "connecting" : "reconnecting");
    const controller = new AbortController();
    this.#abort = controller;
    this.#handshake = setTimeout(() => {
      if (generation === this.#generation) this.#lost("reconnecting", "Connection setup timed out");
    }, this.#options.handshakeTimeoutMs ?? 10_000);
    try {
      const response = await this.#post("/api/session", undefined, controller.signal);
      const body: unknown = await response.json();
      if (generation !== this.#generation) return;
      if (!response.ok) {
        const detail = validWebProblem(body) ? body.message : "Could not check the browser session";
        this.#lost(response.status === 401 ? "signed_out" : response.status === 409 ? "reload_required" : response.status === 403 ? "error" : "reconnecting", detail);
        return;
      }
      if (!validWebSessionInfo(body)) { this.#lost("error", "The daemon returned an invalid session contract"); return; }
      if (body.contract !== this.#options.contract || body.protocol !== this.#options.protocol) {
        this.#lost("reload_required", "Shore was upgraded. Reload this page to continue."); return;
      }
      this.#session = body;
      this.#renewLater(generation, body.expires_at);
      const socket = (this.#options.socket ?? ((url, subprotocol) => new WebSocket(url, subprotocol)))(
        this.#options.origin.replace(/^http/, "ws") + "/api/swp", `shore-web-${String(body.protocol)}.${body.contract}`,
      );
      this.#socket = socket;
      this.#hello = false;
      const selected = this.#sync.snapshot;
      this.#sync = new SyncState(0, selected.character, selected.thread);
      socket.addEventListener("open", () => {
        if (generation !== this.#generation) return;
        socket.send(JSON.stringify({ type: "hello", client_type: "web", client_name: "shore-browser", capabilities: ["streaming", "history-deltas", "request-lifecycle", "multimodal-tool-results"], character: selected.character, thread: selected.thread } satisfies ClientMessage));
      });
      socket.addEventListener("message", (event) => {
        if (generation !== this.#generation) return;
        if (typeof event.data !== "string") { this.#lost("error", "The daemon sent an unsupported binary frame"); return; }
        this.#receive(event.data);
      });
      socket.addEventListener("close", (event) => {
        if (generation !== this.#generation) return;
        this.#lost(event.code === 4001 ? "signed_out" : event.code === 1008 || event.code === 1009 ? "error" : "reconnecting", event.reason || "Connection interrupted; refreshing state");
      });
      socket.addEventListener("error", () => {
        if (generation === this.#generation) this.#lost("reconnecting", "Could not connect to the daemon");
      });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#lost("reconnecting", error instanceof Error ? error.message : "Could not connect to the daemon");
    }
  }

  #renewLater(generation: number, expiresAt: number): void {
    clearTimeout(this.#renewal);
    const delay = Math.max(1000, Math.min(12 * 60 * 60 * 1000, (expiresAt - Date.now()) / 2));
    this.#renewal = setTimeout(() => { void this.#renew(generation); }, delay);
  }

  async #renew(generation: number): Promise<void> {
    const response = await this.#post("/api/session", undefined, AbortSignal.timeout(this.#options.handshakeTimeoutMs ?? 10_000)).catch(() => undefined);
    const body: unknown = await response?.json().catch(() => undefined);
    if (generation !== this.#generation) return;
    if (response?.ok === true && validWebSessionInfo(body)) {
      this.#session = body;
      this.#renewLater(generation, body.expires_at);
    } else this.#renewal = setTimeout(() => { void this.#renew(generation); }, 60_000);
  }

  #receive(text: string): void {
    const parsed = parseServerFrame(text);
    if (parsed.kind === "invalid") { this.#lost("error", parsed.reason); return; }
    if (parsed.kind === "future") { this.#emit(parsed); return; }
    const message = parsed.message;
    if (message.type === "shutdown") { this.#emit({ kind: "frame", message }); this.#lost("reconnecting", "Daemon is restarting"); return; }
    if (message.type === "hello") {
      if (this.#hello || message.v !== 1) { this.#lost("error", "Unexpected Shore handshake"); return; }
      this.#hello = true;
    } else if (!this.#hello) { this.#lost("error", "Expected the daemon hello before events"); return; }
    if (this.#status !== "ready" && message.type === "history") {
      if (message.delta !== null && message.delta !== undefined) { this.#lost("error", "Expected a full conversation after connecting"); return; }
      clearTimeout(this.#handshake);
      this.#retries = 0;
      this.#sync.observe(message);
      const generation = this.#generation;
      this.#emit({ kind: "frame", message });
      if (generation === this.#generation) this.#setStatus("ready");
      return;
    }
    const decision = this.#sync.observe(message);
    if (decision === "drop_stale") return;
    if (decision === "resync") { this.#lost("reconnecting", "Conversation updates were missed; refreshing state", 0); return; }
    if (message.type === "request_finished") {
      const pending = this.#pending.get(message.rid);
      if (pending !== undefined) {
        this.#pendingBytes -= pending.bytes;
        pending.resolve(message);
      }
      this.#pending.delete(message.rid);
    }
    this.#emit({ kind: "frame", message });
  }

  submit(request: BrowserRequest, rid = randomUUID()): { rid: string; finished: Promise<RequestFinished> } {
    const socket = this.#socket;
    const session = this.#session;
    if (this.#status !== "ready" || socket === undefined || session === undefined) throw new Error("Wait for Shore to reconnect before sending");
    if (this.#pending.size >= Math.min(session.max_pending_requests, 32)) throw new Error("Wait for a pending request to finish");
    if (!validClientMessage(request)) throw new Error("Invalid conversation request fields");
    if (this.#pending.has(rid)) throw new Error("This request is already in flight");
    const text = JSON.stringify({ ...request, rid });
    const bytes = new TextEncoder().encode(text).byteLength;
    const byteLimit = Math.min(session.max_message_bytes, 32 * 1024 * 1024);
    if (bytes + socket.bufferedAmount > byteLimit || bytes + this.#pendingBytes > byteLimit) throw new Error("Request exceeds the browser connection limit");
    const finished = new Promise<RequestFinished>((resolve, reject) => {
      this.#pending.set(rid, { bytes, request: structuredClone(request), selection: this.#sync.snapshot, resolve, reject });
      this.#pendingBytes += bytes;
    });
    void finished.catch(() => {});
    try { socket.send(text); }
    catch { this.#lost("reconnecting", "Request delivery was interrupted"); }
    return { rid, finished };
  }

  cancel(): void {
    if (this.#status !== "ready" || this.#socket === undefined) throw new Error("Cancellation needs an active connection");
    this.#socket.send(JSON.stringify({ type: "cancel" } satisfies ClientMessage));
  }
}
