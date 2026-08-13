import type { CallStore, HttpExchangeRow } from "../call_store.ts";
import type { Cassette, CassetteExchange } from "./cassette.ts";

export function exchangeFromRow(row: HttpExchangeRow): CassetteExchange | undefined {
  if (row.status === null) return undefined;
  return {
    method: row.method,
    url: row.url,
    request_headers: row.request_headers,
    request_body: row.request_body,
    status: row.status,
    status_text: row.status_text ?? "",
    response_headers: row.response_headers,
    response_body: row.response_body,
  };
}

export function cassetteFromCallStore(
  store: CallStore,
  callId: string,
  name = callId,
): Cassette {
  const exchanges = store
    .httpCallsFor(callId)
    .map(exchangeFromRow)
    .filter((e): e is CassetteExchange => e !== undefined);
  return { name, exchanges };
}
