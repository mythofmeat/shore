import { createServer, type Server as NetServer, type Socket } from "node:net";

import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";
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
  eventMatchesSession,
  resolveHandshakeCharacter,
  routeClientMessage,
} from "./routing";
import { sessionMetaOf, SessionRouter, type ClientInfo, type RoutedMessage, type SessionMeta } from "./session";

export interface ServerConfig {
  readonly addr: string;
  readonly serverName: string;
  readonly handshake?: HandshakeProvider;
  readonly authenticate: (token: string | null | undefined) => boolean;
  readonly log?: Logger;
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
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities?: readonly string[];
  readonly character?: string | undefined;
  readonly onLag?: (skipped: number) => void;
}

export interface LocalPeer {
  readonly session: SessionMeta;
  readonly characters: readonly CharacterInfo[];
  readonly history: HistorySnapshot;
  send(msg: ClientMessage): Promise<void>;
  events(): AsyncGenerator<ServerMessage>;
  detach(): Promise<void>;
}

class Inbox {
  readonly #queue: ServerMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(msg: ServerMessage): void {
    this.#queue.push(msg);
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

  async *drain(): AsyncGenerator<ServerMessage> {
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

  routes(): AsyncGenerator<RoutedMessage> {
    return this.#routes.drain();
  }

  broadcast(msg: ServerMessage): void {
    this.#events.send(msg);
  }

  async attachLocal(options: LocalClientOptions): Promise<LocalPeer> {
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    const hello = await provider.hello();
    const requested = options.character ?? null;
    const history = await provider.history(resolveHandshakeCharacter(requested, hello.characters));

    const clientId = this.#nextId;
    this.#nextId += 1;
    const client: ClientInfo = {
      id: clientId,
      clientType: options.clientType,
      clientName: options.clientName,
      capabilities: options.capabilities ?? [],
      character: history.selectedCharacter,
    };

    const inbox = new Inbox();
    this.#router.registerSession(client, (msg) => {
      inbox.push(msg);
      return Promise.resolve();
    });
    inbox.push(historyMessage(history));

    const subscription = this.#events.subscribe();
    const relay = (async () => {
      for (;;) {
        const result = await subscription.recv();
        if (result.kind === "closed") break;
        if (result.kind === "lagged") {
          options.onLag?.(result.skipped);
          this.#config.log?.warn?.("Local client lagged on broadcast", {
            client_id: clientId,
            skipped: result.skipped,
          });
          continue;
        }
        if (
          eventMatchesSession(
            result.msg,
            this.#router.characterFor(clientId),
            this.#router.has(clientId),
            this.#router.receivesAllCharacters(clientId),
          )
        ) {
          inbox.push(result.msg);
        }
      }
      inbox.close();
    })();

    this.#config.log?.info?.("Local client attached", {
      client_id: clientId,
      client_name: options.clientName,
    });

    let detached = false;
    return {
      session: sessionMetaOf(client),
      characters: hello.characters,
      history,
      send: async (msg) => {
        const outcome = routeClientMessage(
          msg,
          sessionMetaOf(client),
          this.#router.characterFor(clientId),
        );
        if (outcome.action === "reply") inbox.push(outcome.reply);
        else this.#routes.push(outcome.routed);
      },
      events: () => inbox.drain(),
      detach: async () => {
        if (detached) return;
        detached = true;
        subscription.unsubscribe();
        const { allGone } = this.#router.unregisterSession(clientId);
        this.#config.log?.info?.("Local client detached", { client_id: clientId });
        if (allGone) this.#routes.push({ kind: "all_clients_disconnected" });
        await relay;
      },
    };
  }

  async bind(): Promise<{ readonly host: string; readonly port: number }> {
    const { host, port } = splitAddr(this.#config.addr);
    const listener = createServer({ noDelay: true });
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
    const listener = this.#listener ?? ((await this.bind(), this.#listener));
    if (listener === null) throw new Error("listener was not bound");

    const address = listener.address();
    this.#config.log?.info?.("TCP listening", {
      addr:
        address === null || typeof address === "string"
          ? this.#config.addr
          : `${address.address}:${address.port}`,
    });

    listener.on("connection", (socket) => {
      this.#accept(socket);
    });

    await this.#shutdownSignal;

    this.#config.log?.info?.("Server shutting down");

    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await Promise.allSettled([...this.#connections]);
    this.#events.close();
    this.#routes.close();
  }

  stop(): void {
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
        router: this.#router,
        events: this.#events.subscribe(),
        handshake: this.#handshake ?? DEFAULT_HANDSHAKE,
        authenticate: this.#config.authenticate,
        peer: socket.remoteAddress ?? "",
        route: async (msg) => {
          this.#routes.push(msg);
        },
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
