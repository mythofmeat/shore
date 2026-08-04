/**
 * The failure vocabulary the SWP command surface reports in.
 *
 * The Rust returned `Result<Value, (ErrorCode, String)>` from every handler and
 * the dispatcher turned the `Err` half into a `ServerMessage::Error`. Here that
 * is a thrown `CommandError` carrying the same two fields, for the reason
 * `tools/errors.ts` throws too: the tuple had to be threaded through every
 * helper by hand, and the `?` that made it readable in Rust has no equivalent.
 * The dispatcher catches once, and the code and message on the wire are
 * unchanged.
 */

import type { ErrorCode } from "../protocol/ErrorCode.ts";
import { InvalidAlt, MessageNotFound } from "../engine/message_store.ts";

/** A command that failed, with the SWP error code the client will see. */
export class CommandError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export const invalidRequest = (message: string): CommandError =>
  new CommandError("invalid_request", message);

export const notFound = (message: string): CommandError => new CommandError("not_found", message);

export const internalError = (message: string): CommandError =>
  new CommandError("internal_error", message);

/**
 * Map an engine failure onto a command error, as `commands::engine_err` did.
 *
 * `MessageNotFound` and `InvalidAlt` already carry the exact text the Rust's
 * `Display` produced, so they pass their message straight through. Everything
 * else — I/O, a malformed `active.jsonl`, a message that will not serialize —
 * is an internal error, which is what the Rust's catch-all arm said.
 *
 * The Rust had a fourth variant, `CharacterNotFound`. No engine method on this
 * side can raise it: it came from `reset_to_character`, which the registry now
 * owns. It is not mapped here because there is nothing to map.
 */
export function engineError(e: unknown): CommandError {
  if (e instanceof MessageNotFound) return notFound(e.message);
  if (e instanceof InvalidAlt) return invalidRequest(e.message);
  return internalError(e instanceof Error ? e.message : String(e));
}
