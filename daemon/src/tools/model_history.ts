import { hostZone, normalizeToZone } from "../ledger/zoned.ts";
import { parseTimeBound } from "./history.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

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
    case "wake":
    case "wake_tool_loop":
      return "autonomous";
    default:
      return "background";
  }
}

const TO_THE_SECOND = 19;

const OFFSET = 6;

export function utcBound(
  texts: Texts,
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const bound = parseTimeBound(texts, input, field);
  if (bound === undefined) return undefined;
  const fraction = bound.rfc3339.slice(TO_THE_SECOND, -OFFSET);
  return `${new Date(Math.floor(bound.ms / 1000) * 1000).toISOString().slice(0, TO_THE_SECOND)}${fraction}+00:00`;
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
  texts: Texts,
  input: Record<string, unknown>,
  character: string,
  query: ModelHistoryQuery | undefined,
  timeZone: string = hostZone(),
): Promise<ModelHistoryResult> {
  if (query === undefined) {
    throw new ToolIoError(texts.always("history_ledger_unavailable"));
  }
  if (character === "") {
    throw new InvalidArgs(texts.always("history_not_configured"));
  }

  const since = utcBound(texts, input, "start_time");
  const until = utcBound(texts, input, "end_time");
  if (since !== undefined && until !== undefined && since > until) {
    throw new InvalidArgs(texts.always("history_range_backwards"));
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
