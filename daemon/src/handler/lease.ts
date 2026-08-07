/**
 * Which sessions see a generation's output.
 *
 * Ported from the `LastUserLease` half of `crates/daemon/src/handler/mod.rs` —
 * `LEASE_TTL`, `resolve_lease_tx`, `build_fanout_tx`, and the insert at the top
 * of `handle_engine_message`.
 *
 * A generation streams to whichever session asked for it. That is the wrong
 * answer whenever the session that asked is not the session the user is looking
 * at: a regen fired from a second frontend, a client that reconnected under a
 * new session id, a scripted `shore` invocation. The open TUI would show the
 * user's own message and then nothing, and the turn would only appear on its
 * next history load.
 *
 * So each character remembers the last session to send a real user message, and
 * generation output goes to that session as well as to the issuer.
 *
 * # The rules, and what each one is for
 *
 * - **Only a real user message takes the lease.** The lease is a guess at where
 *   the human is sitting, and typing is the only thing that proves it. A regen
 *   or a command can come from anywhere, so letting one move the lease would
 *   point the stream at a script and away from the person watching.
 * - **It lapses after an hour.** Long enough to cover a conversation, short
 *   enough that a frontend left open overnight stops receiving another
 *   frontend's turns.
 * - **A lease held by the issuer is no lease at all.** Otherwise every frame
 *   would be delivered to that session twice.
 * - **Stale leases are dropped as they are read.** Expired, or pointing at a
 *   session that has since disconnected. There is no sweeper, and none is
 *   needed: a lease nobody asks about costs one map entry.
 * - **The second recipient is chosen once, when the generation starts.** Not
 *   per frame. A frontend that connects mid-turn joins from the next turn,
 *   which is also what the Rust did — it resolved the sender before building
 *   the channel that the generation task wrote into.
 */

import type { ServerMessage } from "../protocol/ServerMessage";
import type { DirectSender, RequestKind } from "../swp/session";

/** How long a lease survives the message that took it. */
export const LEASE_TTL_MS = 60 * 60 * 1000;

interface Lease {
  readonly sessionId: number;
  readonly expiresAt: number;
}

/** All the lease needs from the router: a way to write to a session, and
 *  `undefined` once that session has gone. */
export interface LeaseRouter {
  senderFor(sessionId: number): DirectSender | undefined;
}

/** Per-character record of the last session to send a real user message. */
export class StreamLeases {
  readonly #leases = new Map<string, Lease>();

  /**
   * Take note of an inbound engine message, taking the lease if it is one.
   *
   * The Rust checked a `regen` boolean it had derived from the message variant,
   * a few branches after the variants that cannot take a lease had already
   * returned. Reading `kind` says the same thing about every message rather
   * than about the two that reach the bottom of that function — `kind` is set
   * from the variant one-for-one on the way in.
   */
  observe(character: string, sessionId: number, kind: RequestKind, now = Date.now()): void {
    if (kind !== "message") return;
    this.#leases.set(character, { sessionId, expiresAt: now + LEASE_TTL_MS });
  }

  /**
   * The second recipient for `character`'s stream, or `undefined` when there is
   * none. Evicts the lease if it has lapsed or its session has disconnected.
   *
   * The Rust checked the issuer first, so an expired lease held by the issuer
   * was left in the map for some later session to evict. Checking expiry first
   * drops it either way. No caller can tell the difference — `now` only moves
   * forward, so a lease that has lapsed can never be used again by anyone — but
   * one order leaves an entry behind and the other does not.
   */
  spectator(
    character: string,
    issuerSession: number,
    router: LeaseRouter,
    now = Date.now(),
  ): DirectSender | undefined {
    const lease = this.#leases.get(character);
    if (lease === undefined) return undefined;
    if (now >= lease.expiresAt) {
      this.#leases.delete(character);
      return undefined;
    }
    if (lease.sessionId === issuerSession) return undefined;
    const send = router.senderFor(lease.sessionId);
    if (send === undefined) this.#leases.delete(character);
    return send;
  }

  /**
   * A sender that delivers to the issuer and to the lease holder both.
   *
   * The Rust built a channel and spawned a task to drain it into the two
   * senders. That machinery bought nothing but the decoupling — a `send` on a
   * bounded channel is an await, same as this — so what is left is the
   * forwarding itself.
   *
   * Two things it keeps. Delivery failures are swallowed, each independently:
   * the Rust ignored both sends because a channel send can only fail by the
   * receiver being gone, and here they are real socket writes, so a frontend
   * that died mid-turn must not take the generation down with it. And the
   * message object is shared rather than cloned, which is safe because a frame
   * is serialized on the way out and nothing on either path mutates it.
   */
  fanout(
    character: string,
    issuerSession: number,
    issuerSend: DirectSender,
    router: LeaseRouter,
    now = Date.now(),
  ): DirectSender {
    const spectatorSend = this.spectator(character, issuerSession, router, now);
    return async (msg: ServerMessage) => {
      if (spectatorSend !== undefined) await sendQuietly(spectatorSend, msg);
      await sendQuietly(issuerSend, msg);
    };
  }

  /** Forget every lease. The caller is the last client disconnecting: nobody is
   *  watching, so no session has a claim on the next generation's output. */
  clear(): void {
    this.#leases.clear();
  }
}

async function sendQuietly(send: DirectSender, msg: ServerMessage): Promise<void> {
  try {
    await send(msg);
  } catch {
    // A recipient that cannot be written to is a disconnect in progress, which
    // is ordinary. The router drops the session on its own.
  }
}
