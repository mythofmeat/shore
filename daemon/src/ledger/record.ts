/**
 * Recording a call to `ledger.db` from the side that made it.
 *
 * This is the only writer. The daemon used to record from `LedgerStream`, which
 * meant a tool loop this side drove — one `start` … `done` over the wire — could
 * only become a single row summing every provider call in it. Worse, the
 * ownership could not be split: a loop that recorded two calls and then failed
 * would be double-counted by a daemon-side error row on top. So the rule is
 * simple and total — **this side records every call it attempted**, success,
 * failure, or abandonment, and the daemon records nothing.
 *
 * A call that dies before reaching the sidecar therefore leaves no row. It also
 * has no usage, so nothing is lost but the breadcrumb; the daemon logs that
 * dispatch failure separately.
 *
 * Recording never fails a call. Every entry point swallows its own errors: an
 * unwritten row is bad, a dropped response is worse.
 */

import { Ledger, type RecordCall, type Timing, type Usage } from "./store.ts";
import type { CallContext, GenerateResponse, SidecarRequest, StreamEvent } from "../llm/types.ts";

/**
 * Open ledgers by path, including the failures.
 *
 * `null` memoizes a path that could not be opened — usually a daemon that has
 * not created the schema yet — so a broken path costs one attempt rather than
 * one per call.
 */
const ledgers = new Map<string, Ledger | null>();

/** The open handle for `path`, opening it on first use. Exported so a test can
 *  assert what a recorded call configured on it. */

export function ledgerFor(path: string): Ledger | null {
  const existing = ledgers.get(path);
  if (existing !== undefined) return existing;
  let opened: Ledger | null = null;
  try {
    opened = Ledger.open(path);
  } catch (e) {
    console.error(`shore: cannot open ledger at ${path}: ${String(e)}`);
  }
  ledgers.set(path, opened);
  return opened;
}

/** Drop every cached handle. Tests use this; the daemon never does. */
export function closeLedgers(): void {
  for (const ledger of ledgers.values()) ledger?.close();
  ledgers.clear();
}

/**
 * The call type a loop's *continuations* carry — the calls made after tool
 * results go back. Mirrors Rust `CallType::continuation`, so a loop this side
 * drove produces the row sequence the cache tracker was built to read. The two
 * copies are pinned against each other by tests on both sides.
 */
export function continuationOf(callType: string): string {
  switch (callType) {
    // A sub-agent's continuations are `tool_loop` too.
    case "message":
    case "tool_loop":
    case "subagent":
      return "tool_loop";
    case "heartbeat":
    case "heartbeat_tool_loop":
      return "heartbeat_tool_loop";
    // No loop runs under the rest; if one ever does, its continuations are most
    // honestly still itself rather than a chat tool loop.
    default:
      return callType;
  }
}

/**
 * Anthropic's prompt-cache TTL as seconds.
 *
 * `cache_ttl` is a free-form string on the model profile, so an unrecognised
 * value leaves the tracker's default alone rather than guessing: a wrong TTL
 * either invents expiries or hides them, and both show up as cache anomalies
 * that are really config.
 */
export function cacheTtlSeconds(ttl: string | undefined): number | undefined {
  switch (ttl) {
    case "5m":
      return 300;
    case "1h":
      return 3600;
    default:
      return undefined;
  }
}

/** A call that reported no tokens. Kept out of the cache tracker by `store.ts`. */
const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
} as const;

/** Everything a row needs that is not in the {@link CallContext}. */
interface Recorded {
  usage: Usage;
  timing: Timing;
  finish_reason: string;
  /** Overrides `ctx.call_type` — used for a loop's continuations. */
  call_type?: string;
}

/**
 * Notified for each provider call that completed and was billed.
 *
 * The keepalive registers here because this is already the one funnel every
 * provider call passes through, whichever endpoint or loop made it — see
 * `autonomy/keepalive.ts`. The dependency points this way (autonomy registers
 * with the ledger, not the reverse) so recording stays ignorant of who is
 * listening: a row must be written whether or not anything cares.
 */
type CallObserver = (ctx: CallContext, model: string, callType: string) => void;

let observer: CallObserver | undefined;

/** Register the observer. Passing `undefined` clears it; tests do that. */
export function setCallObserver(fn: CallObserver | undefined): void {
  observer = fn;
}

/**
 * Whether a recorded call actually reached the provider and warmed a prefix.
 *
 * `error` and `cancelled` rows exist to say the attempt happened; they carry no
 * usage and touched no cache, so treating them as activity would push a ping
 * deadline out on the strength of a call that never landed.
 */
function callLanded(finishReason: string): boolean {
  return finishReason !== "error" && finishReason !== "cancelled";
}

function record(ctx: CallContext, req: SidecarRequest, call: Recorded): void {
  if (ctx.ledger === undefined) return;
  const ledger = ledgerFor(ctx.ledger);
  if (ledger === null) return;
  if (ctx.keepalive_max_secs !== undefined) ledger.setMaxIdleSecs(ctx.keepalive_max_secs);
  // The tracker's TTL is what decides a prefix has aged out. It defaulted to an
  // hour whatever the model asked for, which is right for Anthropic's `1h` and
  // twelve times too long for `5m` — a 5m model's expiry would go unnoticed
  // until the read collapsed, and then read as an anomaly rather than as the
  // TTL doing its job. The daemon has been sending the resolved value all
  // along; this is the reader it never had.
  const ttl = cacheTtlSeconds(ctx.cache_ttl);
  if (ttl !== undefined) ledger.setCacheTtlSecs(ttl);

  const entry: RecordCall = {
    // The ledger's `provider` is the models.toml key, not the SDK dialect —
    // one dialect fronts many providers.
    provider: req.provider_key ?? req.sdk,
    api_key_name: ctx.api_key_name,
    model: req.model,
    call_type: call.call_type ?? ctx.call_type,
    character: ctx.character,
    usage: call.usage,
    timing: call.timing,
    finish_reason: call.finish_reason,
    thinking_enabled: ctx.thinking_enabled,
    cache_ttl: ctx.cache_ttl,
    reasoning_effort: ctx.reasoning_effort,
  };
  const row = ledger.record(entry);
  if (row.cache_anomaly !== null) {
    notifyAnomaly(ctx, entry, row.cache_anomaly);
  }
}

