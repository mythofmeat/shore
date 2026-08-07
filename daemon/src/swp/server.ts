import { createServer, type Server as NetServer, type Socket } from "node:net";

import type { ServerMessage } from "../protocol/ServerMessage";
import { Broadcast } from "./broadcast";
import {
  DEFAULT_HANDSHAKE,
  handleConnection,
  type HandshakeProvider,
  type Logger,
} from "./connection";
import { SessionRouter, type RoutedMessage } from "./session";

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
