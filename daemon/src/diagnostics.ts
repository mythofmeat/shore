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

export interface ErrorEntry {
  timestamp: string;
  error_type: string;
  message: string;
  context: string;
}

export interface KeyFallbackEntry {
  timestamp: string;
  rid?: string | undefined;
  provider: string;
  model: string;
  character: string;
  from_key: string;
  to_key?: string | undefined;
  kind: string;
  status?: number | undefined;
  reason: string;
}

export interface MemoryRecallEntry {
  timestamp: string;
  rid?: string | undefined;
  character: string;
  status: "no_query" | "no_match" | "recalled" | "failed";
  recalled: number;
  elapsed_ms: number;
  error?: string | undefined;
}

const DEFAULT_CAPACITY = 100;

interface Ring {
  count: number;
  recent: unknown[];
}

export interface DiagnosticsJson {
  errors: Ring;
  key_fallbacks: Ring;
  memory_recall: Ring;
}

export class Diagnostics {
  readonly errors = new RingBuffer<ErrorEntry>(DEFAULT_CAPACITY);
  readonly key_fallbacks = new RingBuffer<KeyFallbackEntry>(DEFAULT_CAPACITY);
  readonly memory_recall = new RingBuffer<MemoryRecallEntry>(DEFAULT_CAPACITY);

  toJson(lastN: number): DiagnosticsJson {
    return {
      errors: ring(this.errors, lastN),
      key_fallbacks: ring(this.key_fallbacks, lastN),
      memory_recall: ring(this.memory_recall, lastN),
    };
  }
}

function ring<T extends object>(buffer: RingBuffer<T>, lastN: number): Ring {
  return { count: buffer.length, recent: buffer.lastN(lastN).map(omitAbsent) };
}

function omitAbsent<T extends object>(entry: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),
  );
}
