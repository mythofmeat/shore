/**
 * A fan-out channel with tokio `broadcast` semantics.
 *
 * Ported alongside `crates/daemon/src/swp_server/mod.rs`, which subscribes one
 * receiver per connection to a `broadcast::channel(256)` and treats falling
 * behind as grounds for disconnection.
 *
 * # Why this is not just an event emitter
 *
 * The lag behaviour is load-bearing and an emitter does not have it. A client
 * that stops reading must not be able to make the daemon buffer without bound,
 * so each subscriber gets a fixed 256-frame ring; once it overflows, the
 * *oldest* frames are dropped and the subscriber is told how many it missed.
 * The message loop counts consecutive lags and drops the connection at three.
 *
 * Dropping the oldest rather than the newest is what makes that policy safe:
 * a client that recovers is left holding the most recent frames, so a brief
 * stall costs it scrollback rather than the current state of the stream.
 */

import type { ServerMessage } from "../protocol/ServerMessage";

/** Mirrors `broadcast::channel(256)`. */
export const BROADCAST_CAPACITY = 256;

/** One receive outcome, mirroring `Result<T, RecvError>`. */
export type RecvResult =
  | { readonly kind: "message"; readonly msg: ServerMessage }
  /** Fell behind; `skipped` frames were dropped and can never be recovered. */
  | { readonly kind: "lagged"; readonly skipped: number }
  /** The channel closed — the daemon is going away. */
  | { readonly kind: "closed" };

/** One subscriber's view of the channel. */
export class Subscription {
  readonly #queue: ServerMessage[] = [];
  readonly #capacity: number;
  #skipped = 0;
  #closed = false;
  #wake: (() => void) | null = null;
  #detach: (() => void) | null = null;

  constructor(capacity: number, detach: () => void) {
    this.#capacity = capacity;
    this.#detach = detach;
  }

  /** @internal — called by the channel on every send. */
  push(msg: ServerMessage): void {
    if (this.#queue.length >= this.#capacity) {
      this.#queue.shift();
      this.#skipped += 1;
    }
    this.#queue.push(msg);
    this.#signal();
  }

  /** @internal — called by the channel when it closes. */
  close(): void {
    this.#closed = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /**
   * Await the next outcome.
   *
   * A pending lag is reported *before* any buffered frame, matching tokio:
   * the receiver learns it lost frames at the point it lost them, not after
   * draining what survived.
   */
  async recv(): Promise<RecvResult> {
    for (;;) {
      if (this.#skipped > 0) {
        const skipped = this.#skipped;
        this.#skipped = 0;
        return { kind: "lagged", skipped };
      }
      const next = this.#queue.shift();
      if (next !== undefined) return { kind: "message", msg: next };
      if (this.#closed) return { kind: "closed" };
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** Stop receiving. Idempotent. */
  unsubscribe(): void {
    this.#detach?.();
    this.#detach = null;
    this.close();
  }
}

/** The sending half. Sending to nobody is not an error. */
export class Broadcast {
  readonly #subscribers = new Set<Subscription>();
  readonly #capacity: number;
  #closed = false;

  constructor(capacity: number = BROADCAST_CAPACITY) {
    this.#capacity = capacity;
  }

  subscribe(): Subscription {
    const sub: Subscription = new Subscription(this.#capacity, () => {
      this.#subscribers.delete(sub);
    });
    this.#subscribers.add(sub);
    if (this.#closed) sub.close();
    return sub;
  }

  /**
   * Fan one frame out to every subscriber.
   *
   * The Rust discards the send error, which only ever means "no receivers".
   * A daemon with no clients connected still emits events; they simply land
   * nowhere.
   */
  send(msg: ServerMessage): void {
    for (const sub of this.#subscribers) sub.push(msg);
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  close(): void {
    this.#closed = true;
    for (const sub of this.#subscribers) sub.close();
  }
}
