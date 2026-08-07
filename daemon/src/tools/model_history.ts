/**
 * `model_history` — which models spoke for this character, and when.
 *
 * Ported from `crates/daemon/src/tools/model_history.rs`, pinned by
 * `tests/tools_fixtures/tool_handlers_parity.json`.
 *
 * What the underlying query *returns* is pinned where the query runs, in
 * `ledger_usage.test.ts` — character scoping, grouping, the rows themselves.
 * What lives here is the argument handling and the response shape.
 */

import { parseTimeBound } from "./history.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

/** One grouped row from the ledger. */
export interface ModelHistoryRow {
  model: string;
  provider: string;
  call_type: string;
  first_ts: string;
  last_ts: string;
  call_count: number;
}

/** The ledger query this tool is a thin shell over. */
export type ModelHistoryQuery = (
  character: string,
  since: string | undefined,
  until: string | undefined,
) => Promise<ModelHistoryRow[]>;

/**
 * Voice attribution for a ledger call type.
 *
 * `tool_loop` is genuinely mixed — chat tool-loop continuations and delegated
 * sub-agent continuations share the tag — so rows keep their raw `call_type`
 * and this is advisory. Anything unrecognised is `background`, which is why
 * historical rows for deleted features (`dreaming`) still classify.
 */
export function kindFor(callType: string): string {
  switch (callType) {
    case "message":
    case "tool_loop":
      return "interactive";
    case "heartbeat":
    case "heartbeat_tool_loop":
      return "autonomous";
    default:
      return "background";
  }
}

/**
 * A bound rebased to UTC, spelled the way chrono's `to_rfc3339` spells it.
 *
 * Ledger timestamps are stored as RFC3339 in UTC and the query compares them
 * **lexicographically**, so a bound left at `+10:00` would sort as though its
 * wall-clock reading were UTC and silently select the wrong window.
 *
 * Two spellings matter and neither is what `Date.toISOString()` produces:
 *
 * - UTC is written `+00:00`, not `Z`.
 * - Sub-second precision is preserved at chrono's `AutoSi` widths — 0, 3, 6 or
 *   9 digits. `Date` cannot hold nanoseconds at all, so the fraction is carried
 *   through as text rather than round-tripped through a timestamp. Offsets are
 *   always whole minutes, so rebasing never disturbs it.
 */
export function utcBound(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const bound = parseTimeBound(input, field);
  if (bound === undefined) return undefined;

  // `parseTimeBound` already normalized the fraction and the offset spelling,
  // and kept the caller's offset. Split that apart and shift it to UTC.
  const m = /^(.+?)([+-]\d{2}:\d{2})$/.exec(bound.rfc3339);
  if (m === null) return bound.rfc3339;
  const [, localPart, offset] = m as unknown as [string, string, string];

  if (offset === "+00:00") return bound.rfc3339;

  const dot = localPart.indexOf(".");
  const secondsPart = dot === -1 ? localPart : localPart.slice(0, dot);
  const fraction = dot === -1 ? "" : localPart.slice(dot);

  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes =
    sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));

  // Read the wall-clock reading as if it were UTC, then subtract the offset to
  // get the true UTC instant. Millisecond granularity is enough: the fraction
  // is reattached verbatim below.
  const asIfUtc = Date.parse(`${secondsPart}Z`);
  const shifted = new Date(asIfUtc - offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

export interface ModelHistoryResult {
  character: string;
  time_range: {
    start_time: string | undefined;
    end_time: string | undefined;
    inclusive: boolean;
  };
  models: {
    model: string;
    provider: string;
    call_type: string;
    kind: string;
    first_seen: string;
    last_seen: string;
    calls: number;
  }[];
  count: number;
}

/**
 * Handle `model_history`.
 *
 * A context with no ledger reports `io:`, not "not implemented" — the latter is
 * reserved for tool names that reached dispatch without an arm, and confusing
 * the two tells the model to stop asking for a tool that merely happens to be
 * unavailable on this path.
 */
export async function handleModelHistory(
  input: Record<string, unknown>,
  character: string,
  query: ModelHistoryQuery | undefined,
): Promise<ModelHistoryResult> {
  if (query === undefined) {
    throw new ToolIoError("the usage ledger is not available in this context");
  }
  if (character === "") {
    throw new InvalidArgs("model history is not configured");
  }

  const since = utcBound(input, "start_time");
  const until = utcBound(input, "end_time");
  // Both are UTC and RFC3339 by here, so a string compare is a time compare.
  if (since !== undefined && until !== undefined && since > until) {
    throw new InvalidArgs("start_time must be before or equal to end_time");
  }

  const rows = await query(character, since, until);
  const models = rows.map((row) => ({
    model: row.model,
    provider: row.provider,
    call_type: row.call_type,
    kind: kindFor(row.call_type),
    first_seen: row.first_ts,
    last_seen: row.last_ts,
    calls: row.call_count,
  }));

  return {
    character,
    time_range: { start_time: since, end_time: until, inclusive: true },
    models,
    count: models.length,
  };
}
