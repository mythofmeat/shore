/**
 * Aggregation and filter queries over `ledger.db`.
 *
 * Ported from `crates/daemon/src/ledger/query.rs`. The SQL is kept
 * character-for-character where it can be, because these queries are the
 * definition of what `shore usage` reports and what a usage budget counts —
 * a subtly different `WHERE` is a subtly different bill.
 *
 * Two deliberate departures from the Rust:
 *
 *   - **No `with_conn`.** Rust wraps every query in a mutex because the daemon
 *     is multi-threaded. This process is single-threaded per handle, so the
 *     functions take a `Database` directly. That also collapses Rust's
 *     `usage_totals` / `usage_totals_on` pair — the `_on` variant exists only so
 *     a caller running several totals can take the lock once, which is not a
 *     distinction here.
 *   - **Reads clamp, they do not throw.** Mirrors `ledger/convert.rs`: SQLite
 *     stores every integer as i64, and a negative or oversized count in a
 *     non-negative column is corruption, for which `0` is the only sensible
 *     reading.
 */

import type { Database } from "bun:sqlite";

import type { CostBreakdown } from "./pricing.ts";
import type { CallRow } from "./store.ts";

// ── Filter ───────────────────────────────────────────────────────────────────

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

/**
 * Raw `call_type` collapsed into the product-level kind `shore usage` reports.
 * A `message` that stopped at `tool_use` is the first leg of a tool loop, so it
 * counts as message-with-tools alongside the `tool_loop` rows that follow it.
 */
const USAGE_KIND_EXPR = `CASE
    WHEN call_type = 'heartbeat_tool_loop' THEN 'heartbeat'
    WHEN call_type = 'message' AND finish_reason = 'tool_use' THEN 'message_with_tools'
    WHEN call_type = 'tool_loop' THEN 'message_with_tools'
    WHEN call_type = 'message' THEN 'message_no_tools'
    ELSE call_type
END`;

type Bindable = string | number;

/** WHERE clause fragments and their bound values, or an empty clause. */
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

/** Append a condition to whatever `buildWhere` produced. */
function andWhere(where: string, condition: string): string {
  return where === "" ? ` WHERE ${condition}` : `${where} AND ${condition}`;
}

// ── SQLite read boundary ─────────────────────────────────────────────────────

/** Read a count column, clamping anything outside the non-negative domain to 0. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Read a nullable REAL cost column. */
function cost(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optText(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Map a `SELECT *` row to a {@link CallRow}, by column name rather than
 * position. Migrations append columns to the end of the table on existing
 * databases, which makes positional indexing return the wrong column on
 * migrated rows — the same reason Rust's `row_from_sqlite` uses names.
 */
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
  };
}

function rows(db: Database, sql: string, values: Bindable[]) {
  return db.query(sql).all(...values) as Record<string, unknown>[];
}

// ── Summary ──────────────────────────────────────────────────────────────────

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

/** The aggregate columns every summary query selects, in one place. */
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
    // `TOTAL()` returns 0.0 rather than NULL over an empty set, unlike `SUM()`.
    total_cost: typeof r["total_cost"] === "number" ? r["total_cost"] : 0,
  };
}

/** Sums calls matching the filter without grouping. */
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

/**
 * Groups calls by provider + model, sums token counts and cost.
 * Orders by total_cost DESC (nulls last).
 */
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

// ── Summary by call type ─────────────────────────────────────────────────────

export interface CallTypeSummary extends UsageTotals {
  call_type: string;
}

/** Groups calls by `call_type`. Ordered by total_cost DESC, then call_count DESC. */
export function usageSummaryByCallType(
  db: Database,
  filter: QueryFilter,
): CallTypeSummary[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT call_type,
                  ${SUM_COLUMNS}
             FROM calls
             ${where}
            GROUP BY call_type
            ORDER BY total_cost DESC, call_count DESC`;
  return rows(db, sql, values).map((r) => ({
    call_type: text(r["call_type"]),
    ...totalsFrom(r),
  }));
}

// ── Model usage history ──────────────────────────────────────────────────────

export interface ModelUsageRow {
  model: string;
  provider: string;
  call_type: string;
  first_ts: string;
  last_ts: string;
  call_count: number;
}

/**
 * Per-(model, provider, call_type) usage over the filtered window: first and
 * last call timestamps plus call count, ordered by first appearance. Backs the
 * `model_history` character tool ("which models generated my words, and when").
 */
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

// ── Summary by usage kind ────────────────────────────────────────────────────

export interface UsageKindSummary extends UsageTotals {
  usage_kind: string;
}

/**
 * Groups calls by a higher-level usage kind. This keeps raw call types
 * available while surfacing product concepts such as message-with-tools.
 */
export function usageSummaryByUsageKind(
  db: Database,
  filter: QueryFilter,
): UsageKindSummary[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT usage_kind,
                  ${SUM_COLUMNS}
             FROM (
                 SELECT ${USAGE_KIND_EXPR} as usage_kind,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_write_tokens, total_cost
                   FROM calls
                  ${where}
             )
            GROUP BY usage_kind
            ORDER BY total_cost DESC, call_count DESC`;
  return rows(db, sql, values).map((r) => ({
    usage_kind: text(r["usage_kind"]),
    ...totalsFrom(r),
  }));
}

// ── Summary by API key ───────────────────────────────────────────────────────

