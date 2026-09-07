import { isAbortError, isTimeoutError } from "./abort.ts";
import { retryAfterMsFromError } from "./retry_after.ts";
import type { Timing, Usage } from "./types.ts";

export type LlmError =
  | { kind: "transport"; message: string }
  | { kind: "http_status"; status: number; body: string; retry_after_ms?: number }
  | { kind: "serialize"; message: string }
  | { kind: "deserialize"; message: string }
  | { kind: "incomplete_stream" }
  | {
      kind: "stream_errored";
      cause?: unknown;
      message: string;
      usage: Usage;
      timing: Timing;
      retry_after_ms?: number;
      timeout?: boolean;
    }
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

export function errorChain(e: unknown): Error[] {
  const out: Error[] = [];
  let current = e;
  while (current instanceof Error) {
    out.push(current);
    current = current.cause;
  }
  return out;
}

export interface BudgetStop {
  message: string;
  summary: string | undefined;
  resetAt: string | undefined;
}

export function budgetStopIn(e: unknown): BudgetStop | undefined {
  const chain = errorChain(e);
  const blocked = chain.find((part) => part.name === "BudgetBlocked");
  if (blocked === undefined) return undefined;

  let resetAt: string | undefined;
  for (const part of chain) {
    const value = (part as Error & { resetAt?: unknown }).resetAt;
    if (typeof value === "string") {
      resetAt = value;
      break;
    }
  }
  const summary = (blocked as Error & { summary?: unknown }).summary;
  return {
    message: blocked.message,
    summary: typeof summary === "string" ? summary : undefined,
    resetAt,
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(err) ?? "unknown error";
    } catch {
      return "unknown error";
    }
  }
  return String(err);
}

function statusOf(err: object): number | undefined {
  for (const field of ["statusCode", "status"] as const) {
    const raw = (err as Record<string, unknown>)[field];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
  }
  return undefined;
}

function bodyOf(err: object): string {
  for (const field of ["responseBody", "body"] as const) {
    const raw = (err as Record<string, unknown>)[field];
    if (typeof raw === "string" && raw.length > 0) return raw;
    if (raw !== undefined && raw !== null) {
      try {
        return JSON.stringify(raw) ?? "";
      } catch {
        break;
      }
    }
  }
  const err2 = (err as { error?: unknown }).error;
  if (err2 !== undefined && err2 !== null) {
    try {
      return JSON.stringify(err2) ?? "";
    } catch {
      return messageOf(err);
    }
  }
  return messageOf(err);
}

export function toLlmError(err: unknown): LlmError {
  if (isLlmError(err)) return err;
  if (isAbortError(err)) {
    return { kind: "aborted", message: messageOf(err) };
  }
  if (typeof err !== "object" || err === null) {
    return { kind: "transport", message: messageOf(err) };
  }

  const status = statusOf(err);
  if (status !== undefined) {
    const retryAfter = retryAfterMsFromError(err);
    return {
      kind: "http_status",
      status,
      body: bodyOf(err),
      ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
    };
  }

  const message = messageOf(err);
  if (isTimeoutError(err)) {
    return { kind: "transport", message: `the request timed out: ${message}` };
  }
  return { kind: "transport", message };
}
