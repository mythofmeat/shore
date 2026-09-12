export class RingBuffer<T> {
  readonly #buf: T[] = [];
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(item: T): void {
    if (this.#buf.length >= this.#capacity) this.#buf.shift();
    this.#buf.push(item);
  }

  get length(): number {
    return this.#buf.length;
  }

  get isEmpty(): boolean {
    return this.#buf.length === 0;
  }

  items(): T[] {
    return [...this.#buf];
  }

  lastN(n: number): T[] {
    return this.#buf.slice(Math.max(this.#buf.length - n, 0));
  }
}

export type ErrorEntry = import("./protocol/DiagnosticErrorEntry.ts").DiagnosticErrorEntry;

export type KeyFallbackEntry = import("./protocol/DiagnosticKeyFallbackEntry.ts").DiagnosticKeyFallbackEntry;

const DEFAULT_CAPACITY = 100;

interface Ring<T> {
  count: number;
  recent: T[];
}

export type DiagnosticsJson = import("./protocol/ErrorLogResult.ts").ErrorLogResult;

export class Diagnostics {
  readonly errors = new RingBuffer<ErrorEntry>(DEFAULT_CAPACITY);
  readonly key_fallbacks = new RingBuffer<KeyFallbackEntry>(DEFAULT_CAPACITY);

  toJson(lastN: number): DiagnosticsJson {
    return {
      errors: ring(this.errors, lastN),
      key_fallbacks: ring(this.key_fallbacks, lastN),
    };
  }
}

function ring<T extends object>(buffer: RingBuffer<T>, lastN: number): Ring<T> {
  return { count: buffer.length, recent: buffer.lastN(lastN).map(omitAbsent) };
}

function omitAbsent<T extends object>(entry: T): T {
  return Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),
  ) as T;
}
