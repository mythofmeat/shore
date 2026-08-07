/**
 * The failure shapes the retry and credential-rotation layers branch on.
 *
 * Ported from `LlmError` in `crates/daemon/src/llm/mod.rs`. That enum is a
 * `thiserror` type wrapping a `reqwest::Error`, so it has no serde
 * representation; here it is a discriminated union, which is what the two
 * classifiers actually needed from it.
 *
 * `transport` covers the Rust's `LlmError::Request` — a network or connection
 * failure below the HTTP status. It is a separate variant rather than folded
 * into `incomplete_stream` because the two mean different things to a reader
 * even though both classifiers happen to treat them alike today.
 */

import type { Timing, Usage } from "./types.ts";

export type LlmError =
  /** `LlmError::Request` — the request never produced a status. */
  | { kind: "transport"; message: string }
  | { kind: "http_status"; status: number; body: string }
  | { kind: "serialize"; message: string }
  | { kind: "deserialize"; message: string }
  /** The stream ended without a terminal event. */
  | { kind: "incomplete_stream" }
  /**
   * The stream failed after some usage had already accrued. `usage` and
   * `timing` are what the provider had reported by then — notably the Anthropic
   * cache write announced in `message_start`, before any output — so the
   * partial call is billed for what it actually cost instead of zeros. Neither
   * classifier reads them; the stream accumulator that produces this error and
   * the ledger that consumes it both do.
   */
  | { kind: "stream_errored"; message: string; usage: Usage; timing: Timing }
  | { kind: "missing_api_key"; var: string }
  | { kind: "provider"; message: string }
  /**
   * `[usage]` refused the call before it was placed — see `ledger/gate.ts`.
   *
   * The Rust had no variant for this: the gate lived on the far side of an HTTP
   * hop, so a refusal arrived as a 402 that `check_sidecar_response` flattened
   * into `Provider`. That flattening cost two things now worth having back.
   * Rotation was the accident it *didn't* cost — `Provider` classifies as
   * `not_credential_failure`, so keys were safe — but retry was: `provider`
   * retries, so the daemon re-POSTed a deterministic policy refusal until the
   * attempt ceiling. Remote, that was a wasted round-trip. Local, it is a
   * backoff sleep the user waits through for an answer that cannot change.
   */
  | { kind: "budget_blocked"; message: string; scope?: string };

/** The `Display` text the Rust's `#[error(...)]` attributes produce. */
export function describeLlmError(error: LlmError): string {
  switch (error.kind) {
    case "transport":
      return `HTTP request failed: ${error.message}`;
    case "http_status":
      return `HTTP ${error.status}: ${error.body}`;
    case "serialize":
      return `failed to serialize request: ${error.message}`;
    case "deserialize":
      return `failed to parse response: ${error.message}`;
    case "incomplete_stream":
      return "stream ended without done event";
    case "stream_errored":
      return `stream errored after partial usage: ${error.message}`;
    case "missing_api_key":
      return `API key environment variable ${error.var} is not set`;
    case "provider":
      return `provider error: ${error.message}`;
    case "budget_blocked":
      // The budget's own sentence, unadorned. It is written to be read by the
      // person who set the budget, and a prefix here would be the daemon
      // explaining someone's own configuration back to them.
      return error.message;
  }
}
