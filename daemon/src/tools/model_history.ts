import { hostZone, normalizeToZone } from "../ledger/zoned.ts";
import { parseTimeBound } from "./history.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

interface ModelHistoryRow {
  model: string;
  provider: string;
  call_type: string;
  first_ts: string;
  last_ts: string;
  call_count: number;
}

export type ModelHistoryQuery = (
  character: string,
  since: string | undefined,
  until: string | undefined,
) => Promise<ModelHistoryRow[]>;

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

export function utcBound(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const bound = parseTimeBound(input, field);
  if (bound === undefined) return undefined;

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

  const asIfUtc = Date.parse(`${secondsPart}Z`);
  const shifted = new Date(asIfUtc - offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

export interface ModelHistoryResult {
  character: string;
  time_zone: string;
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

export async function handleModelHistory(
  input: Record<string, unknown>,
  character: string,
  query: ModelHistoryQuery | undefined,
  timeZone: string = hostZone(),
): Promise<ModelHistoryResult> {
  if (query === undefined) {
    throw new ToolIoError("the usage ledger is not available in this context");
  }
  if (character === "") {
    throw new InvalidArgs("model history is not configured");
  }

  const since = utcBound(input, "start_time");
  const until = utcBound(input, "end_time");
  if (since !== undefined && until !== undefined && since > until) {
    throw new InvalidArgs("start_time must be before or equal to end_time");
  }

  const rows = await query(character, since, until);
  const models = rows.map((row) => ({
    model: row.model,
    provider: row.provider,
    call_type: row.call_type,
    kind: kindFor(row.call_type),
    first_seen: normalizeToZone(row.first_ts, timeZone),
    last_seen: normalizeToZone(row.last_ts, timeZone),
    calls: row.call_count,
  }));

  return {
    character,
    time_zone: timeZone,
    time_range: {
      start_time: since === undefined ? undefined : normalizeToZone(since, timeZone),
      end_time: until === undefined ? undefined : normalizeToZone(until, timeZone),
      inclusive: true,
    },
    models,
    count: models.length,
  };
}
