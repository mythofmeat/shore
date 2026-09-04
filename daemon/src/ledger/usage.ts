import { shoreLog } from "../log.ts";

import type { Database } from "bun:sqlite";

import {
  budgetStatuses,
  narrowestBudgetWindow,
  newlyCrossedBudgetWarnings,
  type BudgetOptions,
  type UsageConfig,
} from "./budget.ts";
import { reconstructState } from "../cache/tracker.ts";
import { catalogId, type PricingEngine } from "./pricing.ts";
import {
  activeAnthropicCharacters,
  allCostRows,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  anomalyCounts,
  cacheCoverage,
  costSourceTotals,
  queryAnomalies,
  updateCosts,
  usageSummary,
  usageSummaryBy,
  isUsageDimension,
  USAGE_DIMENSIONS,
  warmStreak,
  type QueryFilter,
} from "./query.ts";
import { ledgerFor } from "./record.ts";
import { isSubscriptionCall } from "./store.ts";
import type { Ledger } from "./store.ts";
import {
  nanoGptSubscriptionPath,
  readNanoGptSubscriptionSync,
  type NanoGptSubscriptionState,
} from "../llm/nanogpt_subscription.ts";
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
  cacheDir?: string;
  args?: Record<string, unknown> | undefined;
  usage?: UsageConfig | undefined;
  rateLimits?: () => unknown[];
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
  ["M", 30 * DAY_MS],
];

const PERIOD_FORMS = "today, week, month, all, or a count like 4h, 7d, 2w, 1M";

export class UsageArgumentError extends Error {}

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
  config: UsageConfig,
): { filter: QueryFilter; last: string; periodSince: string | undefined } {
  const requested = str(args, "last");
  const budgetWindow =
    requested === undefined ? narrowestBudgetWindow(config, now, opts) : undefined;
  const last = requested ?? (budgetWindow === undefined ? "today" : "budget");
  const since =
    budgetWindow === undefined
      ? parseLastPeriod(last, now, timezone, opts)
      : toRfc3339(budgetWindow.start);
  if (requested !== undefined && requested !== "all" && since === undefined) {
    throw new UsageArgumentError(
      `unknown usage period '${requested}' (expected ${PERIOD_FORMS})`,
    );
  }

  const scoped = {
    character: str(args, "character"),
    provider: str(args, "provider"),
    api_key_name: str(args, "api_key"),
    model: str(args, "model"),
    call_type: str(args, "call_type"),
  };
  return {
    filter: { since, ...scoped },
    last,
    periodSince: budgetWindow === undefined ? undefined : since,
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
  const { filter, last, periodSince } = buildFilter(args, timezone, opts, now, config);

  if (flag(args, "budget")) {
    return budgetPayload(db, config, now, opts);
  }
  if (flag(args, "export_tsv")) {
    return { mode: "tsv", data: exportTsv(db, filter) };
  }
  if (flag(args, "export_csv")) {
    return { mode: "csv", data: tsvToCsv(exportTsv(db, filter)) };
  }
  const dimension = str(args, "group_by");
  if (dimension !== undefined) {
    if (!isUsageDimension(dimension)) {
      throw new UsageArgumentError(
        `unknown usage dimension '${dimension}' (expected one of ${USAGE_DIMENSIONS.join(", ")})`,
      );
    }
    return {
      mode: "summary_by",
      dimension,
      period: last,
      ...(periodSince === undefined ? {} : { period_since: periodSince }),
      summary: usageSummaryBy(db, filter, dimension),
    };
  }
  if (flag(args, "anomalies")) {
    return anomaliesPayload(db, filter, last, timezone, opts, now);
  }
  return summaryPayload(
    db,
    config,
    filter,
    last,
    periodSince,
    timezone,
    opts,
    now,
    request.rateLimits?.() ?? [],
    request.cacheDir === undefined
      ? undefined
      : readNanoGptSubscriptionSync(nanoGptSubscriptionPath(request.cacheDir)),
  );
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
  periodSince: string | undefined,
  timezone: string,
  opts: UsageOptions,
  now: number,
  rateLimits: unknown[],
  nanoGptSubscription: NanoGptSubscriptionState | undefined,
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
    ...(periodSince === undefined ? {} : { period_since: periodSince }),
    timezone,
    summary: usageSummary(db, filter),
    cache_health: cacheHealth,
    anomaly_count_7d: queryAnomalies(db, anomalyFilter).length,
    anomaly_counts_7d: anomalyCounts(db, anomalyFilter),
    cache_coverage: cacheCoverage(db, filter),
    cost_sources: costSourceTotals(db, filter),
    rate_limits: rateLimits,
    nanogpt_subscription: nanoGptSubscription ?? null,
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

const FLAT_PLAN_COST = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total: 0,
};

export interface CostBackfill {
  updated: number;
  total: number;
  failures: { model: string; reason: string }[];
}

export async function backfillMissingCosts(
  db: Database,
  pricing: PricingEngine,
  force: boolean,
): Promise<CostBackfill> {
  const rows = force ? allCostRows(db) : nullCostRows(db);
  if (rows.length === 0) {
    return { updated: 0, total: 0, failures: [] };
  }

  const fetched = new Map<string, string | undefined>();
  for (const row of rows) {
    if (isSubscriptionCall(row.provider, row.model)) continue;
    const key = `${row.provider}/${row.model}`;
    if (fetched.has(key)) {
      continue;
    }
    const found = await pricing.getOrFetch(row.provider, row.model);
    if (found === undefined) {
      const modelId = catalogId(row.provider, row.model);
      shoreLog.warn(`shore: pricing fetch returned no data for ${modelId}`);
      fetched.set(key, `no pricing data for ${modelId}`);
    } else {
      fetched.set(key, undefined);
    }
  }

  let updated = 0;
  for (const row of rows) {
    if (isSubscriptionCall(row.provider, row.model)) {
      try {
        updateCosts(db, row.id, FLAT_PLAN_COST);
        updated += 1;
      } catch (e) {
        shoreLog.warn(`shore: could not zero costs for row ${row.id}: ${String(e)}`);
      }
      continue;
    }
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
      shoreLog.warn(`shore: could not update costs for row ${row.id}: ${String(e)}`);
    }
  }

  const failures = [...fetched.entries()]
    .flatMap(([model, reason]) => (reason === undefined ? [] : [{ model, reason }]));

  return { updated, total: rows.length, failures };
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


function openOrThrow(path: string): Ledger {
  const ledger = ledgerFor(path);
  if (ledger === null) {
    throw new Error(`cannot open ledger at ${path}`);
  }
  return ledger;
}

export async function backfillLedgerCosts(
  ledgerPath: string,
  force = false,
): Promise<CostBackfill> {
  const ledger = ledgerFor(ledgerPath);
  if (ledger === null) return { updated: 0, total: 0, failures: [] };
  return await backfillMissingCosts(ledger.database, ledger.pricing, force);
}