export interface ApiKeySummary extends UsageTotals {
  provider: string;
  api_key_name: string;
}

/** Groups calls by provider + friendly configured API key name. */
export function usageSummaryByApiKey(
  db: Database,
  filter: QueryFilter,
): ApiKeySummary[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT provider,
                  COALESCE(api_key_name, 'unknown') as api_key_name,
                  ${SUM_COLUMNS}
             FROM calls
             ${where}
            GROUP BY provider, COALESCE(api_key_name, 'unknown')
            ORDER BY total_cost DESC, call_count DESC`;
  return rows(db, sql, values).map((r) => ({
    provider: text(r["provider"]),
    api_key_name: text(r["api_key_name"]),
    ...totalsFrom(r),
  }));
}

// ── Anomalies ────────────────────────────────────────────────────────────────

/** Rows where `cache_anomaly IS NOT NULL`, ordered by id DESC. */
export function queryAnomalies(
  db: Database,
  filter: QueryFilter,
): CallRow[] {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT * FROM calls${andWhere(where, "cache_anomaly IS NOT NULL")} ORDER BY id DESC`;
  return rows(db, sql, values).map(rowFromSqlite);
}

// ── TSV export ───────────────────────────────────────────────────────────────

const TSV_HEADER =
  "ts\tcharacter\tprovider\tapi_key_name\tmodel\tcall_type\t" +
  "input_tokens\toutput_tokens\tcache_read_tokens\tcache_write_tokens\tcache_ttl\treasoning_effort\t" +
  "total_ms\tttft_ms\tfinish_reason\tthinking_enabled\t" +
  "cache_state\tcache_anomaly\t" +
  "input_cost\toutput_cost\tcache_read_cost\tcache_write_cost\tcost_source\ttotal_cost";

const optStr = (v: string | null): string => v ?? "";

/**
 * Render a cost the way Rust's `f64::to_string` does.
 *
 * Both runtimes emit the *shortest* digits that round-trip, so `String(v)`
 * already agrees with Rust on the digits — `0.01` is `0.01` in both, and
 * reaching for `toFixed` instead would print `0.01000000000000000021`.
 *
 * They part company only on notation: Rust's `Display` is always positional,
 * while JavaScript switches to exponent form below 1e-6 and at/above 1e21. A
 * heartbeat costing 1.5e-7 is well inside that range, so expand the exponent
 * back to positional and keep the digits untouched.
 */
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
    r.total_ms,
    r.ttft_ms,
    r.finish_reason,
    // Rust renders `bool` as `true`/`false`; the column is stored as 0/1.
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

/** Tab-separated header + all matching rows (all 24 CallRow columns). */
export function exportTsv(db: Database, filter: QueryFilter): string {
  const { where, values } = buildWhere(filter);
  const sql = `SELECT * FROM calls${where} ORDER BY id ASC`;
  let out = TSV_HEADER;
  for (const r of rows(db, sql, values)) {
    out += `\n${rowToTsv(rowFromSqlite(r))}`;
  }
  return out;
}

// ── Active Anthropic characters ──────────────────────────────────────────────

/**
 * Distinct characters with recent Anthropic calls, paired with their last call
 * row. Backs the cache health display.
 */
export function activeAnthropicCharacters(
  db: Database,
  filter: QueryFilter,
): [string, CallRow][] {
  const { where, values } = buildWhere(filter);
  // Match either native anthropic or OpenRouter-routed anthropic (model_id
  // resolved to `anthropic/...` regardless of the custom provider key).
  // Mirrors `isAnthropicPricing` in pricing.ts.
  const providerCond = andWhere(
    where,
    "(provider = 'anthropic' OR model LIKE 'anthropic/%')",
  );
  // Subquery: for each character, find the max id among matching Anthropic rows.
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

// ── Warm streak ──────────────────────────────────────────────────────────────

/**
 * Consecutive warm calls counting back from the most recent for `character`.
 * Bounded so a high-volume character cannot load unbounded rows.
 */
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

// ── Recalculate ──────────────────────────────────────────────────────────────

/** A row whose cost may need recomputing from the pricing catalog. */
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

/** Rows with NULL total_cost. */
export function nullCostRows(db: Database): CostRow[] {
  const sql = `SELECT ${COST_ROW_COLUMNS} FROM calls WHERE total_cost IS NULL`;
  return rows(db, sql, []).map(costRowFrom);
}

/**
 * Every repriceable row, for a forced recalculation.
 *
 * `provider_reported` rows carry the provider's own total, and `subscription`
 * rows are billed by a flat plan — repricing either from the catalog would
 * replace a true cost with an invented one. The subscription exclusion is not
 * belt-and-braces: {@link updateCosts} unconditionally rewrites `cost_source`
 * to `pricing_catalog` and sets a non-zero total, so a subscription row that
 * priced would start accruing against usage budgets. Nothing catches it today
 * only because `opencode-go/<model>` is never in OpenRouter's catalog, which is
 * luck, not a rule. The rule itself lives in `store.ts`, which writes the marker.
 */
export function allCostRows(db: Database): CostRow[] {
  const sql = `SELECT ${COST_ROW_COLUMNS} \
FROM calls \
WHERE COALESCE(cost_source, 'pricing_catalog') NOT IN ('provider_reported', 'subscription')`;
  return rows(db, sql, []).map(costRowFrom);
}

/** Update costs for a single row by id. */
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
