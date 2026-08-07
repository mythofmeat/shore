/**
 * SWP wire framing — newline-delimited JSON over a byte stream.
 *
 * Ported from `read_message` / `write_message` in
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The size bound is checked before allocating, not after
 *
 * The Rust accumulates a line chunk by chunk and tests
 * `bytes.len() + consume > MAX_WIRE_MESSAGE_SIZE` *before* extending its
 * buffer, so a hostile client cannot make the server allocate a gigabyte to
 * discover the line was too long. The check is cumulative, so where the
 * underlying reads happen to split does not change the answer — only how
 * early the error is raised. This port keeps both properties.
 *
 * The bound counts the trailing newline. A payload of exactly
 * `MAX_WIRE_MESSAGE_SIZE` bytes is therefore rejected once its newline is
 * counted; `MAX_WIRE_MESSAGE_SIZE - 1` is the largest that fits.
 *
 * # Rust's `trim` and JavaScript's are different sets
 *
 * The Rust parses `line.trim()`, where `str::trim` uses the Unicode
 * `White_Space` property. `String.prototype.trim` uses ECMAScript's
 * `WhiteSpace ∪ LineTerminator`. They disagree in both directions:
 *
 * - **U+0085 (NEL)** is `White_Space` but not ECMAScript whitespace. Rust
 *   strips it and parses the frame; a naive `.trim()` leaves it and
 *   `JSON.parse` throws.
 * - **U+FEFF (BOM)** is ECMAScript whitespace but not `White_Space`. Rust
 *   leaves it and `serde_json` rejects the frame; a naive `.trim()` strips it
 *   and the frame parses.
 *
 * So a naive port is wrong in both directions on the same code path — one
 * frame the daemon accepted would start failing, and one it rejected would
 * start being accepted. {@link rustTrim} reproduces `White_Space` exactly.
 */

import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";

/** Mirrors `MAX_WIRE_MESSAGE_SIZE` in `client/shore-common/src/protocol/mod.rs`. */
export const MAX_WIRE_MESSAGE_SIZE = 128 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * The Unicode `White_Space` code points, which is what Rust's `char::is_whitespace`
 * tests. Deliberately not `\s`: that is the ECMAScript set, which both misses
 * U+0085 and adds U+FEFF.
 */
const RUST_WHITESPACE =
  "\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const RUST_TRIM_RE = new RegExp(`^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`, "gu");

/** `str::trim` — Unicode `White_Space`, not ECMAScript whitespace. */
export function rustTrim(value: string): string {
  return value.replace(RUST_TRIM_RE, "");
}

/** A framing-level failure. Every variant corresponds to a Rust `Err` arm. */
export class WireError extends Error {
  override readonly name = "WireError";
}

/**
 * `ignoreBOM: true` is required, and its name is the opposite of what it does:
 * it means "treat U+FEFF as an ordinary character" rather than "skip it". The
 * default strips a leading BOM, which would undo the distinction above —
 * Rust's `str::from_utf8` keeps the BOM and `serde_json` then rejects the
 * frame, so a decoder that quietly removes it would *accept* frames the daemon
 * refused.
 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Somewhere bytes can be written and flushed — a socket, or a test double. */
export interface ByteSink {
  write(bytes: Uint8Array): Promise<void> | void;
}

/**
 * Serialize a `ServerMessage` as one JSON line and flush it.
 *
 * The Rust flushes after every frame, which matters: a client blocked waiting
 * on a `Ping` it never receives is indistinguishable from a dead daemon.
 */
export async function writeMessage(sink: ByteSink, msg: ServerMessage): Promise<void> {
  await sink.write(encoder.encode(`${JSON.stringify(msg)}\n`));
}

/**
 * Reads newline-delimited `ClientMessage` frames from a byte stream.
 *
 * Construct over any async iterable of chunks; the chunking is arbitrary and
 * does not affect results, matching the Rust's `fill_buf`/`consume` loop.
 */
