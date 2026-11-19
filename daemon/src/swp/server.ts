import { OutboundQueue, type QueueLimits } from "./outbound.ts";
import { contentForClient } from "./content_projection.ts";
import { HistoryMediaDelivery } from "./history_media.ts";
import { required } from "../util/required.ts";
import { abortRejection } from "../llm/abort.ts";
import { createServer, type Server as NetServer, type Socket } from "node:net";

import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";
import { AdmissionError, admitCapabilities, admitClientMessage } from "./admission.ts";
import { Broadcast } from "./broadcast";
import {
  DEFAULT_HANDSHAKE,
  handleConnection,
  historyMessage,
  type HandshakeProvider,
  type HistorySnapshot,
  type Logger,
} from "./connection";
import {
  resolveHandshakeCharacter,
  routeClientMessage,
  sessionReceives,
} from "./routing";
import {
  sessionMetaOf,
  SessionRouter,
  type ClientInfo,
  type RoutedMessage,
  type SessionMeta,
} from "./session";

export interface ServerConfig {
  readonly addr: string;
  readonly serverName: string;
  readonly serverVersion?: string;
  readonly handshake?: HandshakeProvider;
  readonly authenticate: (token: string | null | undefined) => boolean;
  readonly log?: Logger;
}

const HANG_UP_AFTER_MS = 2_000;

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

class RouteQueue {
  readonly #items: RoutedMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(msg: RoutedMessage): void {
    this.#items.push(msg);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  close(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<RoutedMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

export interface LocalClientOptions {
  readonly archiveLimits?: import("../commands/archive.ts").ArchiveLimits;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities?: readonly string[];
  readonly confidential?: boolean;
  readonly character?: string | null | undefined;
  readonly thread?: string | undefined;
  readonly onLag?: (skipped: number) => void;
  readonly signal?: AbortSignal;
  readonly prepareMessage?: (message: ServerMessage) => ServerMessage;
  readonly outboundLimits?: QueueLimits & {
    readonly onOverflow: () => void;
  };
}

export interface LocalPeer {
  readonly session: SessionMeta;
  readonly characters: readonly CharacterInfo[];
  readonly history: HistorySnapshot;
  send(msg: ClientMessage, beforeDispatch?: () => void): Promise<void>;
  events(): AsyncGenerator<ServerMessage, void>;
  detach(): Promise<void>;
}

async function whileAttached<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const rejection = abortRejection(signal);
  try {
    return await Promise.race([work, rejection.promise]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    rejection.dispose();
  }
}

class Inbox {
  readonly #queue: OutboundQueue;
  #wake: (() => void) | null = null;
  #closed = false;

  constructor(limits: LocalClientOptions["outboundLimits"]) {
    this.#queue = new OutboundQueue(limits);
  }

