import type {
  CallFilter,
  CallPayload,
  CallStore,
  HttpExchangeRow,
} from "../call_store.ts";
import { invalidRequest, internalError } from "./errors.ts";
import { decodeBody } from "./decode_body.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { CallDetail } from "../protocol/CallDetail.ts";
import type { HttpExchange } from "../protocol/HttpExchange.ts";

type Args = OperationInput<"call_log">;

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

function presentCall(call: CallPayload): CallDetail {
  return {
    ...call,
    request: decodeBody(call.request),
    response: decodeBody(call.response),
  };
}

function presentWire(exchanges: readonly HttpExchangeRow[], bodies: boolean): HttpExchange[] {
  return exchanges.map((exchange) => {
    const {
      request_headers,
      request_body,
      response_headers,
      response_body,
      ...meta
    } = exchange;
    if (!bodies) return meta;
    return {
      ...meta,
      request_headers,
      response_headers,
      request_body: decodeBody(request_body),
      response_body: decodeBody(response_body),
    };
  });
}

export function callLog(ctx: CallLogContext, args: Args): OperationResult<"call_log"> {
  const store = ctx.callStore;
  if (store === undefined) return { enabled: false, entries: [] };

  const id = asI64(args["id"]);
  if (id !== undefined) {
    const payload = query(CALL_STORE_FAILED, () => store.getCall(id));
    if (payload === null) throw invalidRequest(`no call with id ${id}`);
    const callType = asStr(args["call_type"]);
    if (callType !== undefined && payload.call_type !== callType) {
      throw invalidRequest(
        `call ${id} has type ${JSON.stringify(payload.call_type)}; expected ${JSON.stringify(callType)}`,
      );
    }
    const wire = query(CALL_STORE_FAILED, () => store.httpCallsFor(payload.call_id));
    const bodies = args["wire"] === true;
    if (args["diff"] !== true) {
      return { enabled: true, call: presentCall(payload), wire: presentWire(wire, bodies) };
    }

    const against = asI64(args["against"]) ?? query(CALL_STORE_FAILED, () => store.previousCallId(id));
    if (against === null) {
      throw invalidRequest(`call ${id} has no earlier call to compare against`);
    }
    const diff = query(CALL_STORE_FAILED, () => store.diffCalls(against, id));
    if (diff === null) {
      throw invalidRequest(`calls ${against} and ${id} cannot be compared`);
    }
    return {
      enabled: true,
      call: presentCall(payload),
      wire: presentWire(wire, bodies),
      diff,
    };
  }

  const filter: CallFilter = {
    call_type: asStr(args["call_type"]) ?? null,
    character: asStr(args["character"]) ?? ctx.characterName,
    limit: countArg(args, 20),
  };
  const newestFirst = query(CALL_STORE_FAILED, () => store.queryCalls(filter));
  return { enabled: true, entries: [...newestFirst].reverse() };
}

const TRANSCRIPT_SOURCE = "heartbeat";
const TRANSCRIPT_SOURCES: readonly string[] = [TRANSCRIPT_SOURCE];

export function transcript(ctx: CallLogContext, args: OperationInput<"transcript">): OperationResult<"transcript"> {
  const source = args.source ?? TRANSCRIPT_SOURCE;
  if (!TRANSCRIPT_SOURCES.includes(source)) {
    throw invalidRequest(
      `unknown transcript source '${source}' (expected one of ${TRANSCRIPT_SOURCES.join(", ")})`,
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
    entries: [...rows].reverse(),
  };
}

function query<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    throw internalError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
