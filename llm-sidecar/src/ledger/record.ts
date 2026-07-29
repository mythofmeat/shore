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
import type {
  CallContext,
  CallRecord,
  GenerateResponse,
  SidecarRequest,
  StreamEvent,
} from "../llm/types.ts";

/**
 * Open ledgers by path, including the failures.
 *
 * `null` memoizes a path that could not be opened — usually a daemon that has
 * not created the schema yet — so a broken path costs one attempt rather than
 * one per call.
 */
const ledgers = new Map<string, Ledger | null>();

function ledgerFor(path: string): Ledger | null {
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

/** Everything a row needs that is not in the {@link CallContext}. */
interface Recorded {
  usage: Usage;
  timing: Timing;
  finish_reason: string;
  /** Overrides `ctx.call_type` — used for a loop's continuations. */
  call_type?: string;
}

function record(ctx: CallContext, req: SidecarRequest, call: Recorded): void {
  if (ctx.ledger === undefined) return;
  const ledger = ledgerFor(ctx.ledger);
  if (ledger === null) return;
  if (ctx.keepalive_max_secs !== undefined) ledger.setMaxIdleSecs(ctx.keepalive_max_secs);

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

/** Record, and never let a recording failure reach the caller. */
function tryRecord(ctx: CallContext, req: SidecarRequest, call: Recorded): void {
  try {
    record(ctx, req, call);
  } catch (e) {
    console.error(`shore: failed to record ledger row: ${String(e)}`);
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

/** One row per entry in a loop's `calls`, in the order the calls were made. */
function recordLoop(ctx: CallContext, req: SidecarRequest, calls: CallRecord[]): void {
  for (const call of calls) {
    tryRecord(ctx, req, {
      usage: call.usage,
      timing: call.timing,
      finish_reason: call.finish_reason,
      call_type: call.continuation ? continuationOf(ctx.call_type) : ctx.call_type,
    });
  }
}

/**
 * Pass a provider stream through, recording each provider call in it.
 *
 * Rows are written *before* the terminal event is yielded, so a daemon that
 * never receives it still has the row — the call happened either way.
 *
 * A stream that ends with neither `done` nor `error` was abandoned: the client
 * disconnected, or the generator threw. That records a `cancelled` row with
 * zero usage, which is what the daemon's `LedgerStream::drop` wrote and what
 * keeps `shore usage` honest about the call having happened. Its zero usage is
 * why `store.ts` keeps `cancelled` out of the cache tracker.
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
  let terminal = false;
  try {
    for await (const event of source) {
      if (event.type === "done") {
        terminal = true;
        if (event.calls !== undefined && event.calls.length > 0) {
          recordLoop(ctx, req, event.calls);
        } else {
          tryRecord(ctx, req, {
            usage: event.usage,
            timing: event.timing,
            finish_reason: event.finish_reason,
          });
        }
      } else if (event.type === "error") {
        // A mid-stream failure can still carry real usage — Anthropic bills the
        // cache write announced in `message_start`, before any output.
        terminal = true;
        tryRecord(ctx, req, {
          usage: event.usage,
          timing: event.timing,
          finish_reason: "error",
        });
      }
      yield event;
    }
  } finally {
    if (!terminal) {
      tryRecord(ctx, req, {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
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
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: now() - startedAt, time_to_first_token_ms: 0 },
    finish_reason: "error",
  });
}
