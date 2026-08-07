/**
 * The two store-backed commands from `commands/state/status.rs`.
 *
 * Both read the observability {@link CallStore} and nothing else — no clock, no
 * scheduler — which is why they are ported ahead of the rest of that file.
 *
 * `call_log` has two modes in one command: with an `id` it returns that call's
 * decompressed request and response, and without one it returns an index of
 * recent calls scoped to a character. `transcript` returns the curated
 * heartbeat view, reordered for reading.
 *
 * When the debug store is switched off there is no store to ask, and both
 * commands answer `{ enabled: false }` rather than failing — a diagnostic that
 * errors when diagnostics are off is a worse diagnostic.
 */

import type { CallFilter, CallStore, TranscriptRow } from "../call_store.ts";
import { invalidRequest, internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

/** What these commands need from the session. */
export interface CallLogContext {
  /** The active character. Both commands scope to it unless told otherwise. */
  characterName: string;
  /** The debug store, or `undefined` when it is switched off. */
  callStore: CallStore | undefined;
}

// ── argument readers ────────────────────────────────────────────────────────

/** `Value::as_str`: a string, or nothing. A number is not a string. */
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * `Value::as_i64`: a signed integer. `1.5` and `"1"` are both `None` to serde,
 * and both fall through to the index rather than erroring — asking for call
 * `"1"` is asking a different question from asking for call `1`.
 */
function asI64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/**
 * `count_arg`: `Value::as_u64`, or the default.
 *
 * A negative, fractional, string or absent count is not a count, and serde
 * answers `None` to all four — so every one of them means "use the default",
 * not "use zero". Zero itself *is* a count, and means no limit to the store.
 */
function countArg(args: Args, fallback: number): number {
  const v = args["count"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

// ── call_log ────────────────────────────────────────────────────────────────

const CALL_STORE_FAILED = "call store query failed";

/**
 * Query the raw call-payload store. With `id`, return that one call's
 * decompressed request/response; otherwise return an index of recent calls
 * (newest first) filtered by `call_type` and `character` (defaulting to the
 * active character).
 */
export function callLog(ctx: CallLogContext, args: Args): Json {
  const store = ctx.callStore;
  if (store === undefined) return { enabled: false, entries: [] };

  const id = asI64(args["id"]);
  if (id !== undefined) {
    // An id answers on its own. The filters are not consulted, so a call can
    // be fetched by id even when it belongs to another character.
    const payload = query(CALL_STORE_FAILED, () => store.getCall(id));
    if (payload === null) throw invalidRequest(`no call with id ${id}`);
    return { enabled: true, call: payload };
  }

  const filter: CallFilter = {
    call_type: asStr(args["call_type"]) ?? null,
    character: asStr(args["character"]) ?? ctx.characterName,
    limit: countArg(args, 20),
  };
  return { enabled: true, entries: query(CALL_STORE_FAILED, () => store.queryCalls(filter)) };
}

// ── transcript ──────────────────────────────────────────────────────────────

/** The only source the store is asked for. */
const TRANSCRIPT_SOURCE = "heartbeat";

/**
 * Query curated background transcripts (`source` = `heartbeat`) for the active
 * character, newest first.
 */
export function transcript(ctx: CallLogContext, args: Args): Json {
  const source = asStr(args["source"]) ?? TRANSCRIPT_SOURCE;
  // Checked before the store is consulted, so an unknown source is an error
  // even when the store is off — the request was wrong either way.
  if (source !== TRANSCRIPT_SOURCE) {
    throw invalidRequest(
      `unknown transcript source '${source}' (expected '${TRANSCRIPT_SOURCE}')`,
    );
  }
  const store = ctx.callStore;
  if (store === undefined) return { enabled: false, source, entries: [] };

  const rows = query("transcript query failed", () =>
    store.queryTranscripts(source, ctx.characterName, countArg(args, 20)),
  );
  return {
    enabled: true,
    source,
    character: ctx.characterName,
    entries: orderTranscriptRows(rows),
  };
}

/**
 * Order transcript rows for display: ticks/passes newest-first, but the
 * iterations *within* each tick in chronological order. Rows arrive
 * newest-first from the store. Iterations run 0,1,2,… within a tick and reset
 * at the next, so a tick boundary is any iteration that does not strictly
 * increase over the previous (chronological) row.
 */
export function orderTranscriptRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const ticks: TranscriptRow[][] = [];
  let previous: number | undefined;
  // Walk chronologically — the reverse of how the store handed them over.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as TranscriptRow;
    const continues = previous !== undefined && row.iteration > previous;
    previous = row.iteration;
    if (continues) (ticks[ticks.length - 1] as TranscriptRow[]).push(row);
    else ticks.push([row]);
  }
  ticks.reverse();
  return ticks.flat();
}

// ── the store boundary ──────────────────────────────────────────────────────

/**
 * Run a store read, reporting a failure the way the Rust's `Err` arms did.
 *
 * The prefix is a parameter because the two commands do not share one:
 * `call_log` says `call store query failed` and `transcript` says `transcript
 * query failed`. They are the same kind of failure worded for whoever asked,
 * and a client that matches on the text would see the difference.
 */
function query<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    throw internalError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