/**
 * Record, and never let a recording failure reach the caller.
 *
 * The observer fires outside `record`, which returns early when there is no
 * ledger path or the file will not open. Those are recording concerns; a call
 * that reached a provider warmed its prefix whether or not a row landed, and
 * tying the keepalive's clock to the ledger opening would stop the schedule for
 * a reason that has nothing to do with it.
 */
function tryRecord(ctx: CallContext, req: SidecarRequest, call: Recorded): void {
  try {
    record(ctx, req, call);
  } catch (e) {
    console.error(`shore: failed to record ledger row: ${String(e)}`);
  }
  const finishReason = call.finish_reason;
  if (observer === undefined || !callLanded(finishReason)) return;
  try {
    observer(ctx, req.model, call.call_type ?? ctx.call_type);
  } catch (e) {
    console.error(`shore: call observer failed: ${String(e)}`);
  }
}

/**
 * Fire a desktop notification for a cache anomaly.
 *
 * Gated on forensics being on, exactly as the daemon's `notify_anomaly` was —
 * it moved here with the tracker that detects the anomaly. Best-effort:
 * `notify-send` may not exist, and its absence must not disturb the call.
 */
function notifyAnomaly(ctx: CallContext, call: RecordCall, anomaly: string): void {
  if (ctx.forensics_dir === undefined) return;
  const body =
    `${call.character} (${call.call_type})\n` +
    `read=${call.usage.cache_read_tokens} write=${call.usage.cache_creation_tokens}`;
  try {
    Bun.spawn(["notify-send", "--urgency=normal", "--app-name=shore", `shore: cache ${anomaly}`, body], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    // No notification daemon, no notify-send, no problem.
  }
}

/**
 * Pass a provider stream through, recording each provider call in it.
 *
 * A stream that made several calls says so as it goes, with `call_complete`;
 * one that made a single call says nothing and is recorded from `done`. That
 * distinction is the whole design: a loop's rows are written as each call
 * lands, so a loop that fails on its third call — or that the client walks away
 * from — keeps the rows for the two that already happened and were already
 * billed. Recording at the end could only ever have written their sum, which is
 * the shape that misreports the cache.
 *
 * Rows are written *before* the event is yielded, so a daemon that never
 * receives it still has the row: the call happened either way.
 *
 * A stream that ends having recorded nothing was abandoned before its first
 * call returned — the client disconnected, or the generator threw. That leaves
 * a `cancelled` row with zero usage, which is what the daemon's
 * `LedgerStream::drop` wrote and what keeps `shore usage` honest about the call
 * having been attempted. Its zero usage is why `store.ts` keeps `cancelled` out
 * of the cache tracker.
 */
export async function* recordingStream(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  source: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  if (ctx === undefined) {
    yield* source;
    return;
  }
  let recorded = 0;
  try {
    for await (const event of source) {
      if (event.type === "call_complete") {
        tryRecord(ctx, req, {
          usage: event.usage,
          timing: event.timing,
          finish_reason: event.finish_reason,
          call_type: event.continuation ? continuationOf(ctx.call_type) : ctx.call_type,
        });
        recorded += 1;
      } else if (event.type === "done") {
        // A stream that announced its calls has already recorded them; `usage`
        // here is their sum and recording it again would double-count.
        if (recorded === 0) {
          tryRecord(ctx, req, {
            usage: event.usage,
            timing: event.timing,
            finish_reason: event.finish_reason,
          });
          recorded += 1;
        }
      } else if (event.type === "error") {
        // A single-call stream reports what the provider billed before dying —
        // notably Anthropic's cache write, announced in `message_start`. A loop
        // reports the sum of its completed calls, which are already rows, so
        // the failed call contributes nothing but the fact that it happened.
        tryRecord(ctx, req, {
          usage: recorded === 0 ? event.usage : NO_USAGE,
          timing: event.timing,
          finish_reason: "error",
        });
        recorded += 1;
      }
      yield event;
    }
  } finally {
    if (recorded === 0) {
      tryRecord(ctx, req, {
        usage: NO_USAGE,
        timing: { total_ms: 0, time_to_first_token_ms: 0 },
        finish_reason: "cancelled",
      });
    }
  }
}

/** Record a non-streaming call. One call, one row. */
export function recordGenerate(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  resp: GenerateResponse,
): void {
  if (ctx === undefined) return;
  tryRecord(ctx, req, {
    usage: resp.usage,
    timing: resp.timing,
    finish_reason: resp.finish_reason,
  });
}

/**
 * Record a non-streaming call that failed.
 *
 * Nothing was billed — a `generate` that throws has no usage to report — but
 * the attempt is recorded so the row exists, mirroring the streaming path.
 */
export function recordGenerateError(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  startedAt: number,
  now: () => number = () => Date.now(),
): void {
  if (ctx === undefined) return;
  tryRecord(ctx, req, {
    usage: NO_USAGE,
    timing: { total_ms: now() - startedAt, time_to_first_token_ms: 0 },
    finish_reason: "error",
  });
}
