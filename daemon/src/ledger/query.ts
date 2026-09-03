import type { Database } from "bun:sqlite";

import type { CostBreakdown } from "./pricing.ts";
import type { CallRow } from "./store.ts";

export interface QueryFilter {
  since?: string | undefined;
  until?: string | undefined;
  character?: string | undefined;
  provider?: string | undefined;
  api_key_name?: string | undefined;
  model?: string | undefined;
  call_type?: string | undefined;
  usage_kinds?: string[] | undefined;
}

const USAGE_KIND_EXPR = `CASE
    WHEN call_type = 'heartbeat_tool_loop' THEN 'heartbeat'
    WHEN call_type = 'message' AND finish_reason = 'tool_use' THEN 'message_with_tools'
    WHEN call_type = 'tool_loop' THEN 'message_with_tools'
    WHEN call_type = 'message' THEN 'message_no_tools'
    ELSE call_type
END`;

type Bindable = string | number;

function buildWhere(filter: QueryFilter): {
  where: string;
  values: Bindable[];
} {
  const clauses: string[] = [];
  const values: Bindable[] = [];

  const eq = (column: string, v: string | undefined) => {
    if (v === undefined) {
      return;
    }
    values.push(v);
    clauses.push(`${column} = ?${values.length}`);
  };

  if (filter.since !== undefined) {
    values.push(filter.since);
    clauses.push(`ts >= ?${values.length}`);
  }
  if (filter.until !== undefined) {
    values.push(filter.until);
    clauses.push(`ts <= ?${values.length}`);
  }
  eq("character", filter.character);
  eq("provider", filter.provider);
  eq("COALESCE(api_key_name, 'unknown')", filter.api_key_name);
  eq("model", filter.model);
  eq("call_type", filter.call_type);

  if (filter.usage_kinds !== undefined && filter.usage_kinds.length > 0) {
    const placeholders = filter.usage_kinds.map((v) => {
      values.push(v);
      return `?${values.length}`;
    });
    clauses.push(`(${USAGE_KIND_EXPR}) IN (${placeholders.join(", ")})`);
  }

  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    values,
  };
}

