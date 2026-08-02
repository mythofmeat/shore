/**
 * The SWP server: accept TCP connections, hand each one to
 * {@link handleConnection}, and fan broadcast events out to all of them.
 *
 * Ported from the `Server` half of `crates/daemon/src/swp_server/mod.rs`,
 * pinned by `tests/swp_fixtures/swp_parity.json`.
 *
 * # Not yet serving real clients
 *
 * Nothing constructs this in production yet. `swp_server`'s downstream —
 * `handler/`, and through it `commands/`, `memory/` and `tools/` — is still
 * Rust, and wiring TypeScript to the socket while Rust still answers the
 * frames would mean shipping every routed message across the daemon/sidecar
 * hop for Rust to handle. Issue #12 names that shape as scaffolding and its
 * most recent comment rules it out specifically for this module. So the
 * transport lands complete and pinned, and gets wired when its consumers move
 * in the same phase.
 */

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
  /** `host:port`. Port 0 asks the kernel to choose. */
  readonly addr: string;
  /**
   * Optional peer-IP allowlist. Empty allows every peer.
   *
   * The Rust's comment is worth carrying over verbatim in spirit: this is not
   * authentication and not transport security. It is a guard against casual
   * exposure when the daemon is bound to something other than loopback.
   */
  readonly allowedHosts?: readonly string[];
  readonly serverName: string;
  readonly handshake?: HandshakeProvider;
  readonly log?: Logger;
}

/**
 * An unbounded queue of routed messages.
 *
 * The Rust bounds this at 256 and lets `route_tx.send` apply backpressure to
 * the connection task. That backpressure never did anything useful: the
 * consumer processes commands inline and spawns generation onto its own task,
 * so the queue only grows if the daemon has already stopped making progress.
 * Left unbounded rather than reproducing a limit whose only effect would be to
 * stall a reader that cannot help.
 */
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
  #nextId = 1;
  #listener: NetServer | null = null;
  #shutdown!: () => void;
  readonly #shutdownSignal: Promise<void>;

  constructor(config: ServerConfig) {
    this.#config = config;
    this.#shutdownSignal = new Promise<void>((resolve) => {
      this.#shutdown = resolve;
    });
  }

  /** Direct sends and session-metadata mutation. */
  get sessionRouter(): SessionRouter {
    return this.#router;
  }

  /** Routed messages, in arrival order, until the server stops. */
  routes(): AsyncGenerator<RoutedMessage> {
    return this.#routes.drain();
  }

  /** Fan an unsolicited event out to every connected client. */
  broadcast(msg: ServerMessage): void {
    this.#events.send(msg);
  }

  /**
   * Bind without accepting yet, so the caller can read the kernel-resolved
   * port before anything records it. `--addr 127.0.0.1:0` depends on this.
   */
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

  /** Accept connections until {@link stop} is called. */
  async serve(): Promise<void> {
    const listener = this.#listener ?? ((await this.bind(), this.#listener));
    if (listener === null) throw new Error("listener was not bound");

    this.#config.log?.info?.("TCP listening", { addr: this.#config.addr });

    listener.on("connection", (socket) => {
      this.#accept(socket);
    });

    await this.#shutdownSignal;

    // Tell everyone still connected before tearing the listener down, so a
    // client learns the daemon is going away rather than seeing a bare EOF.
    this.#config.log?.info?.("Server shutting down");
    this.broadcast({ type: "shutdown" });

    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await Promise.allSettled([...this.#connections]);
    this.#events.close();
    this.#routes.close();
  }

  stop(): void {
    this.#shutdown();
  }

  #accept(socket: Socket): void {
    const allowed = this.#config.allowedHosts ?? [];
    if (allowed.length > 0) {
      const peer = socket.remoteAddress ?? "";
      if (!allowed.includes(peer)) {
        this.#config.log?.warn?.("TCP connection rejected: not in allowed_hosts", { addr: peer });
        socket.destroy();
        return;
      }
    }

    const clientId = this.#nextId;
    this.#nextId += 1;
    this.#config.log?.info?.("TCP client connected", { addr: socket.remoteAddress ?? "" });

    const work = handleConnection(
      {
        input: socket,
        output: {
          write: (bytes) =>
            new Promise<void>((resolve, reject) => {
              socket.write(bytes, (err) => (err ? reject(err) : resolve()));
            }),
        },
      },
      {
        clientId,
        serverName: this.#config.serverName,
        router: this.#router,
        events: this.#events.subscribe(),
        handshake: this.#config.handshake ?? DEFAULT_HANDSHAKE,
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
