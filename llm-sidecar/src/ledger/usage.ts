/**
 * `shore usage`, answered by the side that owns the ledger.
 *
 * Ported from `crates/daemon/src/commands/usage.rs`. That command was the last
 * reader still opening `ledger.db` from the daemon; with the writer, the budget
 * gate, and now the reports all here, the daemon holds no ledger logic at all
 * and the Rust `ledger/query.rs` and `ledger/budget.rs` could go.
 *
 * **The payloads are the protocol.** `crates/cli/src/output/commands.rs` renders
 * these objects by key — `mode`, `period`, `summary`, `budgets`, and the rest —
 * so the shapes here are not an internal detail to tidy up. They are reproduced
 * field for field, in the same order, and pinned by a parity fixture generated
 * from the Rust.
 *
 * One thing stays with the command: **the `shore usage` argument vocabulary**,
 * which is the CLI's protocol rather than the ledger's. `commands/usage.ts`
 * takes the args as given and passes them through verbatim; which flag wins
 * when several are set is decided here, in the order the Rust checked them.
 *
 * `refresh_pricing` used to be split across the two processes — the daemon
 * emptied the `pricing` table and this side dropped the memory in front of it —
 * and the two halves ran under different conditions, so `--budget
 * --refresh-pricing` cleared one and not the other. It is one call in
 * {@link PricingEngine.clearCache} now, made by the command before it asks for
 * any report at all.
 */

import type { Database } from "bun:sqlite";

import {
  budgetStatuses,
  newlyCrossedBudgetWarnings,
  spikeWarnings,
  type BudgetOptions,
  type UsageConfig,
} from "./budget.ts";
import { reconstructState } from "./cache_tracker.ts";
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
  type Naive,
} from "./zoned.ts";

/** The TTL cache health is judged against. The Rust passed `3600` literally. */
const CACHE_HEALTH_TTL_SECS = 3600;

/** The window anomalies are counted over on the summary, whatever `last` says. */
const ANOMALY_LOOKBACK = "7d";

// ── Request ──────────────────────────────────────────────────────────────────

/** What the daemon posts to `/v1/usage`. */
export interface UsageRequest {
  /** Path to `ledger.db`. */
  ledger: string;
  /** The `shore usage` command arguments, verbatim. */
  args?: Record<string, unknown> | undefined;
  /** `[usage]` from the daemon's config. */
  usage?: UsageConfig | undefined;
}

/**
 * Test seams, not wire fields.
 *
 * `now` and `localZone` are what the Rust reads from `Utc::now()` and `TZ`, so
 * they are parameters here rather than request fields — the daemon has no
 * business overriding either, and a knob on the wire would invite it to.
 */
export interface UsageOptions extends BudgetOptions {
  now?: number;
}

// ── Period parsing ───────────────────────────────────────────────────────────

type CalendarWindow = "day" | "week" | "month";

/** Midnight opening the day/week/month containing `naive`, in naive space. */
function calendarStartNaive(naive: Naive, window: CalendarWindow): Naive {
  const { year, month, day } = partsOf(naive);
  const midnight = naiveFrom(year, month, day, 0);
  switch (window) {
    case "day":
      return midnight;
    case "week":
      // Days are exact in naive space — no DST to step over — so this is the
      // same subtraction chrono does on a `NaiveDate`.
      return midnight - daysFromMonday(naive) * DAY_MS;
    case "month":
      return naiveFrom(year, month, 1, 0);
  }
}

/** The instant a calendar window opened, in the configured timezone. */
function calendarStart(
  now: number,
  window: CalendarWindow,
  timezone: string,
  opts: UsageOptions,
): number {
  const zone = zoneFor(timezone, opts.localZone);
  return resolveInZone(calendarStartNaive(naiveInZone(now, zone), window), zone);
}

/** Rust's `str::trim_end_matches(char)`: strips *every* trailing `ch`. */
function trimEnd(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * `i64::from_str`, as far as it matters here: an optional sign and digits, no
 * whitespace and no separators.
 *
 * Bounded to the safe-integer range, past which the multiplication below would
 * silently lose digits. Rust would overflow instead; both readings of `"999999
 * 99999999999999d"` are nonsense, and no lower bound at all is the harmless one.
 */
function parseI64(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) {
    return undefined;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The relative-period suffixes, and what each is worth in milliseconds. */
const RELATIVE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["h", HOUR_MS],
  ["d", DAY_MS],
  ["w", 7 * DAY_MS],
];

/**
 * The `--last` window's lower bound as an RFC 3339 string, or `undefined` for
 * no lower bound.
 *
 * `undefined` covers both `"all"` and anything unparseable, exactly as the
 * Rust's `Option` did: an argument we cannot read means the whole ledger, not
 * an error.
 */
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

// ── Filters ──────────────────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** `true` only when `key` is explicitly the boolean `true`. */
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
      // The CLI calls it `api_key`; the ledger column is `api_key_name`.
      api_key_name: str(args, "api_key"),
      model: str(args, "model"),
      call_type: str(args, "call_type"),
    },
    last,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run one `shore usage` request against the ledger it names.
 *
 * Throws when the ledger cannot be opened. That is the one failure the daemon
 * used to raise as an internal error, and reporting nothing is better than
 * reporting an empty ledger as if it were an idle one.
 */
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

  // Flag precedence, in the order `commands/usage.rs` tested it.
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
    // The clearing happened in `commands/usage.ts`, before this ran and whatever
    // else the args asked for. This arm is the mode's place in the precedence
    // chain and the answer it gives when it wins.
    return { mode: "refresh_pricing" };
  }
  if (flag(args, "recalculate")) {
    return recalculate(db, ledger.pricing, flag(args, "force"));
  }

  return summaryPayload(db, config, filter, last, timezone, opts, now);
}

