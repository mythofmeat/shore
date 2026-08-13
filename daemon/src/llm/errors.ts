import type { Timing, Usage } from "./types.ts";

export type LlmError =
  | { kind: "transport"; message: string }
  | { kind: "http_status"; status: number; body: string }
  | { kind: "serialize"; message: string }
  | { kind: "deserialize"; message: string }
  | { kind: "incomplete_stream" }
  | { kind: "stream_errored"; message: string; usage: Usage; timing: Timing }
  | { kind: "missing_api_key"; var: string }
  | { kind: "provider"; message: string }
  | { kind: "budget_blocked"; message: string; scope?: string }
  | { kind: "aborted"; message: string };

const LLM_ERROR_KINDS: ReadonlySet<string> = new Set([
  "transport",
  "http_status",
  "serialize",
  "deserialize",
  "incomplete_stream",
  "stream_errored",
  "missing_api_key",
  "provider",
  "budget_blocked",
  "aborted",
]);

export function isLlmError(value: unknown): value is LlmError {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && LLM_ERROR_KINDS.has(kind);
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (isLlmError(e)) return describeLlmError(e);
  return String(e);
}

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
      return error.message;
    case "aborted":
      return `request was cancelled: ${error.message}`;
  }
}
