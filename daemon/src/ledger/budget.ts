/**
 * Usage budget evaluation over the append-only ledger.
 *
 * Ported from `crates/daemon/src/ledger/budget.rs`. Structure, field names, and
 * the JSON each status serializes to are kept deliberately close to the Rust:
 * `shore usage --json` prints these shapes, and the enforcement path decides
 * whether a call is allowed to spend money at all.
 *
 * Two halves live here, sharing one core:
 *
 *   - **Enforcement** — {@link enforceBudgetForCall} answers "may this call
 *     run?" It is the one function here whose wrong answer costs money in both
 *     directions: a false allow overspends, a false block silently stops a
 *     character replying.
 *   - **Reporting** — {@link budgetStatuses}, {@link spikeWarnings}, and
 *     {@link newlyCrossedBudgetWarnings} back `shore usage`.
 *
 * They share `budgetStatus`, `paceStatus`, and the window arithmetic, which is
 * why the two moved together rather than one at a time: splitting them would
 * have meant two implementations of budget matching and period arithmetic, in
 * two languages, for money code.
 *
 * All wall-clock arithmetic goes through `zoned.ts`. Read its header before
 * touching anything in the window functions — the reason pace sub-windows step
 * through naive space is DST, and it is not visible from the arithmetic itself.
 */

import type { Database } from "bun:sqlite";

import type { UsageConfig as AppUsageConfig } from "../config/app.ts";

import { isSubscriptionProvider } from "./store.ts";
import { usageTotals, type QueryFilter } from "./query.ts";
import {
  atHour,
  daysFromMonday,
  daysInMonth,
  DAY_MS,
  formatLocalAmPm,
  HOUR_MS,
  naiveFrom,
  naiveInZone,
  partsOf,
  resolveInZone,
  SECOND_MS,
  toRfc3339,
  zoneFor,
  type Naive,
} from "./zoned.ts";

// ── Config (mirrors shore_common::config::app) ───────────────────────────────

export type UsageBudgetPeriod = "hour" | "day" | "week" | "month";
export type UsageBudgetAction = "warn" | "block" | "pause_background";
export type BudgetWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface UsageBudgetConfig {
  name?: string;
  period?: UsageBudgetPeriod;
  cost_usd: number;
  warn_at?: number[];
  limit?: UsageBudgetAction;
  character?: string | null;
  provider?: string | null;
  api_key?: string | null;
  model?: string | null;
  call_type?: string | null;
  usage_kind?: string[];
  allow_compaction_over_budget?: boolean | null;
  reset_hour?: number | null;
  reset_day_of_week?: BudgetWeekday | null;
  reset_day_of_month?: number | null;
  pace_period?: UsageBudgetPeriod | null;
  pace_action?: UsageBudgetAction | null;
  pace_warn_at?: number[] | null;
}

export interface UsageSpikeWarningsConfig {
  enabled?: boolean;
  period?: UsageBudgetPeriod;
  multiplier?: number;
  min_cost_usd?: number;
}

export interface UsageConfig {
  timezone?: string;
  allow_compaction_over_budget?: boolean;
  budgets?: UsageBudgetConfig[];
  spike_warnings?: UsageSpikeWarningsConfig;
}

/**
 * `[usage]` as this gate reads it.
 *
 * A rename in the other direction to the rest of the config port: the parsed
 * config spells an unset filter `undefined` because it is a struct field, and
 * the gate spells it *absent* because it came from the wire, where the daemon
 * omitted it. Dropping the undefined-valued keys is the whole translation.
 *
 * It lives here rather than at either caller because both of them — `shore
 * usage` and the per-turn budget check — need the same one, and two spellings
 * of "which filters this budget has" would be two different sets of budgets
 * matching the same call.
 */
export function usageConfigView(cfg: AppUsageConfig): UsageConfig {
  return {
    timezone: cfg.timezone,
    allow_compaction_over_budget: cfg.allow_compaction_over_budget,
    budgets: cfg.budgets.map(
      (b) => defined(b as unknown as Record<string, unknown>) as unknown as UsageBudgetConfig,
    ),
    spike_warnings: cfg.spike_warnings,
  };
}

/** The record without its undefined-valued keys. */
function defined(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));
}

/** Serde defaults, applied here so a partially-specified config behaves as the
 *  daemon's would. */
const DEFAULT_WARN_AT: readonly number[] = [0.8, 1.0];
const DEFAULT_TIMEZONE = "local";
const DEFAULT_SPIKE_MULTIPLIER = 3;
const DEFAULT_SPIKE_MIN_COST = 1;

const budgetPeriod = (b: UsageBudgetConfig): UsageBudgetPeriod =>
  b.period ?? "day";
const budgetWarnAt = (b: UsageBudgetConfig): readonly number[] =>
  b.warn_at ?? DEFAULT_WARN_AT;
const budgetLimit = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.limit ?? "warn";
const budgetUsageKind = (b: UsageBudgetConfig): readonly string[] =>
  b.usage_kind ?? [];
