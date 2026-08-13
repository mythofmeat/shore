export class AbortError extends Error {
  constructor(message = "The operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "APIUserAbortError",
  "TimeoutError",
]);

export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && ABORT_ERROR_NAMES.has(name)) return true;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === "string" && ABORT_ERROR_NAMES.has(ctor);
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
