import type { Database } from "bun:sqlite";

import {
  budgetStatuses,
  newlyCrossedBudgetWarnings,
  type BudgetOptions,
  type UsageConfig,
} from "./budget.ts";
import { reconstructState } from "../cache/tracker.ts";
import { toOpenRouterId, type PricingEngine } from "./pricing.ts";
import {
  activeAnthropicCharacters,
  allCostRows,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  queryAnomalies,
  updateCosts,
  usageSummary,
  usageSummaryByApiKey,
  usageSummaryByCallType,
  usageSummaryByUsageKind,
  warmStreak,
  type QueryFilter,
} from "./query.ts";
import { ledgerFor } from "./record.ts";
import type { Ledger } from "./store.ts";
import {
  daysFromMonday,
  DAY_MS,
  HOUR_MS,
  naiveFrom,
  naiveInZone,
  partsOf,
  resolveInZone,
  toRfc3339,
  zoneFor,
  asNaive,
  type Naive,
} from "./zoned.ts";

const CACHE_HEALTH_TTL_SECS = 3600;

const ANOMALY_LOOKBACK = "7d";

export interface UsageRequest {
  ledger: string;
  args?: Record<string, unknown> | undefined;
  usage?: UsageConfig | undefined;
}

export interface UsageOptions extends BudgetOptions {
  now?: number;
}

type CalendarWindow = "day" | "week" | "month";

function calendarStartNaive(naive: Naive, window: CalendarWindow): Naive {
  const { year, month, day } = partsOf(naive);
  const midnight = naiveFrom(year, month, day, 0);
  switch (window) {
    case "day":
      return midnight;
    case "week":
      return asNaive(midnight - daysFromMonday(naive) * DAY_MS);
    case "month":
      return naiveFrom(year, month, 1, 0);
  }
}

function calendarStart(
  now: number,
  window: CalendarWindow,
  timezone: string,
  opts: UsageOptions,
): number {
  const zone = zoneFor(timezone, opts.localZone);
  return resolveInZone(calendarStartNaive(naiveInZone(now, zone), window), zone);
}

function trimEnd(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) {
    end -= 1;
  }
  return s.slice(0, end);
}

function parseI64(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) {
    return undefined;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

const RELATIVE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["h", HOUR_MS],
  ["d", DAY_MS],
  ["w", 7 * DAY_MS],
];

