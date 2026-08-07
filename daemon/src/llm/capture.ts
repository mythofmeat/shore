/**
 * Recording every provider call's request and response into the payload store.
 *
 * This is the writer behind `shore log` and `[advanced].api_payload_logging`.
 * The port defined {@link CallStore.recordCall}, opened the store at startup and
 * logged "call payload store enabled" — and then never called it. `calls.db`
 * held only the rows the Rust daemon had written, so the log built for
 * answering "what did we actually send?" was empty for exactly the window in
 * which a cache bug needed it.
 *
 * # One row per provider entry point, not per model call
 *
 * The Rust drove tool loops daemon-side, so every model call was its own
 * `stream()` and got its own row. Here the Anthropic loop runs *inside*
 * `stream()`, so one row can cover several model calls and its response body
 * carries several `call_complete` events. The row's headline usage and finish
 * reason come from the terminal event, which is the aggregate for the whole
 * loop; per-call accounting is the ledger's job (one row per `call_complete`)
 * and per-call cache placement is `cache_forensics.jsonl`'s. Reach for those
 * when the question is about one call rather than one request.
 *
 * # Never in the way
 *
 * A capture failure must not fail a call that otherwise worked, so every store
 * write is wrapped. The stream wrapper is a passthrough generator: events reach
 * the caller as they arrive and the row is written when the stream ends,
 * including when it ends by throwing.
 */

import { ZERO_USAGE, type CallRecord, type CallStore, type Usage as StoreUsage } from "../call_store.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Usage,
} from "./types.ts";

/** What the store needs; narrowed so tests can pass a stub. */
export type CallRecorder = Pick<CallStore, "recordCall">;

/**
 * `YYYYMMDDTHHMMSSmmm-NNNN`, matching the ids the Rust wrote.
 *
 * The counter disambiguates calls landing in the same millisecond — concurrent
 * subagents do — and wraps at 10000, which only has to be unique within a
 * millisecond.
 */
let seq = 0;
function nextCallId(ts: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${ts.getUTCFullYear()}${p(ts.getUTCMonth() + 1)}${p(ts.getUTCDate())}T` +
    `${p(ts.getUTCHours())}${p(ts.getUTCMinutes())}${p(ts.getUTCSeconds())}${p(ts.getUTCMilliseconds(), 3)}`;
  seq = (seq + 1) % 10000;
  return `${stamp}-${p(seq, 4)}`;
}

/**
 * The request as sent, minus what must not be stored.
 *
 * `api_key` is replaced rather than dropped, so a reader can still see *that* a
 * credential was attached — the Rust wrote the same `[REDACTED]` sentinel.
 * `context` is omitted entirely: it is daemon-side labelling that never reaches
 * a provider, and it carries the resolved `[usage]` budget config, so storing it
 * would put a copy of that in every row for no diagnostic gain. Its useful
 * fields are already the row's own columns.
 */
function requestBody(req: SidecarRequest): string {
  const { context: _context, ...rest } = req;
  try {
    return JSON.stringify({ ...rest, api_key: "[REDACTED]" });
  } catch {
    // A request that will not serialize must still produce a row, or the
    // failure it is evidence of is the one case with no evidence.
    return JSON.stringify({ error: "request not serializable", sdk: req.sdk, model: req.model });
  }
}

/** Provider `Usage` narrowed to the three counts the store indexes. */
function storeUsage(usage: Usage | undefined): StoreUsage {
  if (usage === undefined) return ZERO_USAGE;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
  };
}

/** The row's shared columns. */
function baseRecord(req: SidecarRequest, ts: Date): Omit<CallRecord, "usage"> {
  const ctx = req.context;
  return {
    call_id: nextCallId(ts),
    ts,
    call_type: ctx?.call_type ?? null,
    character: ctx?.character ?? null,
    model: req.model,
    provider: req.provider_key ?? req.sdk,
    sdk: req.sdk,
    rid: ctx?.rid ?? null,
    request_body: requestBody(req),
  };
}

/**
 * Wrap a provider so both entry points record.
 *
 * Returns the provider unchanged when there is no store, so a daemon with
 * capture off runs the original object rather than a passthrough of it.
 */
export function withCallCapture(
  provider: SidecarProvider,
  store: CallRecorder | undefined,
  now: () => number = Date.now,
): SidecarProvider {
  if (store === undefined) return provider;

  const write = (record: CallRecord): void => {
    try {
      store.recordCall(record);
    } catch {
      // Diagnostics are never worth failing a call over.
    }
  };

  return {
    async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const ts = new Date();
      const startedAt = now();
      const base = baseRecord(req, ts);
      // NDJSON, one event per line, in arrival order — the format `shore log`
      // already reads and the only one that keeps a stream that died mid-flight
      // readable up to the point it died.
      const lines: string[] = [];
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      let failure: string | undefined;

      try {
        for await (const event of provider.stream(req, signal)) {
          try {
            lines.push(JSON.stringify(event));
          } catch {
            lines.push(JSON.stringify({ type: event.type, error: "event not serializable" }));
          }
          // `done` is the aggregate and wins; `call_complete` and `error` keep
          // the last one seen so a loop that never reached `done` still reports
          // the usage it had accrued.
          if (event.type === "done" || event.type === "call_complete" || event.type === "error") {
            usage = event.usage ?? usage;
            if ("finish_reason" in event) finishReason = event.finish_reason;
          }
          if (event.type === "error") failure = event.message;
          yield event;
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        write({
          ...base,
          finish_reason: finishReason ?? null,
          usage: storeUsage(usage),
          duration_ms: now() - startedAt,
          error: failure ?? null,
          response_body: lines.length > 0 ? lines.join("\n") : null,
        });
      }
    },

    async generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse> {
      const ts = new Date();
      const startedAt = now();
      const base = baseRecord(req, ts);
      try {
        const response = await provider.generate(req, signal);
        write({
          ...base,
          finish_reason: response.finish_reason,
          usage: storeUsage(response.usage),
          duration_ms: now() - startedAt,
          error: null,
          response_body: JSON.stringify(response),
        });
        return response;
      } catch (e) {
        write({
          ...base,
          finish_reason: null,
          usage: ZERO_USAGE,
          duration_ms: now() - startedAt,
          error: e instanceof Error ? e.message : String(e),
          response_body: null,
        });
        throw e;
      }
    },
  };
}

/** Wrap every adapter in a provider table. */
export function captureProviders<K extends string>(
  providers: Partial<Record<K, SidecarProvider>>,
  store: CallRecorder | undefined,
  now: () => number = Date.now,
): Partial<Record<K, SidecarProvider>> {
  if (store === undefined) return providers;
  // `deepseek` and `moonshot` share one instance; wrapping per key would give
  // them two wrappers around the same adapter, which is harmless but doubles
  // nothing usefully. Memoised so a shared adapter keeps a shared wrapper.
  const wrapped = new Map<SidecarProvider, SidecarProvider>();
  const out: Partial<Record<K, SidecarProvider>> = {};
  for (const [key, provider] of Object.entries(providers) as [K, SidecarProvider | undefined][]) {
    if (provider === undefined) continue;
    let w = wrapped.get(provider);
    if (w === undefined) {
      w = withCallCapture(provider, store, now);
      wrapped.set(provider, w);
    }
    out[key] = w;
  }
  return out;
}