export class WireReader {
  readonly #chunks: AsyncIterator<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #exhausted = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#chunks = source[Symbol.asyncIterator]();
  }

  /** The unconsumed bytes of the current chunk, refilling when it runs dry. */
  async #fill(): Promise<Uint8Array> {
    while (this.#offset >= this.#pending.length) {
      if (this.#exhausted) return new Uint8Array(0);
      const next = await this.#chunks.next();
      if (next.done === true) {
        this.#exhausted = true;
        return new Uint8Array(0);
      }
      this.#pending = next.value;
      this.#offset = 0;
    }
    return this.#pending.subarray(this.#offset);
  }

  /**
   * Read one frame.
   *
   * Returns `null` at a clean EOF — the Rust's `Ok(None)`, meaning the client
   * closed the connection between frames. A partial line followed by EOF is
   * *not* a clean EOF: the Rust breaks out of its loop and parses what it has,
   * so an unterminated final frame is still delivered if it is valid JSON.
   */
  async readMessage(): Promise<ClientMessage | null> {
    const parts: Uint8Array[] = [];
    let length = 0;

    for (;;) {
      const buf = await this.#fill();
      if (buf.length === 0) {
        // EOF. With nothing buffered this is a clean disconnect; otherwise
        // fall through and parse the unterminated tail.
        if (length === 0) return null;
        break;
      }

      const newline = buf.indexOf(NEWLINE);
      const consume = newline === -1 ? buf.length : newline + 1;

      // Bound the frame *before* retaining the bytes.
      if (length + consume > MAX_WIRE_MESSAGE_SIZE) {
        throw new WireError("Message exceeds maximum size");
      }

      parts.push(buf.subarray(0, consume));
      length += consume;
      this.#offset += consume;

      if (newline !== -1) break;
    }

    const bytes = concat(parts, length);
    let line: string;
    try {
      line = decoder.decode(bytes);
    } catch (cause) {
      throw new WireError("Frame is not valid UTF-8", { cause });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rustTrim(line));
    } catch (cause) {
      throw new WireError(`Frame is not valid JSON: ${String(cause)}`, { cause });
    }
    return decodeClientMessage(parsed);
  }
}

/**
 * Decode a parsed JSON value into a `ClientMessage` the way serde would.
 *
 * `JSON.parse` is not a decoder, and the three things serde does beyond it are
 * all observable:
 *
 * 1. **An unrecognized `type` is an error.** `ClientMessage` has no
 *    `#[serde(other)]` catch-all — only `ServerMessage` does, so that an
 *    *older client* can skip a frame from a newer daemon. In the other
 *    direction there is no such tolerance: a frame the daemon does not
 *    understand is a protocol error, and passing it through would hand
 *    downstream code a message with no matching arm.
 * 2. **Unknown fields are dropped.** Issue #12 lists this as one of the
 *    protocol's forward-compatibility properties. Retaining them would let a
 *    field from a newer client survive into anything that echoes a frame back.
 * 3. **`#[serde(default)]` fields are materialized.** A `message` frame with
 *    no `images` key reaches the Rust consumer as `vec![]`, never as absent,
 *    so every consumer here should see `[]` too rather than needing `?? []`.
 *
 * Optionals *without* a default (`rid`, `guidance`, `absence_seconds`,
 * `overrides`, `character`) stay absent, matching the Rust struct.
 */
export function decodeClientMessage(value: unknown): ClientMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireError("Frame is not a JSON object");
  }
  const raw = value as Record<string, unknown>;

  const str = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) {
      if (required) throw new WireError(`Frame is missing required field ${JSON.stringify(key)}`);
      return undefined;
    }
    if (typeof v !== "string") {
      throw new WireError(`Frame field ${JSON.stringify(key)} is not a string`);
    }
    return v;
  };
  const bool = (key: string): boolean => raw[key] === true;
  const arr = <T,>(key: string): T[] => (Array.isArray(raw[key]) ? (raw[key] as T[]) : []);
  const opt = <T,>(key: string, v: T | undefined): Record<string, T> =>
    v === undefined ? {} : ({ [key]: v } as Record<string, T>);

  switch (raw.type) {
    case "hello":
      return {
        type: "hello",
        client_type: str("client_type", true) as string,
        client_name: str("client_name", true) as string,
        capabilities: arr<string>("capabilities"),
        ...opt("character", str("character", false)),
      };
    case "message":
      return {
        type: "message",
        ...opt("rid", str("rid", false)),
        text: str("text", true) as string,
        stream: bool("stream"),
        images: arr<string>("images"),
        image_data: arr("image_data"),
        ...opt("absence_seconds", numberOrUndefined(raw.absence_seconds, "absence_seconds")),
        ...opt("overrides", raw.overrides === undefined ? undefined : raw.overrides),
      } as ClientMessage;
    case "regen":
      return {
        type: "regen",
        ...opt("rid", str("rid", false)),
        stream: bool("stream"),
        ...opt("guidance", str("guidance", false)),
      };
    case "command":
      return {
        type: "command",
        ...opt("rid", str("rid", false)),
        name: str("name", true) as string,
        // `serde_json::Value`'s `Default` is `Value::Null`, so an absent
        // `args` decodes to JSON null rather than an empty object.
        args: raw.args === undefined ? null : raw.args,
      };
    case "cancel":
      return { type: "cancel" };
    default:
      throw new WireError(`Unknown client message type ${JSON.stringify(raw.type)}`);
  }
}

function numberOrUndefined(v: unknown, key: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new WireError(`Frame field ${JSON.stringify(key)} is not a number`);
  return v;
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
