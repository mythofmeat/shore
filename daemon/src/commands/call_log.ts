import type { CallFilter, CallStore, TranscriptRow } from "../call_store.ts";
import { invalidRequest, internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

export interface CallLogContext {
  characterName: string;
  callStore: CallStore | undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asI64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function countArg(args: Args, fallback: number): number {
  const v = args["count"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

const CALL_STORE_FAILED = "call store query failed";

export function callLog(ctx: CallLogContext, args: Args): Json {
  const store = ctx.callStore;
  if (store === undefined) return { enabled: false, entries: [] };

  const id = asI64(args["id"]);
  if (id !== undefined) {
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

const TRANSCRIPT_SOURCE = "heartbeat";

export function transcript(ctx: CallLogContext, args: Args): Json {
  const source = asStr(args["source"]) ?? TRANSCRIPT_SOURCE;
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

export function orderTranscriptRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const ticks: TranscriptRow[][] = [];
  let previous: number | undefined;
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

function query<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    throw internalError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
