/**
 * The failure vocabulary every tool handler reports in.
 *
 * Ported from the `ToolError` enum in `crates/daemon/src/tools/mod.rs`. The
 * enum's `Display` prefixes each variant (`invalid args: …`, `io: …`), and the
 * model reads those prefixes — a tool that fails as `io:` is a tool the model
 * should stop retrying, where `invalid args:` is one it should retry
 * differently. The prefix is therefore part of the contract, not decoration,
 * and it lives in the constructor so no call site can forget it.
 *
 * These were originally declared in `tools/history.ts`, the first tool ported.
 * They moved here when the second one needed them; `history.ts` re-exports them
 * so its own surface is unchanged.
 */

/** An argument the caller got wrong. Reported to the model as a failed tool. */
export class InvalidArgs extends Error {
  constructor(message: string) {
    super(`invalid args: ${message}`);
    this.name = "InvalidArgs";
  }
}

/** The filesystem, or a transcript on it, could not be read or written. */
export class ToolIoError extends Error {
  constructor(message: string) {
    super(`io: ${message}`);
    this.name = "ToolIoError";
  }
}
