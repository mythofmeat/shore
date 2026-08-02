/**
 * Connected-session bookkeeping and the direct-message router.
 *
 * Ported from the `ClientInfo` / `SessionMeta` / `SessionRouter` half of
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The locks are gone, and that is safe rather than convenient
 *
 * The Rust guards `clients` and `direct_txs` with `RwLock` because connections
 * are handled on separate tokio tasks that genuinely run in parallel. This
 * runs on one event loop, so a synchronous read-modify-write cannot interleave
 * and the maps need no guard.
 *
 * That is load-bearing in exactly one place. The Rust holds the write lock
 * across `remove` *and* `is_empty` with a comment saying why: two clients
 * disconnecting at once could otherwise both observe an empty map and both
 * fire `AllClientsDisconnected`, cancelling generation twice. Here
 * {@link SessionRouter.unregisterSession} does both without an intervening
 * `await`, so the same double-fire is impossible for the same reason the locks
 * are unnecessary. Adding an `await` between them would reintroduce the bug.
 */

import type { ClientMessage } from "../protocol/ClientMessage";
import type { Command } from "../protocol/Command";
import type { ServerMessage } from "../protocol/ServerMessage";

/** High-level request type, preserved through internal routing. */
export type RequestKind = "message" | "regen" | "command" | "cancel";

/**
 * Facts captured about a connected client during the handshake.
 *
 * `character` is mutable: a command can move a session to a different
 * character mid-connection, and routing reads the live value rather than the
 * one captured at handshake.
 */
export interface ClientInfo {
  readonly id: number;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities: readonly string[];
  character: string | null;
}

/**
 * Session-scoped facts captured during the SWP handshake.
 *
 * `clientId` and `sessionId` are deliberately the same number. The Rust wraps
 * them in separate newtypes to keep the concepts distinct while Shore's
 * "one TCP connection == one session" behaviour holds; they are kept as
 * separate fields here for the same reason.
 */
export interface SessionMeta {
  readonly clientId: number;
  readonly sessionId: number;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities: readonly string[];
  readonly selectedCharacter: string | null;
}

/** Per-request metadata preserved from routing into the rest of the daemon. */
export interface RequestMeta {
  readonly session: SessionMeta;
  readonly rid: string | null;
  readonly kind: RequestKind;
}

/** What the transport hands downstream once a frame is understood. */
export type RoutedMessage =
  | { readonly kind: "engine"; readonly msg: ClientMessage; readonly meta: RequestMeta }
  | { readonly kind: "command"; readonly cmd: Command; readonly meta: RequestMeta }
  | { readonly kind: "all_clients_disconnected" };

/** Turn registered client facts into the session metadata routing carries. */
export function sessionMetaOf(client: ClientInfo): SessionMeta {
  return {
    clientId: client.id,
    sessionId: client.id,
    clientType: client.clientType,
    clientName: client.clientName,
    capabilities: [...client.capabilities],
    selectedCharacter: client.character,
  };
}

/** A copy of `session` with a different selected character. */
export function withSelectedCharacter(
  session: SessionMeta,
  selectedCharacter: string | null,
): SessionMeta {
  return { ...session, selectedCharacter };
}

/** Delivers one frame to one session. Resolves when the frame is flushed. */
export type DirectSender = (msg: ServerMessage) => Promise<void>;

/**
 * Per-session direct-message router and session-metadata mutator.
 *
 * "Direct" is the distinction that matters: a frame sent through here goes to
 * exactly one session, as opposed to the broadcast channel that fans out to
 * every connection.
 */
export class SessionRouter {
  readonly #clients = new Map<number, ClientInfo>();
  readonly #senders = new Map<number, DirectSender>();

  /** Register a connected session and its direct sender. */
  registerSession(client: ClientInfo, send: DirectSender): void {
    this.#clients.set(client.id, client);
    this.#senders.set(client.id, send);
  }

  /**
   * Unregister a disconnected session, reporting whether it was the last one.
   *
   * The caller fires `AllClientsDisconnected` on `true`. Both map deletions
   * and the emptiness test happen synchronously here so two concurrent
   * disconnects cannot both see an empty map — see the note at the top.
   */
  unregisterSession(sessionId: number): { readonly allGone: boolean } {
    this.#clients.delete(sessionId);
    this.#senders.delete(sessionId);
    return { allGone: this.#clients.size === 0 };
  }

  /** Whether the session is still registered. */
  has(sessionId: number): boolean {
    return this.#clients.has(sessionId);
  }

  /** The live client record, or `undefined` once the session has gone. */
  client(sessionId: number): ClientInfo | undefined {
    return this.#clients.get(sessionId);
  }

  /** The character a session is currently talking to. */
  characterFor(sessionId: number): string | null {
    return this.#clients.get(sessionId)?.character ?? null;
  }

  /**
   * Send a request-scoped response to one session.
   *
   * Sending to a session that has already gone is not an error. The Rust
   * returns `Ok(())` for an absent sender, because a client disconnecting
   * while its command is in flight is ordinary rather than exceptional.
   */
  async sendToSession(sessionId: number, msg: ServerMessage): Promise<void> {
    await this.#senders.get(sessionId)?.(msg);
  }

  /**
   * Update the transport-visible selected character after an authoritative
   * session mutation. Returns `false` if the session is no longer connected.
   */
  setSelectedCharacter(sessionId: number, selectedCharacter: string | null): boolean {
    const client = this.#clients.get(sessionId);
    if (client === undefined) return false;
    client.character = selectedCharacter;
    return true;
  }

  /** Snapshot connected sessions and their selected characters. */
  sessions(): Array<readonly [number, string | null]> {
    return [...this.#clients.values()].map((client) => [client.id, client.character] as const);
  }
}