  push(msg: ServerMessage, catchUp?: boolean): boolean {
    if (this.#closed) return true;
    if (!this.#queue.push(msg, catchUp)) return false;
    this.#wake?.();
    return true;
  }

  close(discard = false): void {
    this.#closed = true;
    if (discard) {
      this.#queue.clear();
    }
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<ServerMessage, void> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

export class Server {
  readonly #config: ServerConfig;
  readonly #router = new SessionRouter();
  readonly #events = new Broadcast();
  readonly #routes = new RouteQueue();
  readonly #connections = new Set<Promise<void>>();
  #stopped = false;
  #serving = false;
  readonly #stopController = new AbortController();
  #handshake: HandshakeProvider | undefined;
  #nextId = 1;
  #listener: NetServer | null = null;
  #shutdown!: () => void;
  readonly #shutdownSignal: Promise<void>;

  constructor(config: ServerConfig) {
    this.#config = config;
    this.#handshake = config.handshake;
    this.#shutdownSignal = new Promise<void>((resolve) => {
      this.#shutdown = resolve;
    });
  }

  setHandshakeProvider(handshake: HandshakeProvider): void {
    this.#handshake = handshake;
  }

  get sessionRouter(): SessionRouter {
    return this.#router;
  }

  async characters(): Promise<readonly CharacterInfo[]> {
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    return (await provider.hello()).characters;
  }

  routes(): AsyncGenerator<RoutedMessage> {
    return this.#routes.drain();
  }

  broadcast(msg: ServerMessage): void {
    this.#events.send(msg);
  }

  async attachLocal(options: LocalClientOptions): Promise<LocalPeer> {
    const limits = options.outboundLimits;
    if (limits !== undefined && (!Number.isSafeInteger(limits.messages) || limits.messages < 1 ||
      !Number.isSafeInteger(limits.bytes) || limits.bytes < 1)) {
      throw new Error("Local outbound limits must be positive safe integers");
    }
    const signal = AbortSignal.any([this.#stopController.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    const hello = await whileAttached(provider.hello(), signal);
    const requested = options.character ?? null;
    const history = await whileAttached(provider.history(
      options.character === null ? null : resolveHandshakeCharacter(requested, hello.characters),
      options.thread ?? null,
    ), signal);
    signal.throwIfAborted();

    const clientId = this.#nextId;
    this.#nextId += 1;
    const capabilities = admitCapabilities(options.capabilities ?? []);
    const client: ClientInfo = {
      ...(options.archiveLimits === undefined ? {} : { archiveLimits: options.archiveLimits }),
      id: clientId,
      clientType: options.clientType,
      clientName: options.clientName,
      capabilities,
      confidential: options.confidential === true,
      character: history.selectedCharacter,
      thread: history.selectedThread,
    };

    const inbox = new Inbox(limits);
    const media = new HistoryMediaDelivery();
    const subscription = this.#events.subscribe(limits, this.#queuedFor(clientId));
    let detached = false;
    let detachment: Promise<void> | undefined;
    const detach = (): Promise<void> => {
      if (detachment !== undefined) return detachment;
      detached = true;
      inbox.close(true);
      subscription.unsubscribe();
      this.#router.unregisterSession(clientId);
      this.#config.log?.info?.("Local client detached", { client_id: clientId });
      detachment = this.#route({ kind: "session_disconnected", sessionId: clientId });
      return detachment;
    };
    const aborted = (): void => {
      void detach().catch((error: unknown) => {
        this.#config.log?.warn?.("Local client cleanup failed", { client_id: clientId, error: String(error) });
      });
    };
    const deliver = (msg: ServerMessage, catchUp?: boolean): void => {
      if (detached) return;
      const prepared = options.prepareMessage?.(msg) ?? msg;
      if (!inbox.push(media.prepare(contentForClient(prepared, capabilities)), catchUp)) {
        aborted();
        limits?.onOverflow();
      }
    };
    this.#router.registerSession(client, async (msg, catchUp) => {
      deliver(msg, catchUp);
    });
    signal.addEventListener("abort", aborted);
    deliver(historyMessage(history), true);

    void (async () => {
      for (let result = await subscription.recv(); result.kind !== "closed"; result = await subscription.recv()) {
        if (result.kind === "lagged") {
          options.onLag?.(result.skipped);
          this.#config.log?.warn?.("Local client lagged on broadcast", {
            client_id: clientId,
            skipped: result.skipped,
          });
          if (limits !== undefined) {
            aborted();
            limits.onOverflow();
          }
        } else if (sessionReceives(this.#router, clientId, result.msg)) {
          const message = result.msg.type === "history" && (result.msg.delta !== undefined && result.msg.delta !== null) && !capabilities.includes("history-deltas")
            ? historyMessage(await whileAttached(provider.history(result.msg.selected_character ?? null, result.msg.selected_thread ?? null), signal))
            : result.msg;
          if (sessionReceives(this.#router, clientId, message)) deliver(message);
        }
      }
    })().catch((error: unknown) => {
      if (!detached) this.#config.log?.warn?.("Local client event relay failed", { client_id: clientId, error: String(error) });
      aborted();
    });

    if (!detached) await this.#route({ kind: "session_connected", sessionId: clientId });

    this.#config.log?.info?.("Local client attached", {
      client_id: clientId,
      client_name: options.clientName,
    });

    return {
      session: sessionMetaOf(client),
      characters: hello.characters,
      history,
      send: async (msg, beforeDispatch) => {
        if (detached) throw new Error("Local peer is detached");
        let admitted: ClientMessage;
        try {
          admitted = admitClientMessage(msg);
        } catch (e) {
          if (!(e instanceof AdmissionError)) throw e;
          deliver({ type: "error", code: "invalid_request", message: e.message });
          return;
        }
        const outcome = routeClientMessage(
          admitted,
          sessionMetaOf(client),
          this.#router.characterFor(clientId),
        );
        if (outcome.action === "reply") deliver(outcome.reply);
        else { beforeDispatch?.(); await this.#route(outcome.routed); }
      },
      events: () => inbox.drain(),
      detach,
    };
  }

  async bind(): Promise<{ readonly host: string; readonly port: number }> {
    const { host, port } = splitAddr(this.#config.addr);
    const listener = createServer({ noDelay: true }, (socket) => {
      if (!this.#serving || this.#stopped) { socket.destroy(); return; }
      this.#accept(socket);
    });
    this.#listener = listener;

    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, host, () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });

    const address = listener.address();
    if (address === null || typeof address === "string") {
      throw new Error(`Expected a TCP address, got ${JSON.stringify(address)}`);
    }
    return { host: address.address, port: address.port };
  }

  async serve(): Promise<void> {
    const listener = required(this.#listener);
    const sockets = new Set<Socket>();
    listener.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const address = listener.address();
    this.#config.log?.info?.("TCP listening", {
      addr:
        address === null || typeof address === "string"
          ? this.#config.addr
          : `${address.address}:${address.port}`,
    });

    this.#serving = true;

    await this.#shutdownSignal;

    this.#config.log?.info?.("Server shutting down");
    listener.close();
    const finished = Promise.allSettled(this.#connections);
    if (!await settlesWithin(finished, HANG_UP_AFTER_MS)) {
      this.#config.log?.warn?.("Hanging up on clients that didn't finish", { clients: sockets.size });
      for (const socket of sockets) socket.destroy();
      if (!await settlesWithin(finished, HANG_UP_AFTER_MS)) {
        this.#config.log?.warn?.("Stopped with client handlers still running", { handlers: this.#connections.size });
      }
    }
    this.#routes.close();
  }

  stop(): void {
    this.#stopped = true;
    this.#stopController.abort();
    this.#shutdown();
  }

  #accept(socket: Socket): void {
    const clientId = this.#nextId;
    this.#nextId += 1;
    this.#config.log?.info?.("TCP client connected", { addr: socket.remoteAddress ?? "" });

    const work = handleConnection(
      {
        input: socket,
        output: {
          write: (bytes) =>
            new Promise<void>((resolve, reject) => {
              if (socket.destroyed || socket.writableEnded) {
                resolve();
                return;
              }
              const settle = () => resolve();
              socket.once("close", settle);
              socket.write(bytes, (err) => {
                socket.removeListener("close", settle);
                if (err) reject(err);
                else resolve();
              });
            }),
        },
      },
      {
        clientId,
        serverName: this.#config.serverName,
        ...(this.#config.serverVersion === undefined ? {} : { serverVersion: this.#config.serverVersion }),
        router: this.#router,
        events: this.#events.subscribe(undefined, this.#queuedFor(clientId)),
        handshake: this.#handshake ?? DEFAULT_HANDSHAKE,
        authenticate: this.#config.authenticate,
        peer: socket.remoteAddress ?? "",
        route: (msg) => this.#route(msg),
        shutdown: this.#shutdownSignal,
        ...(this.#config.log === undefined ? {} : { log: this.#config.log }),
      },
    )
      .catch((error: unknown) => {
        this.#config.log?.warn?.("Client handler error", { client_id: clientId, error: String(error) });
      })
      .finally(() => {
        socket.destroy();
        this.#connections.delete(work);
      });

    this.#connections.add(work);
  }

  #queuedFor(clientId: number): (msg: ServerMessage) => boolean {
    return (msg) => !this.#router.has(clientId) || sessionReceives(this.#router, clientId, msg);
  }

  async #route(msg: RoutedMessage): Promise<void> {
    this.#routes.push(msg);
  }
}

function splitAddr(addr: string): { host: string; port: number } {
  const at = addr.lastIndexOf(":");
  if (at === -1) throw new Error(`Expected host:port, got ${JSON.stringify(addr)}`);
  const host = addr.slice(0, at);
  const port = Number(addr.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port in ${JSON.stringify(addr)}`);
  }
  return { host: host.replace(/^\[|\]$/g, ""), port };
}
