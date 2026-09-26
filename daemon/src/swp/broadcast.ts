import { OutboundQueue, type QueueLimits } from "./outbound.ts";
import type { ServerMessage } from "../protocol/ServerMessage";

export const BROADCAST_CAPACITY = 256;

export type RecvResult =
  | { readonly kind: "message"; readonly msg: ServerMessage }
  | { readonly kind: "lagged"; readonly skipped: number }
  | { readonly kind: "closed" };

export class Subscription {
  readonly #queue: OutboundQueue;
  readonly #matches: ((msg: ServerMessage) => boolean) | undefined;
  #skipped = 0;
  #closed = false;
  #wake: (() => void) | null = null;
  #detach: (() => void) | null = null;

  constructor(capacity: number, detach: () => void, byteLimit?: number, matches?: (msg: ServerMessage) => boolean, options?: QueueLimits) {
    this.#queue = new OutboundQueue({ ...options, messages: capacity, bytes: byteLimit ?? Infinity });
    this.#detach = detach;
    this.#matches = matches;
  }

  push(msg: ServerMessage): void {
    if (this.#closed || this.#matches?.(msg) === false) return;
    while (!this.#queue.push(msg)) {
      this.#skipped += 1;
      if (this.#queue.shift() === undefined) break;
    }
    this.#signal();
  }

  close(): void {
    this.#closed = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async recv(): Promise<RecvResult> {
    for (;;) {
      if (this.#skipped > 0) {
        const skipped = this.#skipped;
        this.#skipped = 0;
        return { kind: "lagged", skipped };
      }
      const next = this.#queue.shift();
      if (next !== undefined) {
        return { kind: "message", msg: next };
      }
      if (this.#closed) return { kind: "closed" };
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  unsubscribe(): void {
    this.#detach?.();
    this.#detach = null;
    this.#queue.clear();
    this.#skipped = 0;
    this.close();
  }
}

export class Broadcast {
  readonly #subscribers = new Set<Subscription>();
  readonly #capacity: number;
  #closed = false;

  constructor(capacity: number = BROADCAST_CAPACITY) {
    this.#capacity = capacity;
  }

  subscribe(limits?: QueueLimits, matches?: (msg: ServerMessage) => boolean): Subscription {
    const sub: Subscription = new Subscription(Math.min(this.#capacity, limits?.messages ?? this.#capacity), () => {
      this.#subscribers.delete(sub);
    }, limits?.bytes, matches, limits);
    this.#subscribers.add(sub);
    if (this.#closed) sub.close();
    return sub;
  }

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