export function parseLastPeriod(
  last: string,
  now: number,
  timezone: string,
  opts: UsageOptions = {},
): string | undefined {
  switch (last) {
    case "today":
      return toRfc3339(calendarStart(now, "day", timezone, opts));
    case "week":
    case "this_week":
      return toRfc3339(calendarStart(now, "week", timezone, opts));
    case "month":
    case "this_month":
      return toRfc3339(calendarStart(now, "month", timezone, opts));
    case "all":
      return undefined;
    default:
      break;
  }
  for (const [suffix, unitMs] of RELATIVE_UNITS) {
    if (!last.endsWith(suffix)) {
      continue;
    }
    const count = parseI64(trimEnd(last, suffix));
    if (count === undefined) {
      return undefined;
    }
    const at = now - count * unitMs;
    return Number.isFinite(at) ? toRfc3339(at) : undefined;
  }
  return undefined;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function flag(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function buildFilter(
  args: Record<string, unknown>,
  timezone: string,
  opts: UsageOptions,
  now: number,
): { filter: QueryFilter; last: string } {
  const last = str(args, "last") ?? "today";
  return {
    filter: {
      since: parseLastPeriod(last, now, timezone, opts),
      character: str(args, "character"),
      provider: str(args, "provider"),
      api_key_name: str(args, "api_key"),
      model: str(args, "model"),
      call_type: str(args, "call_type"),
    },
    last,
  };
}

export async function usageReport(
  request: UsageRequest,
  opts: UsageOptions = {},
): Promise<unknown> {
  const ledger = openOrThrow(request.ledger);
  const db = ledger.database;
  const args = request.args ?? {};
  const config = request.usage ?? {};
  const now = opts.now ?? Date.now();
  const timezone = config.timezone ?? "local";
  const { filter, last } = buildFilter(args, timezone, opts, now);

  if (flag(args, "budget")) {
    return budgetPayload(db, config, now, opts);
  }
  if (flag(args, "export_tsv")) {
    return { mode: "tsv", data: exportTsv(db, filter) };
  }
  if (flag(args, "export_csv")) {
    return { mode: "csv", data: tsvToCsv(exportTsv(db, filter)) };
  }
  if (flag(args, "by_kind")) {
    return {
      mode: "summary_by_usage_kind",
      period: last,
      summary: usageSummaryByUsageKind(db, filter),
    };
  }
  if (flag(args, "by_api_key")) {
    return {
      mode: "summary_by_api_key",
      period: last,
      summary: usageSummaryByApiKey(db, filter),
    };
  }
  if (flag(args, "by_call_type")) {
    return {
      mode: "summary_by_call_type",
      period: last,
      summary: usageSummaryByCallType(db, filter),
    };
  }
  if (flag(args, "anomalies")) {
    return anomaliesPayload(db, filter, last, timezone, opts, now);
  }
  if (flag(args, "refresh_pricing")) {
    return { mode: "refresh_pricing" };
  }
  if (flag(args, "recalculate")) {
    return recalculate(db, ledger.pricing, flag(args, "force"));
  }

  return summaryPayload(db, config, filter, last, timezone, opts, now);
}

function budgetPayload(
  db: Database,
  config: UsageConfig,
  now: number,
  opts: UsageOptions,
): unknown {
  return {
    mode: "budget",
    timezone: config.timezone ?? "local",
    allow_compaction_over_budget: config.allow_compaction_over_budget ?? false,
    budgets: budgetStatuses(db, config, now, opts),
    call_attempts: callAttemptStatus(db),
  };
}

function tsvToCsv(tsv: string): string {
  return tsv
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((f) =>
          /[",\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f,
        )
        .join(","),
    )
    .join("\n");
}

function anomaliesPayload(
  db: Database,
  filter: QueryFilter,
  last: string,
  timezone: string,
  opts: UsageOptions,
  now: number,
): unknown {
  const anomalyFilter: QueryFilter =
    last === "today"
      ? { ...filter, since: parseLastPeriod(ANOMALY_LOOKBACK, now, timezone, opts) }
      : filter;
  return {
    mode: "anomalies",
    anomalies: queryAnomalies(db, anomalyFilter).map((r) => ({
      ts: r.ts,
      character: r.character,
      model: r.model,
      call_type: r.call_type,
      anomaly: r.cache_anomaly,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
    })),
  };
}

function summaryPayload(
  db: Database,
  config: UsageConfig,
  filter: QueryFilter,
  last: string,
  timezone: string,
  opts: UsageOptions,
  now: number,
): unknown {
  const cacheHealth = activeAnthropicCharacters(db, filter).map(([character, lastRow]) => ({
    character,
    state: reconstructState(
      lastRow.ts,
      lastRow.cache_read_tokens,
      CACHE_HEALTH_TTL_SECS,
      now,
    ),
    streak: warmStreak(db, character),
  }));

  const anomalyFilter: QueryFilter = {
    since: parseLastPeriod(ANOMALY_LOOKBACK, now, timezone, opts),
  };

  return {
    mode: "summary",
    period: last,
    timezone,
    summary: usageSummary(db, filter),
    cache_health: cacheHealth,
    anomaly_count_7d: queryAnomalies(db, anomalyFilter).length,
    call_attempts: callAttemptStatus(db),
    budgets: budgetStatuses(db, config, now, opts),
  };
}

function callAttemptStatus(db: Database): {
  pending: number;
  unresolved: number;
  estimated_cost_at_risk: number;
} {
  const rows = db.query(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(estimated_cost), 0) AS estimated
       FROM call_attempts
      WHERE status IN ('pending', 'unresolved')
      GROUP BY status`,
  ).all() as Array<{ status: string; count: number; estimated: number }>;
  let pending = 0;
  let unresolved = 0;
  let estimated = 0;
  for (const row of rows) {
    if (row.status === "pending") pending += row.count;
    if (row.status === "unresolved") unresolved += row.count;
    estimated += row.estimated;
  }
  return { pending, unresolved, estimated_cost_at_risk: estimated };
}

async function recalculate(
  db: Database,
  pricing: PricingEngine,
  force: boolean,
): Promise<unknown> {
  const rows = force ? allCostRows(db) : nullCostRows(db);
  if (rows.length === 0) {
    return { mode: "recalculate", updated: 0, total: 0, failures: [] };
  }

  const fetched = new Map<string, string | undefined>();
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    if (fetched.has(key)) {
      continue;
    }
    const found = await pricing.getOrFetch(row.provider, row.model);
    if (found === undefined) {
      const modelId = toOpenRouterId(row.provider, row.model);
      console.warn(`shore: pricing fetch returned no data for ${modelId}`);
      fetched.set(key, `no pricing data for ${modelId}`);
    } else {
      fetched.set(key, undefined);
    }
  }

  let updated = 0;
  for (const row of rows) {
    const cost = pricing.cost({
      provider: row.provider,
      model: row.model,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      cache_ttl: row.cache_ttl ?? undefined,
    });
    if (cost === undefined) {
      continue;
    }
    try {
      updateCosts(db, row.id, cost);
      updated += 1;
    } catch (e) {
      console.warn(`shore: could not update costs for row ${row.id}: ${String(e)}`);
    }
  }

  const failures = [...fetched.entries()]
    .filter(([, reason]) => reason !== undefined)
    .map(([model, reason]) => ({ model, reason }));

  return { mode: "recalculate", updated, total: rows.length, failures };
}

export interface BudgetWarningsRequest {
  ledger: string;
  usage?: UsageConfig | undefined;
}

export function budgetWarnings(
  request: BudgetWarningsRequest,
  opts: UsageOptions = {},
): unknown {
  const config = request.usage ?? {};
  if ((config.budgets ?? []).length === 0) {
    return { warnings: [] };
  }
  const ledger = openOrThrow(request.ledger);
  return {
    warnings: newlyCrossedBudgetWarnings(
      ledger.database,
      config,
      opts.now ?? Date.now(),
      opts,
    ),
  };
}

export interface ModelHistoryRequest {
  ledger: string;
  character: string;
  since?: string | undefined;
  until?: string | undefined;
}

export function modelHistory(request: ModelHistoryRequest): unknown {
  const ledger = openOrThrow(request.ledger);
  return {
    models: modelUsageSummary(ledger.database, {
      since: request.since,
      until: request.until,
      character: request.character,
    }),
  };
}

export function clearPricingCache(path: string): void {
  openOrThrow(path).pricing.clearCache();
}

function openOrThrow(path: string): Ledger {
  const ledger = ledgerFor(path);
  if (ledger === null) {
    throw new Error(`cannot open ledger at ${path}`);
  }
  return ledger;
}