/** Effective pace enforcement action; `warn` unless overridden. */
const paceAction = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.pace_action ?? "warn";
/** Effective pace warning thresholds, falling back to the budget's own. */
const paceWarnAt = (b: UsageBudgetConfig): readonly number[] =>
  b.pace_warn_at ?? budgetWarnAt(b);

/**
 * Rust's `{:.N}`: round the **exact** value of the double to `digits` decimal
 * places, ties to even.
 *
 * Neither obvious tool does this. `toFixed` rounds ties away from zero, so it
 * prints 80.5 as "81" where Rust prints "80" — caught by the parity fixture on
 * a warning threshold of 0.805. `Intl.NumberFormat` with
 * `roundingMode: "halfEven"` gets that case right but loses near-ties: it
 * renders 1.05 at one decimal as "1.0", while the double nearest 1.05 is
 * actually a shade *above* it, so Rust (and `toFixed`) correctly give "1.1".
 *
 * So work from the exact value. A double is `mantissa × 2^exp`; multiplying
 * through by 5^k turns the binary fraction into an exact decimal one, and
 * BigInt division then rounds with no floating point left in the loop.
 */
export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : Number.isNaN(value) ? "NaN" : "-inf";
  }
  const negative = value < 0 || Object.is(value, -0);
  const x = Math.abs(value);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4));
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  // Subnormals have no implicit leading bit and a fixed exponent.
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;

  // Exact value as `numerator / 10^scale`.
  let numerator: bigint;
  let scale: number;
  if (exponent >= 0) {
    numerator = mantissa << BigInt(exponent);
    scale = 0;
  } else {
    scale = -exponent;
    numerator = mantissa * 5n ** BigInt(scale);
  }

  const shift = scale - digits;
  let scaled: bigint;
  if (shift <= 0) {
    scaled = numerator * 10n ** BigInt(-shift);
  } else {
    const divisor = 10n ** BigInt(shift);
    const quotient = numerator / divisor;
    const remainder = numerator % divisor;
    const twice = remainder * 2n;
    if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) {
      scaled = quotient + 1n;
    } else {
      scaled = quotient;
    }
  }

  const text = scaled.toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? text : text.slice(0, text.length - digits);
  const frac = digits === 0 ? "" : `.${text.slice(text.length - digits)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Rust's `{:?}`, which the block and spike messages interpolate. */
const periodDebug = (p: UsageBudgetPeriod): string =>
  ({ hour: "Hour", day: "Day", week: "Week", month: "Month" })[p];
const actionDebug = (a: UsageBudgetAction): string =>
  ({ warn: "Warn", block: "Block", pause_background: "PauseBackground" })[a];

const WEEKDAY_FROM_MONDAY: Record<BudgetWeekday, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

// ── Public shapes ────────────────────────────────────────────────────────────

export interface PaceStatus {
  period: UsageBudgetPeriod;
  window_start: string;
  window_end: string;
  allowance: number;
  current_cost: number;
  /** `allowance - current_cost`; negative once this sub-window is overspent. */
  remaining: number;
  percent_used: number;
  /** Sub-windows left in the budget period, counting the current one.
   *  Fractional when the period doesn't divide evenly — a month is ~4.4 weeks. */
  periods_remaining: number;
  status: string;
  action: UsageBudgetAction;
  warning_thresholds: number[];
  crossed_warn_at: number[];
  over_limit: boolean;
}

export interface BudgetStatus {
  name: string;
  period: UsageBudgetPeriod;
  period_start: string;
  period_end: string;
  reset_at: string;
  timezone: string;
  current_cost: number;
  cost_limit: number;
  percent_used: number;
  status: string;
  action: UsageBudgetAction;
  warning_thresholds: number[];
  crossed_warn_at: number[];
  over_limit: boolean;
  compaction_allowed_over_budget: boolean;
  filters: Record<string, unknown>;
  /** Present only when the budget configures `pace_period`, so an unpaced
   *  budget serializes exactly as before. */
  pace?: PaceStatus;
}

export interface SpikeWarning {
  period: UsageBudgetPeriod;
  period_start: string;
  previous_period_start: string;
  timezone: string;
  current_cost: number;
  previous_cost: number;
  multiplier: number | null;
  threshold_multiplier: number;
  min_cost_usd: number;
  message: string;
}

export interface UsageBudgetWarningEvent {
  budget: string;
  message: string;
  current_cost: number;
  cost_limit: number;
  percent_used: number;
  crossed_warn_at: number[];
  period: UsageBudgetPeriod;
  period_start: string;
  reset_at: string;
  /** `reset_at` in local time as `YYYY-MM-DD HH:MM AM|PM`, for clients that
   *  surface this string verbatim. `reset_at` stays RFC 3339 UTC. */
  reset_at_display: string;
  /** Whether this warning is about the budget cap or its pace allowance. The
   *  cost/period/window fields describe whichever one tripped. */
  scope: BudgetScope;
}

export interface BudgetCallContext {
  provider: string;
  api_key_name?: string | undefined;
  model: string;
  call_type: string;
  character: string;
}

export interface BudgetBlock {
  budget_name: string;
  action: UsageBudgetAction;
  current_cost: number;
  cost_limit: number;
  /** Period of whichever limit tripped: the budget window for `budget`, the
   *  pace sub-window for `pace`. */
  period: UsageBudgetPeriod;
  reset_at: string;
  scope: BudgetScope;
  /**
   * Worst-case spend this refusal was weighed against, when it was a
   * projection rather than money already spent (#14).
   *
   * Present only on a pre-flight refusal, which is the case where
   * `current_cost` alone does not explain the block — it is under the limit,
   * and what tripped is what the call was about to authorise.
   */
  projected_cost?: number;
  /** The Rust `Display` text, which reaches the user as an error. */
  message: string;
}

export type BudgetScope = "budget" | "pace";

/** Prefix for the `usage_budget_warnings.threshold` dedup key.
 *
 *  A pace and its budget can open at the same instant — a Wednesday-anchored
 *  weekly budget starts its first day-pace exactly at the week start — so
 *  `(budget_name, period_start)` alone would collide. Prefixing the threshold
 *  text keeps the existing `UNIQUE` constraint and leaves rows already recorded
 *  for budget-scope warnings untouched. */
const thresholdPrefix = (scope: BudgetScope): string =>
  scope === "pace" ? "pace:" : "";

/** Options threaded through so tests can pin the zone that Rust reads from
 *  `TZ`. Defaults to the host zone, which is what `chrono::Local` resolves to. */
export interface BudgetOptions {
  localZone?: string;
}

/**
 * Extra spend to weigh against the limit without reporting it as spent.
 *
 * A tool loop is several provider calls behind one gate (#14). Passing the
 * loop's worst case here refuses up front rather than partway through, which is
 * the only refusal that leaves a well-formed transcript: stopping mid-loop
 * abandons a turn whose `tool_use` blocks already have no `tool_result` after
 * them, and Anthropic rejects that on the *next* request — turning a budget
 * overrun into a wedged conversation.
 *
 * Deliberately applied to the enforcement comparison alone and never to
 * {@link BudgetStatus.current_cost}. A projection is a forecast, and a forecast
 * in `shore usage` is a number that does not reconcile with the ledger.
 */
export interface EnforceOptions extends BudgetOptions {
  /** Worst-case additional USD this call is about to authorise. */
  projectedCost?: number;
}

function blockMessage(block: Omit<BudgetBlock, "message">): string {
  // A pre-flight refusal is under the limit until the call it is refusing, so
  // the "is over limit" wording would be false where it is most likely to be
  // read. It gets its own sentence naming the projection that tripped it —
  // otherwise a person checks `shore usage`, sees room, and files a bug.
  const projected = block.projected_cost;
  if (projected !== undefined && projected > 0) {
    const limit =
      block.scope === "budget"
        ? `$${formatFixed(block.cost_limit, 2)} for ${periodDebug(block.period)}`
        : `the ${block.period} pace allowance of $${formatFixed(block.cost_limit, 2)}`;
    return (
      `Shore usage budget "${block.budget_name}" would be exceeded by this tool loop ` +
      `($${formatFixed(block.current_cost, 2)} spent plus up to $${formatFixed(projected, 2)} projected, ` +
      `against ${limit}); refused before starting, so the turn is not abandoned partway; ` +
      `action ${actionDebug(block.action)}; resets at ${block.reset_at}`
    );
  }
  return block.scope === "budget"
    ? `Shore usage budget "${block.budget_name}" is over limit ($${formatFixed(block.current_cost, 2)}/$${formatFixed(block.cost_limit, 2)} for ${periodDebug(block.period)}); action ${actionDebug(block.action)}; resets at ${block.reset_at}`
    : `Shore usage budget "${block.budget_name}" ${block.period} pace is exhausted ($${formatFixed(block.current_cost, 2)}/$${formatFixed(block.cost_limit, 2)}); action ${actionDebug(block.action)}; pace resets at ${block.reset_at}`;
}

// ── Windows ──────────────────────────────────────────────────────────────────

interface PeriodWindow {
  start: number;
  end: number;
  /** Wall-clock bounds in the budget's timezone. Pace sub-windows step through
   *  naive space so a `reset_hour = 6` boundary stays at 06:00 across a DST
   *  transition instead of drifting an hour off the budget's own reset. */
  start_naive: Naive;
  end_naive: Naive;
  /** The config token, `"utc"` or `"local"` — not an IANA zone name. Reported
   *  verbatim as `BudgetStatus.timezone`. */
  timezone: string;
  /** Resolved IANA zone the naive bounds are read against. */
  zone: string;
}

interface BudgetAnchors {
  /** Hour-of-day (0-23) at which day/week/month windows reset. */
  hour: number;
  /** 0 = Monday .. 6 = Sunday. Used only for week windows. */
  day_of_week: number;
  /** Day-of-month (1-31). Clamped to the last day on short months. */
  day_of_month: number;
}

const DEFAULT_ANCHORS: BudgetAnchors = {
  hour: 0,
  day_of_week: 0,
  day_of_month: 1,
};

function anchorsFrom(budget: UsageBudgetConfig): BudgetAnchors {
  return {
    hour: budget.reset_hour ?? 0,
    day_of_week:
      budget.reset_day_of_week == null
        ? 0
        : WEEKDAY_FROM_MONDAY[budget.reset_day_of_week],
    day_of_month: budget.reset_day_of_month ?? 1,
  };
}

function periodWindow(
  now: number,
  period: UsageBudgetPeriod,
  timezone: string,
  anchors: BudgetAnchors | undefined,
  opts: BudgetOptions,
): PeriodWindow {
  const zone = zoneFor(timezone, opts.localZone);
  const nowNaive = naiveInZone(now, zone);
  const startNaive = periodStartNaive(nowNaive, period, anchors);
  const endNaive = periodEndNaive(startNaive, period, anchors);
  return {
    start: resolveInZone(startNaive, zone),
    end: resolveInZone(endNaive, zone),
    start_naive: startNaive,
    end_naive: endNaive,
    timezone: timezone === "utc" ? "utc" : "local",
    zone,
  };
}

function periodStartNaive(
  now: Naive,
  period: UsageBudgetPeriod,
  anchorsOpt: BudgetAnchors | undefined,
): Naive {
  const anchors = anchorsOpt ?? DEFAULT_ANCHORS;
  switch (period) {
    case "hour":
      return atHour(now, partsOf(now).hour);
    case "day": {
      const todayReset = atHour(now, anchors.hour);
      if (now >= todayReset) {
        return todayReset;
      }
      return atHour(now - DAY_MS, anchors.hour);
    }
    case "week": {
      const todayDow = daysFromMonday(now);
      const daysBack = (todayDow + 7 - anchors.day_of_week) % 7;
      const candidate = atHour(now - daysBack * DAY_MS, anchors.hour);
      if (now >= candidate) {
        return candidate;
      }
      return atHour(candidate - 7 * DAY_MS, anchors.hour);
    }
    case "month": {
      const { year, month } = partsOf(now);
      const thisMonth = monthAnchorNaive(year, month, anchors);
      if (now >= thisMonth) {
        return thisMonth;
      }
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      return monthAnchorNaive(prevYear, prevMonth, anchors);
    }
  }
}

function periodEndNaive(
  start: Naive,
  period: UsageBudgetPeriod,
  anchorsOpt: BudgetAnchors | undefined,
): Naive {
  const anchors = anchorsOpt ?? DEFAULT_ANCHORS;
  switch (period) {
    case "hour":
      return start + HOUR_MS;
    case "day":
      return start + DAY_MS;
    case "week":
      return start + 7 * DAY_MS;
    case "month": {
      const { year, month } = partsOf(start);
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      return monthAnchorNaive(nextYear, nextMonth, anchors);
    }
  }
}

function monthAnchorNaive(
  year: number,
  month: number,
  anchors: BudgetAnchors,
): Naive {
  const maxDay = daysInMonth(year, month);
  const day = Math.min(Math.max(anchors.day_of_month, 1), maxDay);
  return naiveFrom(year, month, day, Math.min(Math.max(anchors.hour, 0), 23));
}

interface PaceWindow {
  start: number;
  end: number;
  periods_remaining: number;
}

/**
 * Fixed length of a pace period.
 *
 * `undefined` for `month`, which has no fixed length and can never be a pace:
 * config validation requires the pace to rank strictly shorter than the budget
 * period, and `month` is the longest. Returning nothing degrades an impossible
 * config to "no pace" instead of inventing a 30-day month.
 */
function paceStep(pace: UsageBudgetPeriod): number | undefined {
  switch (pace) {
    case "hour":
      return HOUR_MS;
    case "day":
      return DAY_MS;
    case "week":
      return 7 * DAY_MS;
    case "month":
      return undefined;
  }
}

/**
 * The pace sub-window containing `now`, stepped from the budget window's own
 * start so sub-windows tile the period exactly and inherit its reset anchor.
 *
 * Stepping happens in wall-clock (naive) space: across a DST transition a
 * `reset_hour = 6` day-pace stays anchored to 06:00 local rather than sliding to
 * 05:00 or 07:00. Only the final resolution back to instants is zone-aware.
 */
function paceWindow(
  window: PeriodWindow,
  now: number,
  pace: UsageBudgetPeriod,
): PaceWindow | undefined {
  const step = paceStep(pace);
  if (step === undefined) {
    return undefined;
  }
  const nowNaive = naiveInZone(now, window.zone);
  const bounds = paceBoundsNaive(window, nowNaive, step);
  if (bounds === undefined) {
    return undefined;
  }
  return {
    start: resolveInZone(bounds.start, window.zone),
    end: resolveInZone(bounds.end, window.zone),
    periods_remaining: bounds.periods_remaining,
  };
}

interface PaceBounds {
  start: Naive;
  end: Naive;
  periods_remaining: number;
}

/**
 * Wall-clock bounds of the sub-window containing `nowNaive`.
 *
 * Stepping in wall-clock space is what holds a `reset_hour = 6` boundary at
 * 06:00 through a transition: a naive clock has no transitions to slide across.
 */
export function paceBoundsNaive(
  window: Pick<PeriodWindow, "start_naive" | "end_naive">,
  nowNaive: Naive,
  stepMs: number,
): PaceBounds | undefined {
  if (stepMs <= 0) {
    return undefined;
  }
  // Rust works in whole seconds here (`num_seconds`), so truncate to match:
  // a sub-second step would divide differently.
  const stepSecs = Math.trunc(stepMs / SECOND_MS);
  if (stepSecs <= 0) {
    return undefined;
  }
  const elapsedSecs = Math.max(
    Math.trunc((nowNaive - window.start_naive) / SECOND_MS),
    0,
  );
  const offsetSecs = Math.trunc(elapsedSecs / stepSecs) * stepSecs;
  const start = window.start_naive + offsetSecs * SECOND_MS;
  const end = Math.min(start + stepSecs * SECOND_MS, window.end_naive);
  const remainingSecs = Math.max(
    Math.trunc((window.end_naive - start) / SECOND_MS),
    0,
  );
  return {
    start,
    end,
    periods_remaining: remainingSecs / stepSecs,
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

export function budgetStatuses(
  db: Database,
  config: UsageConfig,
  now: number,
  opts: BudgetOptions = {},
): BudgetStatus[] {
  return (config.budgets ?? []).map((budget, idx) =>
    budgetStatus(db, config, budget, idx, now, opts),
  );
}

function budgetStatus(
  db: Database,
  config: UsageConfig,
  budget: UsageBudgetConfig,
  idx: number,
  now: number,
  opts: BudgetOptions,
): BudgetStatus {
  const anchors = anchorsFrom(budget);
  const period = budgetPeriod(budget);
  const window = periodWindow(
    now,
    period,
    config.timezone ?? DEFAULT_TIMEZONE,
    anchors,
    opts,
  );
  const pacePeriod = budget.pace_period ?? undefined;
  const sub =
    pacePeriod === undefined ? undefined : paceWindow(window, now, pacePeriod);

  // Rust reads both totals under one ledger lock so the pair is a consistent
  // snapshot: `paceStatus` derives spend before the sub-window by subtracting
  // one from the other, and a call landing between two separate reads would
  // briefly overstate the allowance. There is no lock to take here — one
  // handle, one thread — but the ordering dependency is the same, so the two
  // reads stay adjacent.
  const currentCost = usageTotals(
    db,
    filterForBudget(budget, window.start),
  ).total_cost;
  const paceCost =
    sub === undefined
      ? undefined
      : usageTotals(db, filterForBudget(budget, sub.start)).total_cost;

  const costLimit = budget.cost_usd;
  const percentUsed = currentCost / costLimit;
  const [warningThresholds, crossedWarnAt] = crossedThresholds(
    budgetWarnAt(budget),
    percentUsed,
  );
  const overLimit = currentCost >= costLimit;
  const pace =
    sub !== undefined && paceCost !== undefined && pacePeriod !== undefined
      ? paceStatus(budget, pacePeriod, sub, currentCost, paceCost)
      : undefined;

  const status: BudgetStatus = {
    name: budgetName(budget, idx),
    period,
    period_start: toRfc3339(window.start),
    period_end: toRfc3339(window.end),
    reset_at: toRfc3339(window.end),
    timezone: window.timezone,
    current_cost: currentCost,
    cost_limit: costLimit,
    percent_used: percentUsed,
    status: levelName(overLimit, crossedWarnAt),
    action: budgetLimit(budget),
    warning_thresholds: warningThresholds,
    crossed_warn_at: crossedWarnAt,
    over_limit: overLimit,
    compaction_allowed_over_budget: compactionAllowed(config, budget),
    filters: budgetFiltersJson(budget),
  };
  if (pace !== undefined) {
    status.pace = pace;
  }
  return status;
}

/**
 * Build the pace target for the sub-window containing now.
 *
 * `periodCost` is the budget's spend for the whole current window and
 * `currentCost` its spend within the sub-window. Spend committed *before* this
 * sub-window opened is derived by subtracting the second from the first, which
 * saves a third ledger query and — more importantly — freezes the allowance for
 * the sub-window's duration. Deriving it from spend-up-to-now instead would let
 * spending eat its own allowance: a $2.17 Thursday would drop to $2.00 after $1
 * of spend, reporting $1.00 left rather than $1.17.
 */
function paceStatus(
  budget: UsageBudgetConfig,
  pacePeriod: UsageBudgetPeriod,
  pace: PaceWindow,
  periodCost: number,
  currentCost: number,
): PaceStatus {
  const spendBefore = Math.max(periodCost - currentCost, 0);
  const remainingBudget = Math.max(budget.cost_usd - spendBefore, 0);
  // A trailing sub-window shorter than a whole period (a month leaves ~3 days
  // after four weeks) must not inflate the allowance past what is actually
  // left, so the divisor floors at one.
  const allowance = remainingBudget / Math.max(pace.periods_remaining, 1);

  // `allowance` is zero exactly when the budget is already spent, in which case
  // the budget's own status is over limit too. Such a sub-window is exhausted by
  // definition — nothing may be spent against it — so it reports 100% rather
  // than the `$0.00/$0.00  0%  over_limit` a literal ratio of zeroes would print.
  const percentUsed = allowance > 0 ? currentCost / allowance : 1;
  const [warningThresholds, crossedWarnAt] = crossedThresholds(
    paceWarnAt(budget),
    percentUsed,
  );
  const overLimit = currentCost >= allowance;

  return {
    period: pacePeriod,
    window_start: toRfc3339(pace.start),
    window_end: toRfc3339(pace.end),
    allowance,
    current_cost: currentCost,
    remaining: allowance - currentCost,
    percent_used: percentUsed,
    periods_remaining: pace.periods_remaining,
    status: levelName(overLimit, crossedWarnAt),
    action: paceAction(budget),
    warning_thresholds: warningThresholds,
    crossed_warn_at: crossedWarnAt,
    over_limit: overLimit,
  };
}

/**
 * Sort and de-duplicate configured thresholds, and pick out those `percentUsed`
 * has reached. Shared by the budget cap and its pace so both warn identically.
 */
function crossedThresholds(
  configured: readonly number[],
  percentUsed: number,
): [number[], number[]] {
  const thresholds = [...configured].sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const t of thresholds) {
    const last = deduped[deduped.length - 1];
    // `f64::EPSILON`, matching Rust's `dedup_by`.
    if (last === undefined || Math.abs(t - last) >= Number.EPSILON) {
      deduped.push(t);
    }
  }
  return [deduped, deduped.filter((t) => percentUsed >= t)];
}

function levelName(overLimit: boolean, crossed: readonly number[]): string {
  if (overLimit) {
    return "over_limit";
  }
  return crossed.length === 0 ? "ok" : "warning";
}

function filterForBudget(
  budget: UsageBudgetConfig,
  since: number,
): QueryFilter {
  return {
    since: toRfc3339(since),
    character: budget.character ?? undefined,
    provider: budget.provider ?? undefined,
    api_key_name: budget.api_key ?? undefined,
    model: budget.model ?? undefined,
    call_type: budget.call_type ?? undefined,
    usage_kinds: [...budgetUsageKind(budget)],
  };
}

function budgetName(budget: UsageBudgetConfig, idx: number): string {
  const name = (budget.name ?? "").trim();
  return name === "" ? `budget ${idx + 1}` : name;
}

function budgetFiltersJson(
  budget: UsageBudgetConfig,
): Record<string, unknown> {
  return {
    character: budget.character ?? null,
    provider: budget.provider ?? null,
    api_key: budget.api_key ?? null,
    model: budget.model ?? null,
    call_type: budget.call_type ?? null,
    usage_kind: [...budgetUsageKind(budget)],
  };
}

// ── Enforcement ──────────────────────────────────────────────────────────────

/**
 * Whether `call` may run. Returns the block that stopped it, or `undefined`
 * when every matching budget allows it.
 *
 * A query failure allows the call: a budget that cannot be evaluated must not
 * become an outage. Rust logs and continues here, and so does this.
 */
export function enforceBudgetForCall(
  db: Database,
  config: UsageConfig,
  call: BudgetCallContext,
  now: number,
  opts: EnforceOptions = {},
): BudgetBlock | undefined {
  const budgets = config.budgets ?? [];
  if (budgets.length === 0) {
    return undefined;
  }

  // Subscription-provider calls cost nothing at the margin, so no budget may
  // throttle them — mirrors the `$0`/`cost_source = "subscription"` row that
  // the writer records for these providers.
  if (isSubscriptionProvider(call.provider)) {
    return undefined;
  }

  for (const [idx, budget] of budgets.entries()) {
    if (!budgetMatchesCall(budget, call)) {
      continue;
    }
    let status: BudgetStatus;
    try {
      status = budgetStatus(db, config, budget, idx, now, opts);
    } catch (e) {
      console.error(
        `shore: usage budget "${budgetName(budget, idx)}" query failed; allowing call: ${e}`,
      );
      continue;
    }
    // The projection weighs against the limit but is never reported as spent —
    // the message still names what the ledger holds, so a refusal a person
    // reads reconciles with `shore usage`. Without that, a loop refused at
    // $4.10 of a $5 budget would claim to be over $5 and nothing would agree.
    const projected = opts.projectedCost ?? 0;
    const overWithProjection = status.current_cost + projected >= status.cost_limit;

    // The budget cap is checked first: it is the harder stop, and naming it in
    // the error is more useful than naming the pace that also tripped.
    if (
      overWithProjection &&
      shouldBlock(config, budget, status.action, call.call_type)
    ) {
      return withMessage({
        budget_name: status.name,
        action: status.action,
        current_cost: status.current_cost,
        cost_limit: status.cost_limit,
        period: status.period,
        reset_at: status.reset_at,
        scope: "budget",
        ...(projected > 0 ? { projected_cost: projected } : {}),
      });
    }
    const pace = status.pace;
    if (
      pace !== undefined &&
      pace.current_cost + projected >= pace.allowance &&
      shouldBlock(config, budget, pace.action, call.call_type)
    ) {
      return withMessage({
        budget_name: status.name,
        action: pace.action,
        current_cost: pace.current_cost,
        cost_limit: pace.allowance,
        period: pace.period,
        reset_at: pace.window_end,
        scope: "pace",
        ...(projected > 0 ? { projected_cost: projected } : {}),
      });
    }
  }

  return undefined;
}

function withMessage(block: Omit<BudgetBlock, "message">): BudgetBlock {
  return { ...block, message: blockMessage(block) };
}

function budgetMatchesCall(
  budget: UsageBudgetConfig,
  call: BudgetCallContext,
): boolean {
  const mismatched = (
    configured: string | null | undefined,
    actual: string,
  ): boolean => configured != null && configured !== actual;

  if (mismatched(budget.character, call.character)) {
    return false;
  }
  if (mismatched(budget.provider, call.provider)) {
    return false;
  }
  if (mismatched(budget.model, call.model)) {
    return false;
  }
  if (mismatched(budget.call_type, call.call_type)) {
    return false;
  }
  if (budget.api_key != null) {
    if (budget.api_key !== (call.api_key_name ?? "unknown")) {
      return false;
    }
  }
  const kinds = budgetUsageKind(budget);
  if (
    kinds.length > 0 &&
    !kinds.some((kind) => callTypeMatchesUsageKind(call.call_type, kind))
  ) {
    return false;
  }
  return true;
}

function callTypeMatchesUsageKind(callType: string, usageKind: string): boolean {
  switch (callType) {
    case "message":
      return (
        usageKind === "message" ||
        usageKind === "message_no_tools" ||
        usageKind === "message_with_tools"
      );
    case "tool_loop":
      return usageKind === "message_with_tools" || usageKind === "tool_loop";
    case "heartbeat_tool_loop":
    case "heartbeat":
      return usageKind === "heartbeat";
    case "keepalive":
      return usageKind === "keepalive";
    case "compaction":
      return usageKind === "compaction";
    case "dreaming":
      return usageKind === "dreaming";
    case "memory_query":
      return usageKind === "memory_query";
    case "subagent":
      return usageKind === "subagent";
    default:
      // Rust matches on an exhaustive `CallType` enum; a call type this side
      // does not recognise matches no usage kind rather than every one.
      return false;
  }
}

/** Whether `action` stops this call. Taken as a parameter rather than read off
 *  the budget so the pace can enforce its own action with identical semantics. */
function shouldBlock(
  config: UsageConfig,
  budget: UsageBudgetConfig,
  action: UsageBudgetAction,
  callType: string,
): boolean {
  if (callType === "compaction" && compactionAllowed(config, budget)) {
    return false;
  }
  switch (action) {
    case "warn":
      return false;
    case "block":
      return true;
    case "pause_background":
      return isBackgroundCall(callType);
  }
}

function compactionAllowed(
  config: UsageConfig,
  budget: UsageBudgetConfig,
): boolean {
  return (
    budget.allow_compaction_over_budget ??
    config.allow_compaction_over_budget ??
    true
  );
}

function isBackgroundCall(callType: string): boolean {
  return (
    callType === "heartbeat" ||
    callType === "heartbeat_tool_loop" ||
    callType === "keepalive" ||
    callType === "compaction" ||
    callType === "dreaming" ||
    callType === "memory_query"
  );
}

// ── Spike warnings ───────────────────────────────────────────────────────────

export function spikeWarnings(
  db: Database,
  config: UsageConfig,
  now: number,
  opts: BudgetOptions = {},
): SpikeWarning[] {
  const spike = config.spike_warnings ?? {};
  if (spike.enabled !== true) {
    return [];
  }
  const period = spike.period ?? "hour";
  const multiplierThreshold = spike.multiplier ?? DEFAULT_SPIKE_MULTIPLIER;
  const minCost = spike.min_cost_usd ?? DEFAULT_SPIKE_MIN_COST;
  const timezone = config.timezone ?? DEFAULT_TIMEZONE;

  const current = periodWindow(now, period, timezone, undefined, opts);
  const previousAnchor = current.start - SECOND_MS;
  const previous = periodWindow(
    previousAnchor,
    period,
    timezone,
    undefined,
    opts,
  );

  const currentCost = usageTotals(db, {
    since: toRfc3339(current.start),
  }).total_cost;
  const previousCost = usageTotals(db, {
    since: toRfc3339(previous.start),
    until: toRfc3339(current.start),
  }).total_cost;

  if (currentCost < minCost) {
    return [];
  }

  const multiplier = previousCost > 0 ? currentCost / previousCost : null;
  const isSpike =
    multiplier === null ? previousCost === 0 : multiplier >= multiplierThreshold;
  if (!isSpike) {
    return [];
  }

  const debug = periodDebug(period);
  const message =
    multiplier === null
      ? `Current ${debug} spend is $${formatFixed(currentCost, 2)}; the previous ${debug} had no recorded cost.`
      : `Current ${debug} spend is ${formatFixed(multiplier, 1)}x the previous ${debug} ($${formatFixed(currentCost, 2)} vs $${formatFixed(previousCost, 2)}).`;

  return [
    {
      period,
      period_start: toRfc3339(current.start),
      previous_period_start: toRfc3339(previous.start),
      timezone: current.timezone,
      current_cost: currentCost,
      previous_cost: previousCost,
      multiplier,
      threshold_multiplier: multiplierThreshold,
      min_cost_usd: minCost,
      message,
    },
  ];
}

// ── Threshold warnings ───────────────────────────────────────────────────────

/**
 * Newly crossed budget warning thresholds, recording each
 * budget/window/threshold so future checks don't repeat the same warning.
 *
 * Once a budget is over its limit, the warning re-fires on every check
 * regardless of dedup — intermediate thresholds (50%, 80%) staying one-shot is
 * the right call for noise, but "still over budget" is an active signal the
 * operator needs to keep seeing as spend continues to accrue.
 */
export function newlyCrossedBudgetWarnings(
  db: Database,
  config: UsageConfig,
  now: number,
  opts: BudgetOptions = {},
): UsageBudgetWarningEvent[] {
  const events: UsageBudgetWarningEvent[] = [];
  const zone = zoneFor("local", opts.localZone);

  for (const status of budgetStatuses(db, config, now, opts)) {
    const budgetEvent = scopeWarning(db, budgetScopeView(status), now, zone);
    if (budgetEvent !== undefined) {
      events.push(budgetEvent);
    }
    const pace = status.pace;
    if (pace !== undefined) {
      const paceEvent = scopeWarning(
        db,
        paceScopeView(status, pace),
        now,
        zone,
      );
      if (paceEvent !== undefined) {
        events.push(paceEvent);
      }
    }
  }

  return events;
}

/** One limit's warning-relevant state, so budget-scope and pace-scope warnings
 *  share a single threshold/dedup/re-fire implementation. */
interface ScopeView {
  name: string;
  scope: BudgetScope;
  period: UsageBudgetPeriod;
  window_start: string;
  reset_at: string;
  current_cost: number;
  cost_limit: number;
  percent_used: number;
  crossed_warn_at: readonly number[];
  over_limit: boolean;
}

function budgetScopeView(status: BudgetStatus): ScopeView {
  return {
    name: status.name,
    scope: "budget",
    period: status.period,
    window_start: status.period_start,
    reset_at: status.reset_at,
    current_cost: status.current_cost,
    cost_limit: status.cost_limit,
    percent_used: status.percent_used,
    crossed_warn_at: status.crossed_warn_at,
    over_limit: status.over_limit,
  };
}

function paceScopeView(status: BudgetStatus, pace: PaceStatus): ScopeView {
  return {
    name: status.name,
    scope: "pace",
    period: pace.period,
    window_start: pace.window_start,
    reset_at: pace.window_end,
    current_cost: pace.current_cost,
    cost_limit: pace.allowance,
    percent_used: pace.percent_used,
    crossed_warn_at: pace.crossed_warn_at,
    over_limit: pace.over_limit,
  };
}

function scopeWarning(
  db: Database,
  view: ScopeView,
  now: number,
  zone: string,
): UsageBudgetWarningEvent | undefined {
  const newlyCrossed: number[] = [];
  for (const threshold of view.crossed_warn_at) {
    if (
      recordBudgetWarningThreshold(
        db,
        view.name,
        view.scope,
        view.window_start,
        threshold,
        now,
      )
    ) {
      newlyCrossed.push(threshold);
    }
  }
  if (newlyCrossed.length === 0 && view.over_limit) {
    newlyCrossed.push(1);
  }
  if (newlyCrossed.length === 0) {
    return undefined;
  }

  const highest = newlyCrossed.reduce((a, b) => Math.max(a, b), 0);
  const resetDisplay = formatLocalAmPm(view.reset_at, zone);
  const percent = formatFixed(fractionToPercent(highest), 0);
  const spent = `$${formatFixed(view.current_cost, 2)}/$${formatFixed(view.cost_limit, 2)}`;
  const message =
    view.scope === "budget"
      ? `Usage budget "${view.name}" reached ${percent}% (${spent}); resets at ${resetDisplay}.`
      : `Usage budget "${view.name}" ${view.period} pace reached ${percent}% (${spent}); pace resets at ${resetDisplay}.`;

  return {
    budget: view.name,
    message,
    current_cost: view.current_cost,
    cost_limit: view.cost_limit,
    percent_used: view.percent_used,
    crossed_warn_at: newlyCrossed,
    period: view.period,
    period_start: view.window_start,
    reset_at: view.reset_at,
    reset_at_display: resetDisplay,
    scope: view.scope,
  };
}

function fractionToPercent(fraction: number): number {
  return fraction * 100;
}

function recordBudgetWarningThreshold(
  db: Database,
  budgetName: string,
  scope: BudgetScope,
  periodStart: string,
  threshold: number,
  now: number,
): boolean {
  const thresholdKey = `${thresholdPrefix(scope)}${formatFixed(threshold, 6)}`;
  const changes = db
    .query(
      `INSERT OR IGNORE INTO usage_budget_warnings
               (budget_name, period_start, threshold, created_at)
               VALUES (?1, ?2, ?3, ?4)`,
    )
    .run(budgetName, periodStart, thresholdKey, toRfc3339(now));
  return changes.changes > 0;
}