function andWhere(where: string, condition: string): string {
  return where === "" ? ` WHERE ${condition}` : `${where} AND ${condition}`;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function cost(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optText(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rowFromSqlite(r: Record<string, unknown>): CallRow {
  return {
    ts: text(r["ts"]),
    character: text(r["character"]),
    provider: text(r["provider"]),
    api_key_name: optText(r["api_key_name"]),
    model: text(r["model"]),
    call_type: text(r["call_type"]),
    input_tokens: count(r["input_tokens"]),
    output_tokens: count(r["output_tokens"]),
    cache_read_tokens: count(r["cache_read_tokens"]),
    cache_write_tokens: count(r["cache_write_tokens"]),
    cache_ttl: optText(r["cache_ttl"]),
    reasoning_effort: optText(r["reasoning_effort"]),
    tool_surface: optText(r["tool_surface"]),
    total_ms: count(r["total_ms"]),
    ttft_ms: count(r["ttft_ms"]),
    finish_reason: text(r["finish_reason"]),
    thinking_enabled: r["thinking_enabled"] === 0 ? 0 : 1,
    cache_state: optText(r["cache_state"]),
    cache_anomaly: optText(r["cache_anomaly"]),
    input_cost: cost(r["input_cost"]),
    output_cost: cost(r["output_cost"]),
    cache_read_cost: cost(r["cache_read_cost"]),
    cache_write_cost: cost(r["cache_write_cost"]),
    cost_source: optText(r["cost_source"]),
    total_cost: cost(r["total_cost"]),
    output_tokens_estimated: r["output_tokens_estimated"] === 1 ? 1 : 0,
    thinking_dropped: count(r["thinking_dropped"]),
    cache_state_reason: optText(r["cache_state_reason"]),
  };
}

function rows(db: Database, sql: string, values: Bindable[]) {
  return db.query(sql).all(...values) as Record<string, unknown>[];
}

export interface UsageSummary {
  provider: string;
  model: string;
  call_count: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  total_cost: number;
}

export interface UsageTotals {
  call_count: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  total_cost: number;
}

const SUM_COLUMNS = `COUNT(*) as call_count,
                  SUM(input_tokens) as total_input,
                  SUM(output_tokens) as total_output,
                  SUM(cache_read_tokens) as total_cache_read,
                  SUM(cache_write_tokens) as total_cache_write,
                  TOTAL(total_cost) as total_cost`;

function totalsFrom(r: Record<string, unknown>): UsageTotals {
  return {
    call_count: count(r["call_count"]),
    total_input: count(r["total_input"]),
    total_output: count(r["total_output"]),
    total_cache_read: count(r["total_cache_read"]),
    total_cache_write: count(r["total_cache_write"]),
    total_cost: typeof r["total_cost"] === "number" ? r["total_cost"] : 0,
  };
}

export function usageTotals(db: Database, filter: QueryFilter): UsageTotals {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT COUNT(*) as call_count,
                  COALESCE(SUM(input_tokens), 0) as total_input,
                  COALESCE(SUM(output_tokens), 0) as total_output,
                  COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
                  COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM calls
             ${where}`;
  const row = db.query(sql).get(...values) as Record<string, unknown> | null;
  return row === null
    ? {
        call_count: 0,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        total_cost: 0,
      }
    : totalsFrom(row);
}

export interface UsageCostEntry {
  ts: string;
  total_cost: number;
}

export function usageCostEntries(
  db: Database,
  filter: QueryFilter,
): UsageCostEntry[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT ts, COALESCE(total_cost, 0) AS total_cost
                 FROM calls
                 ${where}
                ORDER BY ts ASC`;
  return rows(db, sql, values).map((r) => ({
    ts: text(r["ts"]),
    total_cost: cost(r["total_cost"]) ?? 0,
  }));
}

export function usageSummary(
  db: Database,
  filter: QueryFilter,
): UsageSummary[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT provider, model,
                  ${SUM_COLUMNS}
             FROM calls
             ${where}
            GROUP BY provider, model
            ORDER BY total_cost DESC`;
  return rows(db, sql, values).map((r) => ({
    provider: text(r["provider"]),
    model: text(r["model"]),
    ...totalsFrom(r),
  }));
}

export interface CostSourceTotals {
  cost_source: string;
  calls: number;
  unpriced_calls: number;
  total_cost: number;
}

export function costSourceTotals(db: Database, filter: QueryFilter): CostSourceTotals[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT COALESCE(cost_source, 'unknown') AS source,
                      COUNT(*) AS calls,
                      COALESCE(SUM(CASE WHEN total_cost IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
                      TOTAL(total_cost) AS total_cost
                 FROM calls
                 ${where}
                GROUP BY source
                ORDER BY total_cost DESC, calls DESC, source ASC`;
  return rows(db, sql, values).map((r) => ({
    cost_source: text(r["source"]),
    calls: count(r["calls"]),
    unpriced_calls: count(r["unpriced"]),
    total_cost: typeof r["total_cost"] === "number" ? r["total_cost"] : 0,
  }));
}

export interface AnomalyCount {
  anomaly: string;
  calls: number;
  cache_write_tokens: number;
}

export function anomalyCounts(db: Database, filter: QueryFilter): AnomalyCount[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT cache_anomaly AS anomaly, COUNT(*) AS calls,
                      COALESCE(SUM(cache_write_tokens), 0) AS writes
                 FROM calls${andWhere(where, "cache_anomaly IS NOT NULL")}
                GROUP BY cache_anomaly
                ORDER BY calls DESC`;
  return rows(db, sql, values).map((r) => ({
    anomaly: text(r["anomaly"]),
    calls: count(r["calls"]),
    cache_write_tokens: count(r["writes"]),
  }));
}

export interface CacheCoverage {
  state: string;
  reason: string | null;
  calls: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function cacheCoverage(db: Database, filter: QueryFilter): CacheCoverage[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT COALESCE(cache_state, 'unclassified') AS state,
                      cache_state_reason AS reason,
                      COUNT(*) AS calls,
                      COALESCE(SUM(cache_read_tokens), 0) AS reads,
                      COALESCE(SUM(cache_write_tokens), 0) AS writes
                 FROM calls
                 ${where}
                GROUP BY state, reason
                ORDER BY calls DESC`;
  return rows(db, sql, values).map((r) => ({
    state: text(r["state"]),
    reason: optText(r["reason"]),
    calls: count(r["calls"]),
    cache_read_tokens: count(r["reads"]),
    cache_write_tokens: count(r["writes"]),
  }));
}

export type UsageDimension =
  | "model"
  | "provider"
  | "call_type"
  | "kind"
  | "api_key"
  | "cost_source";

export interface GroupedUsage extends UsageTotals {
  group: string;
}

const DIMENSION_EXPR: Record<UsageDimension, string> = {
  model: "provider || ' ' || model",
  provider: "provider",
  call_type: "call_type",
  kind: USAGE_KIND_EXPR,
  api_key: "provider || ' ' || COALESCE(api_key_name, 'unknown')",
  cost_source: "COALESCE(cost_source, 'unknown')",
};

export function isUsageDimension(value: string): value is UsageDimension {
  return Object.hasOwn(DIMENSION_EXPR, value);
}

export const USAGE_DIMENSIONS = Object.keys(DIMENSION_EXPR) as UsageDimension[];

export function usageSummaryBy(
  db: Database,
  filter: QueryFilter,
  dimension: UsageDimension,
): GroupedUsage[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT grp,
                  ${SUM_COLUMNS}
             FROM (
                 SELECT ${DIMENSION_EXPR[dimension]} as grp,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_write_tokens, total_cost
                   FROM calls
                  ${where}
             )
            GROUP BY grp
            ORDER BY total_cost DESC, call_count DESC, grp ASC`;
  return rows(db, sql, values).map((r) => ({
    group: text(r["grp"]),
    ...totalsFrom(r),
  }));
}

export interface ModelUsageRow {
  model: string;
  provider: string;
  call_type: string;
  first_ts: string;
  last_ts: string;
  call_count: number;
}

export function modelUsageSummary(
  db: Database,
  filter: QueryFilter,
): ModelUsageRow[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT model,
                  provider,
                  call_type,
                  MIN(ts) as first_ts,
                  MAX(ts) as last_ts,
                  COUNT(*) as call_count
             FROM calls
             ${where}
            GROUP BY model, provider, call_type
            ORDER BY first_ts ASC`;
  return rows(db, sql, values).map((r) => ({
    model: text(r["model"]),
    provider: text(r["provider"]),
    call_type: text(r["call_type"]),
    first_ts: text(r["first_ts"]),
    last_ts: text(r["last_ts"]),
    call_count: count(r["call_count"]),
  }));
}

export function queryAnomalies(
  db: Database,
  filter: QueryFilter,
): CallRow[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT * FROM calls${andWhere(where, "cache_anomaly IS NOT NULL")} ORDER BY id DESC`;
  return rows(db, sql, values).map(rowFromSqlite);
}

const TSV_HEADER =
  "ts\tcharacter\tprovider\tapi_key_name\tmodel\tcall_type\t" +
  "input_tokens\toutput_tokens\tcache_read_tokens\tcache_write_tokens\tcache_ttl\treasoning_effort\t" +
  "tool_surface\t" +
  "total_ms\tttft_ms\tfinish_reason\tthinking_enabled\t" +
  "cache_state\tcache_anomaly\t" +
  "input_cost\toutput_cost\tcache_read_cost\tcache_write_cost\tcost_source\ttotal_cost";

const optStr = (v: string | null): string => v ?? "";

function tsvNumber(v: number | null): string {
  if (v === null) {
    return "";
  }
  const s = String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (m === null) {
    return s;
  }
  const [, sign = "", intPart = "", fracPart = "", expStr = "0"] = m;
  const digits = intPart + fracPart;
  const pointPos = intPart.length + Number(expStr);
  if (pointPos <= 0) {
    return `${sign}0.${"0".repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointPos - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

function rowToTsv(r: CallRow): string {
  return [
    r.ts,
    r.character,
    r.provider,
    optStr(r.api_key_name),
    r.model,
    r.call_type,
    r.input_tokens,
    r.output_tokens,
    r.cache_read_tokens,
    r.cache_write_tokens,
    optStr(r.cache_ttl),
    optStr(r.reasoning_effort),
    optStr(r.tool_surface),
    r.total_ms,
    r.ttft_ms,
    r.finish_reason,
    r.thinking_enabled === 0 ? "false" : "true",
    optStr(r.cache_state),
    optStr(r.cache_anomaly),
    tsvNumber(r.input_cost),
    tsvNumber(r.output_cost),
    tsvNumber(r.cache_read_cost),
    tsvNumber(r.cache_write_cost),
    optStr(r.cost_source),
    tsvNumber(r.total_cost),
  ].join("\t");
}

export function exportTsv(db: Database, filter: QueryFilter): string {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT * FROM calls${where} ORDER BY id ASC`;
  let out = TSV_HEADER;
  for (const r of rows(db, sql, values)) {
    out += `\n${rowToTsv(rowFromSqlite(r))}`;
  }
  return out;
}

export function activeAnthropicCharacters(
  db: Database,
  filter: QueryFilter,
): [string, CallRow][] {
  const { where, values } = buildWhere(filter);
  const providerCond = andWhere(
    where,
    "(provider = 'anthropic' OR model LIKE 'anthropic/%')",
  );
  const sql = `SELECT c.* FROM calls c
           INNER JOIN (
               SELECT character, MAX(id) as max_id
               FROM calls
               ${providerCond}
               GROUP BY character
           ) latest ON c.id = latest.max_id
           ORDER BY c.id DESC`;
  return rows(db, sql, values).map((r) => {
    const call = rowFromSqlite(r);
    return [call.character, call];
  });
}

export function warmStreak(db: Database, character: string): number {
  const sql =
    "SELECT cache_state FROM calls WHERE character = ?1 ORDER BY id DESC LIMIT 10000";
  let streak = 0;
  for (const r of rows(db, sql, [character])) {
    if (r["cache_state"] !== "warm") {
      break;
    }
    streak += 1;
  }
  return streak;
}

export interface CostRow {
  id: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_ttl: string | null;
}

const COST_ROW_COLUMNS =
  "id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_ttl";

function costRowFrom(r: Record<string, unknown>): CostRow {
  return {
    id: count(r["id"]),
    provider: text(r["provider"]),
    model: text(r["model"]),
    input_tokens: count(r["input_tokens"]),
    output_tokens: count(r["output_tokens"]),
    cache_read_tokens: count(r["cache_read_tokens"]),
    cache_write_tokens: count(r["cache_write_tokens"]),
    cache_ttl: optText(r["cache_ttl"]),
  };
}

export function nullCostRows(db: Database): CostRow[] {
  const sql = `SELECT ${COST_ROW_COLUMNS} FROM calls WHERE total_cost IS NULL`;
  return rows(db, sql, []).map(costRowFrom);
}

export function allCostRows(db: Database): CostRow[] {
  const sql = `SELECT ${COST_ROW_COLUMNS} \
FROM calls \
WHERE COALESCE(cost_source, 'pricing_catalog') NOT IN ('provider_reported', 'subscription')`;
  return rows(db, sql, []).map(costRowFrom);
}

export function updateCosts(
  db: Database,
  id: number,
  breakdown: CostBreakdown,
): void {
  db.query(
    "UPDATE calls SET input_cost=?1, output_cost=?2, cache_read_cost=?3, cache_write_cost=?4, cost_source='pricing_catalog', total_cost=?5 WHERE id=?6",
  ).run(
    breakdown.input,
    breakdown.output,
    breakdown.cache_read,
    breakdown.cache_write,
    breakdown.total,
    id,
  );
}

export const RECENT_COST_SAMPLE = 20;

export function recentCallCost(
  db: Database,
  provider: string,
  model: string,
  callType: string,
): number | undefined {
  const row = db
    .query(
      `SELECT AVG(total_cost) as mean FROM (
         SELECT total_cost FROM calls
          WHERE provider = ?1 AND model = ?2 AND call_type = ?3
            AND total_cost IS NOT NULL AND total_cost > 0
          ORDER BY id DESC LIMIT ?4
       )`,
    )
    .get(provider, model, callType, RECENT_COST_SAMPLE) as { mean: number | null } | null;
  const mean = row?.mean;
  return typeof mean === "number" && mean > 0 ? mean : undefined;
}
