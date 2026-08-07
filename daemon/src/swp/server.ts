/**
 * The SWP server: accept TCP connections, hand each one to
 * {@link handleConnection}, and fan broadcast events out to all of them.
 *
 * Ported from the `Server` half of `crates/daemon/src/swp_server/mod.rs`,
 * pinned by `tests/swp_fixtures/swp_parity.json`.
 *
 * # The order everything else is built in
 *
 * This is the first thing built and the last thing started, and both ends of
 * that are forced:
 *
 * - **First**, because the character registry is constructed with this server's
 *   broadcast as its history listener, and the autonomy executor pushes
 *   delivered messages through the same channel.
 * - **Last**, because a connection that hand-shakes before `MessageHandler` is
 *   draining {@link Server.routes} queues its messages in {@link RouteQueue}
 *   and is never answered. `bind` and `serve` are separate for this: binding
 *   resolves a port-zero address without accepting anything.
 *
 * Between the two, {@link Server.setHandshakeProvider} closes the cycle — the
 * provider needs the registry that needed this server's broadcast. The Rust
 * has `set_handshake_provider` for exactly the same reason.
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";

import type { ServerMessage } from "../protocol/ServerMessage";
import { buildAllowlist, type PeerAllowlist } from "./allowlist";
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
   * Entries are bare addresses or CIDR ranges, v4 or v6; see
   * {@link buildAllowlist} for how they are matched and why it is not a string
   * compare.
   *
   * The Rust's comment is worth carrying over verbatim in spirit: this is not
   * authentication and not transport security. It is a guard against casual
   * exposure when the daemon is bound to something other than loopback.
   */
  readonly allowedHosts?: readonly string[];
  readonly serverName: string;
  readonly handshake?: HandshakeProvider;
  /**
   * Whether a client's hello carries the right token.
   *
   * Required, and deliberately not optional with a permissive default: a
   * `ServerConfig` that forgot to supply one would be an open daemon, and that
   * is exactly the failure this exists to make impossible. Tests that do not
   * care pass `() => true` and say so.
   */
  readonly authenticate: (token: string | null | undefined) => boolean;
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
  readonly #allowlist: PeerAllowlist | null;
  #handshake: HandshakeProvider | undefined;
  #nextId = 1;
  #listener: NetServer | null = null;
  #shutdown!: () => void;
  readonly #shutdownSignal: Promise<void>;

  constructor(config: ServerConfig) {
    this.#config = config;
    this.#allowlist = buildAllowlist(config.allowedHosts ?? []);
    this.#handshake = config.handshake;
    this.#shutdownSignal = new Promise<void>((resolve) => {
      this.#shutdown = resolve;
    });
  }

  /**
   * Supply the handshake after construction, which is the only order there is.
   *
   * The provider answers out of the character registry, and the registry is
   * built with this server's broadcast — so one of the two has to exist first,
   * and it is this one. The Rust broke the same cycle the same way, with
   * `set_handshake_provider`.
   *
   * Safe up to {@link serve}, and pointless after {@link bind}: binding opens
   * the socket but accepts nothing, so no connection can have read the field
   * yet. A connection that arrives with none set gets {@link DEFAULT_HANDSHAKE},
   * which names no characters and hands back an empty conversation — a client
   * would render an empty window rather than fail, which is why this is set
   * before serving rather than checked for.
   */
  setHandshakeProvider(handshake: HandshakeProvider): void {
    this.#handshake = handshake;
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

    // The address the kernel gave, not the one asked for — this line is how an
    // operator finds a `--addr 127.0.0.1:0` daemon, and `:0` would tell them
    // nothing.
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

    // Everyone still connected is told they are being let go — but by their own
    // connection rather than from here. The Rust broadcast the frame at this
    // point and raced it against the same shutdown signal each connection was
    // already watching; see the `shutdown` arm of `messageLoop`.
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
    if (this.#allowlist !== null) {
      const peer = socket.remoteAddress ?? "";
      if (!this.#allowlist.check(peer)) {
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
          // A write to a socket whose peer has gone must **settle**, not hang.
          // Bun does not always call the write callback for a socket that is
          // already destroyed, and one unsettled write is enough to wedge
          // shutdown: `serve` waits on every connection before it returns, and
          // the frame the connection is trying to write is often the last one
          // — the shutdown notice. Both guards are for the same failure, one
          // before the write and one during it.
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
        // Read per connection, not captured at construction: this is what
        // `setHandshakeProvider` moves.
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
