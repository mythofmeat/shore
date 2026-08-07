/**
 * In-memory ring buffers for observability (API calls, tool executions, errors).
 *
 * The buffers are the backing store for `shore status --diagnostics`, so
 * {@link Diagnostics.toJson} is a wire format rather than a debug dump — the
 * `count`/`recent` split and the omission of absent optional fields are both
 * part of what a client reads.
 */

// ── generic ring buffer ─────────────────────────────────────────────────────

/** Fixed-capacity ring buffer. */
export class RingBuffer<T> {
  readonly #buf: T[] = [];
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /**
   * Append, evicting the oldest entry once the buffer is full.
   *
   * The eviction happens *before* the push and is a no-op on an empty buffer,
   * so a capacity of 0 holds one entry rather than none. That is a quirk rather
   * than a design, but it is the inherited one, and the alternative — a
   * capacity-0 buffer that silently drops everything written to it — is a worse
   * thing for a diagnostics ring to do.
   */
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

  /** Every entry, oldest first. */
  items(): T[] {
    return [...this.#buf];
  }

  /** The last `n` entries (or all of them, if there are fewer than `n`). */
  lastN(n: number): T[] {
    return this.#buf.slice(Math.max(this.#buf.length - n, 0));
  }
}

// ── entry types ─────────────────────────────────────────────────────────────

/**
 * Optional fields here are `skip_serializing_if = "Option::is_none"` on the
 * Rust side: when absent they are left *out* of the serialised object rather
 * than written as null. {@link omitAbsent} is what keeps that true.
 */
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
  /** Provider-reported total cost when available (e.g. OpenRouter's `cost`). */
  total_cost_usd?: number | undefined;
  /**
   * `Option<String>` in the Rust, and both spellings of "none" arrive.
   *
   * `handler/persistence.ts` writes an explicit `null` on the success path
   * because it builds the row in one literal; a failure path that never set the
   * field leaves it absent. {@link omitAbsent} erases the difference before
   * anything reads it, so the two are the same row — accepting both here is
   * what says that out loud rather than making one caller pick.
   */
  error?: string | null | undefined;
}

export interface ToolCallEntry {
  timestamp: string;
  tool_name: string;
  tool_id: string;
  success: boolean;
  duration_ms: number;
  input_summary: string;
  output_summary: string;
}

export interface ErrorEntry {
  timestamp: string;
  error_type: string;
  message: string;
  context: string;
}

/**
 * One credential-fallback rotation event for the multi-key path.
 *
 * Recorded whenever the daemon abandons a configured provider key on a
 * classified credential failure (missing/invalid/quota/budget/account rate
 * limit). The payload intentionally never carries the API key value or the env
 * var contents — only the friendly key names plus status/reason metadata.
 */
export interface KeyFallbackEntry {
  timestamp: string;
  /** Request id, when the rotation happened inside a tracked request. */
  rid?: string | undefined;
  provider: string;
  model: string;
  character: string;
  from_key: string;
  /** Friendly name of the key now in use, or absent if all candidates were exhausted. */
  to_key?: string | undefined;
  /** Stable failure tag (`CredentialFailureKind::as_str()`). */
  kind: string;
  /** HTTP status when applicable (omitted for missing-key / network cases). */
  status?: number | undefined;
  /** Sanitized reason. Never contains secrets. */
  reason: string;
}

// ── the aggregate ───────────────────────────────────────────────────────────

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

  /**
   * Serialize the last `n` entries from each ring as JSON.
   *
   * `count` is the ring's current length, not the number of entries `recent`
   * holds and not the number ever pushed — a client showing "3 of 100 recent
   * calls" is reading both numbers, and they answer different questions.
   */
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

/**
 * Drop keys whose value is absent, mirroring serde's `skip_serializing_if`.
 *
 * `JSON.stringify` would do this on its own for `undefined`, but the value
 * returned here is compared and passed around as an object before anything
 * stringifies it, so the key has to be gone at that point rather than at the
 * last moment.
 */
function omitAbsent<T extends object>(entry: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),
  );
}