// ── Modes ────────────────────────────────────────────────────────────────────

function budgetPayload(
  db: Database,
  config: UsageConfig,
  now: number,
  opts: UsageOptions,
): unknown {
  return {
    mode: "budget",
    timezone: config.timezone ?? "local",
    allow_compaction_over_budget: config.allow_compaction_over_budget ?? true,
    budgets: budgetStatuses(db, config, now, opts),
    spike_warnings: spikeWarnings(db, config, now, opts),
  };
}

/**
 * TSV re-quoted as CSV.
 *
 * Fields are quoted only when they contain a comma, a quote, or a newline —
 * a tab does not trigger quoting, because a tab inside a field would already
 * have broken the TSV it came from.
 */
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
  // `--last today` is too narrow to say anything about cache behaviour, so the
  // anomaly view quietly widens to a week. An explicit window is respected.
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
    // Recomputed rather than read off `lastRow.cache_state`: that is what was
    // true when the call was made, and a prefix that has since aged past its
    // TTL is cold now.
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
    budgets: budgetStatuses(db, config, now, opts),
    spike_warnings: spikeWarnings(db, config, now, opts),
  };
}

/**
 * Reprice ledger rows from the catalog.
 *
 * Two passes, as in the Rust: fetch each distinct (provider, model) once —
 * a catalog fetch is the expensive part and every row of a model shares it —
 * then price every row from what landed in the cache.
 *
 * One deliberate difference: `failures` comes out in the order the models were
 * first seen. The Rust collected them from a `HashMap`, whose iteration order is
 * randomized per process, so the list was already unordered; making it stable is
 * a change nobody can have depended on.
 */
async function recalculate(
  db: Database,
  pricing: PricingEngine,
  force: boolean,
): Promise<unknown> {
  const rows = force ? allCostRows(db) : nullCostRows(db);
  if (rows.length === 0) {
    return { mode: "recalculate", updated: 0, total: 0, failures: [] };
  }

  /** `provider/model` → why it could not be priced, or `undefined` if it could. */
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
      // The Rust ignored a failed update the same way (`.is_ok()`), and the
      // count reports what actually landed.
      console.warn(`shore: could not update costs for row ${row.id}: ${String(e)}`);
    }
  }

  const failures = [...fetched.entries()]
    .filter(([, reason]) => reason !== undefined)
    .map(([model, reason]) => ({ model, reason }));

  return { mode: "recalculate", updated, total: rows.length, failures };
}

// ── Budget warnings ──────────────────────────────────────────────────────────

/** What the daemon posts to `/v1/usage/warnings` after each completed turn. */
export interface BudgetWarningsRequest {
  ledger: string;
  usage?: UsageConfig | undefined;
}

/**
 * Budget thresholds crossed since the last check, marking them delivered.
 *
 * A read that writes: the dedup marker is recorded as each threshold is
 * reported, so the same 80% crossing is announced once per window. That is why
 * it belongs on one side only — two processes each holding a ledger handle and
 * each deciding what is "new" would race for it.
 */
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

// ── model_history tool ───────────────────────────────────────────────────────

/** What the daemon posts to `/v1/usage/models` for the `model_history` tool. */
export interface ModelHistoryRequest {
  ledger: string;
  character: string;
  since?: string | undefined;
  until?: string | undefined;
}

/**
 * Per-model provenance for one character.
 *
 * The daemon's tool handler keeps the argument parsing and the time-bound
 * validation — they produce user-facing `InvalidArgs` errors in its own
 * vocabulary — and asks here only for the rows.
 */
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

/**
 * Empty the pricing caches in front of the ledger at `path`.
 *
 * Exported for `commands/usage.ts`, which runs it before any report — see the
 * module note on why `refresh_pricing` clears from there and not from its own
 * arm of the mode chain. Throws what every other entry point here throws when
 * the ledger will not open.
 */
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
