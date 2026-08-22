export class AbortError extends Error {
  constructor(message = "The operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "APIUserAbortError"]);

const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TimeoutError",
  "APIConnectionTimeoutError",
]);

function errorName(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && name !== "Error") return name;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === "string" ? ctor : undefined;
}

export function isAbortError(err: unknown): boolean {
  const name = errorName(err);
  return name !== undefined && ABORT_ERROR_NAMES.has(name);
}

export function isTimeoutError(err: unknown): boolean {
  const name = errorName(err);
  return name !== undefined && TIMEOUT_ERROR_NAMES.has(name);
}

export function abortRejection(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}
