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

export interface ApiCallEntry {
  timestamp: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ttft_ms: number;
  total_ms: number;
  finish_reason: string;
  total_cost_usd?: number | undefined;
  error?: string | null | undefined;
  subagent?: string | undefined;
}

export interface ToolCallEntry {
  timestamp: string;
  tool_name: string;
  tool_id: string;
  success: boolean;
  duration_ms: number;
  input_summary: string;
  output_summary: string;
  subagent?: string | undefined;
  truncated?: boolean;
  result_chars?: number;
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

const DEFAULT_CAPACITY = 100;

interface Ring {
  count: number;
  recent: unknown[];
}

export interface DiagnosticsJson {
  api_calls: Ring;
  tool_calls: Ring;
  errors: Ring;
  key_fallbacks: Ring;
}

export class Diagnostics {
  readonly api_calls = new RingBuffer<ApiCallEntry>(DEFAULT_CAPACITY);
  readonly tool_calls = new RingBuffer<ToolCallEntry>(DEFAULT_CAPACITY);
  readonly errors = new RingBuffer<ErrorEntry>(DEFAULT_CAPACITY);
  readonly key_fallbacks = new RingBuffer<KeyFallbackEntry>(DEFAULT_CAPACITY);

  toJson(lastN: number): DiagnosticsJson {
    return {
      api_calls: ring(this.api_calls, lastN),
      tool_calls: ring(this.tool_calls, lastN),
      errors: ring(this.errors, lastN),
      key_fallbacks: ring(this.key_fallbacks, lastN),
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
