import type { ServerMessage } from "../protocol/ServerMessage";

export const BROADCAST_CAPACITY = 256;

export type RecvResult =
  | { readonly kind: "message"; readonly msg: ServerMessage }
  | { readonly kind: "lagged"; readonly skipped: number }
  | { readonly kind: "closed" };

export class Subscription {
  readonly #queue: { message: ServerMessage; bytes: number }[] = [];
  readonly #capacity: number;
  readonly #byteLimit: number | undefined;
  readonly #matches: ((msg: ServerMessage) => boolean) | undefined;
  #bytes = 0;
  #skipped = 0;
  #closed = false;
  #wake: (() => void) | null = null;
  #detach: (() => void) | null = null;

  constructor(capacity: number, detach: () => void, byteLimit?: number, matches?: (msg: ServerMessage) => boolean) {
    this.#capacity = capacity;
    this.#detach = detach;
    this.#byteLimit = byteLimit;
    this.#matches = matches;
  }

  push(msg: ServerMessage): void {
    if (this.#closed || this.#matches?.(msg) === false) return;
    const bytes = this.#byteLimit === undefined ? 0 : Buffer.byteLength(JSON.stringify(msg));
    while (this.#queue.length > 0 &&
      (this.#queue.length >= this.#capacity || this.#bytes + bytes > (this.#byteLimit ?? Infinity))) {
      const removed = this.#queue.shift();
      this.#bytes -= removed?.bytes ?? 0;
      this.#skipped += 1;
    }
    if (bytes > (this.#byteLimit ?? Infinity)) {
      this.#skipped += 1;
    } else {
      this.#queue.push({ message: msg, bytes });
      this.#bytes += bytes;
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
        this.#bytes -= next.bytes;
        return { kind: "message", msg: next.message };
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
    this.#queue.length = 0;
    this.#bytes = 0;
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

  subscribe(limits?: { messages: number; bytes: number }, matches?: (msg: ServerMessage) => boolean): Subscription {
    const sub: Subscription = new Subscription(Math.min(this.#capacity, limits?.messages ?? this.#capacity), () => {
      this.#subscribers.delete(sub);
    }, limits?.bytes, matches);
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
