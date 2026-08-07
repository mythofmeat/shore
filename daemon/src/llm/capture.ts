import { ZERO_USAGE, type CallRecord, type CallStore, type Usage as StoreUsage } from "../call_store.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Usage,
} from "./types.ts";

export type CallRecorder = Pick<CallStore, "recordCall">;

let seq = 0;
function nextCallId(ts: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${ts.getUTCFullYear()}${p(ts.getUTCMonth() + 1)}${p(ts.getUTCDate())}T` +
    `${p(ts.getUTCHours())}${p(ts.getUTCMinutes())}${p(ts.getUTCSeconds())}${p(ts.getUTCMilliseconds(), 3)}`;
  seq = (seq + 1) % 10000;
  return `${stamp}-${p(seq, 4)}`;
}

function requestBody(req: SidecarRequest): string {
  const { context: _context, ...rest } = req;
  try {
    return JSON.stringify({ ...rest, api_key: "[REDACTED]" });
  } catch {
    return JSON.stringify({ error: "request not serializable", sdk: req.sdk, model: req.model });
  }
}

function storeUsage(usage: Usage | undefined): StoreUsage {
  if (usage === undefined) return ZERO_USAGE;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
  };
}

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
    }
  };

  return {
    async *stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const ts = new Date();
      const startedAt = now();
      const base = baseRecord(req, ts);
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

export function captureProviders<K extends string>(
  providers: Partial<Record<K, SidecarProvider>>,
  store: CallRecorder | undefined,
  now: () => number = Date.now,
): Partial<Record<K, SidecarProvider>> {
  if (store === undefined) return providers;
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
