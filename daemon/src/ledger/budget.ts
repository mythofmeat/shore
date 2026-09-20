import { shoreLog } from "../log.ts";

import type { Database } from "bun:sqlite";

import type { UsageConfig as AppUsageConfig } from "../config/app.ts";

import { isSubscriptionCall } from "./store.ts";
import { usageCostEntries, usageTotals, type QueryFilter } from "./query.ts";
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
  asNaive,
  type Naive,
} from "./zoned.ts";

export type UsageBudgetPeriod = "hour" | "day" | "week" | "month";
export type UsageBudgetAction = "warn" | "block" | "pause_background" | "pause_heartbeat";
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
  warn_action?: UsageBudgetAction | null;
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
  pace_warn_action?: UsageBudgetAction | null;
}

export interface UsageConfig {
  timezone?: string;
  budgets?: UsageBudgetConfig[];
}

export function usageConfigView(cfg: AppUsageConfig): UsageConfig {
  return {
    timezone: cfg.timezone,
    budgets: cfg.budgets.map(
      (b) => defined(b as unknown as Record<string, unknown>) as unknown as UsageBudgetConfig,
    ),
  };
}

function defined(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));
}

const DEFAULT_WARN_AT: readonly number[] = [0.8, 1.0];
const DEFAULT_TIMEZONE = "local";

const budgetPeriod = (b: UsageBudgetConfig): UsageBudgetPeriod =>
  b.period ?? "day";
const budgetWarnAt = (b: UsageBudgetConfig): readonly number[] =>
  b.warn_at ?? DEFAULT_WARN_AT;
const budgetLimit = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.limit ?? "warn";
const budgetUsageKind = (b: UsageBudgetConfig): readonly string[] =>
  b.usage_kind ?? [];
const paceAction = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.pace_action ?? "warn";
const paceWarnAt = (b: UsageBudgetConfig): readonly number[] =>
  b.pace_warn_at ?? budgetWarnAt(b);
const budgetWarnAction = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.warn_action ?? "warn";
const paceWarnAction = (b: UsageBudgetConfig): UsageBudgetAction =>
  b.pace_warn_action ?? budgetWarnAction(b);

function formatFixed(value: number, digits: number): string {
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
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;

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

const periodDebug = (p: UsageBudgetPeriod): string =>
  ({ hour: "Hour", day: "Day", week: "Week", month: "Month" })[p];
const actionDebug = (a: UsageBudgetAction): string =>
  ({
    warn: "Warn",
    block: "Block",
    pause_background: "PauseBackground",
    pause_heartbeat: "PauseHeartbeat",
  })[a];

const WEEKDAY_FROM_MONDAY: Record<BudgetWeekday, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export interface PaceStatus {
  period: UsageBudgetPeriod;
  window_start: string;
  window_end: string;
  allowance: number;
  base_allowance: number;
  rollover: number;
  debt_adjustment: number;
  current_cost: number;
  remaining: number;
  percent_used: number;
  periods_remaining: number;
  status: string;
  action: UsageBudgetAction;
  effective_action: UsageBudgetAction;
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
  effective_action: UsageBudgetAction;
  warning_thresholds: number[];
  crossed_warn_at: number[];
  over_limit: boolean;
  compaction_allowed_over_budget: boolean;
  filters: Record<string, unknown>;
  pace?: PaceStatus;
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
  reset_at_display: string;
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
  period: UsageBudgetPeriod;
  reset_at: string;
  scope: BudgetScope;
  projected_cost?: number;
  warn_threshold?: number;
  message: string;
  summary: string;
}

export type BudgetScope = "budget" | "pace";

const thresholdPrefix = (scope: BudgetScope): string =>
  scope === "pace" ? "pace:" : "";

export interface BudgetOptions {
  localZone?: string;
}

export interface EnforceOptions extends BudgetOptions {
  projectedCost?: number;
}

function blockMessage(block: Omit<BudgetBlock, "message" | "summary">): string {
  const threshold = block.warn_threshold;
  if (threshold !== undefined) {
    const window =
      block.scope === "budget"
        ? `$${formatFixed(block.cost_limit, 2)} for ${periodDebug(block.period)}`
        : `the ${block.period} pace allowance of $${formatFixed(block.cost_limit, 2)}`;
    const projected = block.projected_cost;
    const spend =
      projected !== undefined && projected > 0
        ? `$${formatFixed(block.current_cost, 2)} spent plus up to $${formatFixed(projected, 2)} projected`
        : `$${formatFixed(block.current_cost, 2)} spent`;
    return (
      `Shore usage budget "${block.budget_name}" is past its ` +
      `${formatFixed(threshold * 100, 0)}% warning threshold (${spend}, against ${window}); ` +
      `action ${actionDebug(block.action)}; resets at ${block.reset_at}`
    );
  }

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

interface PeriodWindow {
  start: number;
  end: number;
  start_naive: Naive;
  end_naive: Naive;
  timezone: string;
  zone: string;
}

interface BudgetAnchors {
  hour: number;
  day_of_week: number;
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
      budget.reset_day_of_week === null || budget.reset_day_of_week === undefined
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
      return atHour(asNaive(now - DAY_MS), anchors.hour);
    }
    case "week": {
      const todayDow = daysFromMonday(now);
      const daysBack = (todayDow + 7 - anchors.day_of_week) % 7;
      const candidate = atHour(asNaive(now - daysBack * DAY_MS), anchors.hour);
      if (now >= candidate) {
        return candidate;
      }
      return atHour(asNaive(candidate - 7 * DAY_MS), anchors.hour);
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
      return asNaive(start + HOUR_MS);
    case "day":
      return asNaive(start + DAY_MS);
    case "week":
      return asNaive(start + 7 * DAY_MS);
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

interface PaceSlice {
  start: number;
  end: number;
  weight: number;
  periods_remaining: number;
}

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

function paceSlices(
  window: PeriodWindow,
  now: number,
  pace: UsageBudgetPeriod,
): PaceSlice[] {
  const step = paceStep(pace);
  if (step === undefined) return [];
  const stepSecs = Math.trunc(step / SECOND_MS);
  if (stepSecs <= 0) return [];

  const nowNaive = naiveInZone(now, window.zone);
  const slices: PaceSlice[] = [];
  for (
    let start = window.start_naive;
    start < window.end_naive;
    start = asNaive(start + stepSecs * SECOND_MS)
  ) {
    const end = asNaive(Math.min(start + stepSecs * SECOND_MS, window.end_naive));
    const remainingSecs = Math.max(
      Math.trunc((window.end_naive - start) / SECOND_MS),
      0,
    );
    slices.push({
      start: resolveInZone(start, window.zone),
      end: resolveInZone(end, window.zone),
      weight: Math.max(Math.trunc((end - start) / SECOND_MS), 0) / stepSecs,
      periods_remaining: remainingSecs / stepSecs,
    });
    if (nowNaive < end) break;
  }
  return slices;
}

interface PaceBounds {
  start: Naive;
  end: Naive;
  periods_remaining: number;
}

function paceBoundsNaive(
  window: Pick<PeriodWindow, "start_naive" | "end_naive">,
  nowNaive: Naive,
  stepMs: number,
): PaceBounds | undefined {
  if (stepMs <= 0) {
    return undefined;
  }
  const stepSecs = Math.trunc(stepMs / SECOND_MS);
  if (stepSecs <= 0) {
    return undefined;
  }
  const elapsedSecs = Math.max(
    Math.trunc((nowNaive - window.start_naive) / SECOND_MS),
    0,
  );
  const offsetSecs = Math.trunc(elapsedSecs / stepSecs) * stepSecs;
  const start = asNaive(window.start_naive + offsetSecs * SECOND_MS);
  const end = asNaive(Math.min(start + stepSecs * SECOND_MS, window.end_naive));
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

export interface BudgetWindow {
  start: number;
  period: UsageBudgetPeriod;
  budget_name: string | undefined;
}

export function narrowestBudgetWindow(
  config: UsageConfig,
  now: number,
  opts: BudgetOptions = {},
): BudgetWindow | undefined {
  let narrowest: BudgetWindow | undefined;
  for (const budget of config.budgets ?? []) {
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
    const pace =
      pacePeriod === undefined ? undefined : paceWindow(window, now, pacePeriod);

    const candidate: BudgetWindow =
      pace === undefined
        ? { start: window.start, period, budget_name: budget.name }
        : { start: pace.start, period: pacePeriod as UsageBudgetPeriod, budget_name: budget.name };

    if (narrowest === undefined || candidate.start > narrowest.start) {
      narrowest = candidate;
    }
  }
  return narrowest;
}

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

  const filter = filterForBudget(budget, window.start);
  const currentCost = usageTotals(
    db,
    filter,
  ).total_cost + pendingAttemptCost(db, budget, window.start);
  const paceCost =
    sub === undefined
      ? undefined
      : usageTotals(db, filterForBudget(budget, sub.start)).total_cost +
        pendingAttemptCost(db, budget, sub.start);

  const costLimit = budget.cost_usd;
  const percentUsed = currentCost / costLimit;
  const [warningThresholds, crossedWarnAt] = crossedThresholds(
    budgetWarnAt(budget),
    percentUsed,
  );
  const overLimit = currentCost >= costLimit;
  const pace =
    sub !== undefined && paceCost !== undefined && pacePeriod !== undefined
      ? paceStatus(
          db,
          budget,
          pacePeriod,
          sub,
          window,
          now,
          paceCost,
        )
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
    effective_action: effectiveAction(
      overLimit,
      crossedWarnAt,
      budgetLimit(budget),
      budgetWarnAction(budget),
    ),
    warning_thresholds: warningThresholds,
    crossed_warn_at: crossedWarnAt,
    over_limit: overLimit,
    compaction_allowed_over_budget: compactionAllowed(budget),
    filters: budgetFiltersJson(budget),
  };
  if (pace !== undefined) {
    status.pace = pace;
  }
  return status;
}

function pendingAttemptCost(
  db: Database,
  budget: UsageBudgetConfig,
  since: number,
): number {
  const clauses = ["status IN ('pending', 'unresolved')", "started_at >= $since"];
  const bindings: Record<string, string> = { $since: toRfc3339(since) };
  const add = (column: string, key: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    clauses.push(`${column} = $${key}`);
    bindings[`$${key}`] = value;
  };
  add("character", "character", budget.character);
  add("provider", "provider", budget.provider);
  add("api_key_name", "api_key", budget.api_key);
  add("model", "model", budget.model);
  add("call_type", "call_type", budget.call_type);
  const kinds = budgetUsageKind(budget);
  if (kinds.length > 0) {
    const accepted = [
      "message",
      "tool_loop",
      "heartbeat",
      "heartbeat_tool_loop",
      "keepalive",
      "compaction",
      "dreaming",
      "memory_query",
      "subagent",
    ].filter((callType) => kinds.some((kind) => callTypeMatchesUsageKind(callType, kind)));
    if (accepted.length === 0) return 0;
    const placeholders = accepted.map((callType, index) => {
      const key = `$kind_${index}`;
      bindings[key] = callType;
      return key;
    });
    clauses.push(`call_type IN (${placeholders.join(", ")})`);
  }
  const row = db.query(
    `SELECT COALESCE(SUM(estimated_cost), 0) AS total
       FROM call_attempts WHERE ${clauses.join(" AND ")}`,
  ).get(bindings) as { total?: unknown } | null;
  return typeof row?.total === "number" && Number.isFinite(row.total) ? row.total : 0;
}

function paceStatus(
  db: Database,
  budget: UsageBudgetConfig,
  pacePeriod: UsageBudgetPeriod,
  pace: PaceWindow,
  window: PeriodWindow,
  now: number,
  currentCost: number,
): PaceStatus {
  const slices = paceSlices(window, now, pacePeriod);
  const currentIndex = Math.max(slices.length - 1, 0);
  const totalPeriods = slices[0]?.periods_remaining ?? pace.periods_remaining;
  const nominal = budget.cost_usd / Math.max(totalPeriods, 1);
  const entries = usageCostEntries(db, filterForBudget(budget, window.start));
  const completedSpend = Array.from({ length: currentIndex }, () => 0);
  let sliceIndex = 0;
  for (const entry of entries) {
    const ts = Date.parse(entry.ts);
    while (
      sliceIndex < currentIndex &&
      ts >= (slices[sliceIndex]?.end ?? Number.POSITIVE_INFINITY)
    ) {
      sliceIndex += 1;
    }
    if (sliceIndex >= currentIndex) break;
    const slice = slices[sliceIndex];
    if (slice !== undefined && ts >= slice.start && ts < slice.end) {
      completedSpend[sliceIndex] =
        (completedSpend[sliceIndex] ?? 0) + entry.total_cost;
    }
  }

  let rollover = 0;
  let debt = 0;
  for (let i = 0; i < currentIndex; i += 1) {
    const slice = slices[i];
    if (slice === undefined) continue;
    const nominalBase = nominal * slice.weight;
    const debtPayment = Math.min(
      nominalBase,
      debt * (slice.weight / Math.max(slice.periods_remaining, slice.weight)),
    );
    const adjustedBase = Math.max(nominalBase - debtPayment, 0);
    debt = Math.max(debt - debtPayment, 0);
    const spend = completedSpend[i] ?? 0;
    if (spend <= adjustedBase) {
      let slack = adjustedBase - spend;
      const repaid = Math.min(slack, debt);
      debt -= repaid;
      slack -= repaid;
      rollover += slack;
    } else {
      let excess = spend - adjustedBase;
      const fromRollover = Math.min(excess, rollover);
      rollover -= fromRollover;
      excess -= fromRollover;
      debt += excess;
    }
  }

  const currentSlice = slices[currentIndex];
  const currentWeight = currentSlice?.weight ?? 1;
  const nominalBase = nominal * currentWeight;
  const debtAdjustment = Math.min(
    nominalBase,
    debt * (currentWeight / Math.max(pace.periods_remaining, currentWeight)),
  );
  const baseAllowance = Math.max(nominalBase - debtAdjustment, 0);
  const allowance = baseAllowance + rollover;

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
    base_allowance: baseAllowance,
    rollover,
    debt_adjustment: debtAdjustment,
    current_cost: currentCost,
    remaining: allowance - currentCost,
    percent_used: percentUsed,
    periods_remaining: pace.periods_remaining,
    status: levelName(overLimit, crossedWarnAt),
    action: paceAction(budget),
    effective_action: effectiveAction(
      overLimit,
      crossedWarnAt,
      paceAction(budget),
      paceWarnAction(budget),
    ),
    warning_thresholds: warningThresholds,
    crossed_warn_at: crossedWarnAt,
    over_limit: overLimit,
  };
}

function crossedThresholds(
  configured: readonly number[],
  percentUsed: number,
): [number[], number[]] {
  const thresholds = [...configured].sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const t of thresholds) {
    const last = deduped[deduped.length - 1];
    if (last === undefined || Math.abs(t - last) >= Number.EPSILON) {
      deduped.push(t);
    }
  }
  return [deduped, deduped.filter((t) => percentUsed >= t)];
}

function effectiveAction(
  overLimit: boolean,
  crossed: readonly number[],
  limitAction: UsageBudgetAction,
  warnAction: UsageBudgetAction,
): UsageBudgetAction {
  if (overLimit || crossed.length === 0) {
    return limitAction;
  }
  return warnAction;
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

  if (isSubscriptionCall(call.provider, call.model, now, call.character)) {
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
      shoreLog.error(
        `shore: usage budget "${budgetName(budget, idx)}" query failed; allowing call: ${String(e)}`,
      );
      continue;
    }
    const zone = zoneFor(status.timezone, opts.localZone);
    const projected = opts.projectedCost ?? 0;
    const overWithProjection = status.current_cost + projected >= status.cost_limit;

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
      }, zone);
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
      }, zone);
    }

    const warnAction = budgetWarnAction(budget);
    const crossedBudget = highestCrossed(
      budgetWarnAt(budget),
      status.current_cost + projected,
      status.cost_limit,
    );
    if (
      crossedBudget !== undefined &&
      shouldBlock(config, budget, warnAction, call.call_type)
    ) {
      return withMessage({
        budget_name: status.name,
        action: warnAction,
        current_cost: status.current_cost,
        cost_limit: status.cost_limit,
        period: status.period,
        reset_at: status.reset_at,
        scope: "budget",
        warn_threshold: crossedBudget,
        ...(projected > 0 ? { projected_cost: projected } : {}),
      }, zone);
    }

    const paceWarn = paceWarnAction(budget);
    const crossedPace =
      pace === undefined
        ? undefined
        : highestCrossed(paceWarnAt(budget), pace.current_cost + projected, pace.allowance);
    if (
      pace !== undefined &&
      crossedPace !== undefined &&
      shouldBlock(config, budget, paceWarn, call.call_type)
    ) {
      return withMessage({
        budget_name: status.name,
        action: paceWarn,
        current_cost: pace.current_cost,
        cost_limit: pace.allowance,
        period: pace.period,
        reset_at: pace.window_end,
        scope: "pace",
        warn_threshold: crossedPace,
        ...(projected > 0 ? { projected_cost: projected } : {}),
      }, zone);
    }
  }

  return undefined;
}

function highestCrossed(
  thresholds: readonly number[],
  spend: number,
  limit: number,
): number | undefined {
  const percentUsed = limit > 0 ? spend / limit : 1;
  let highest: number | undefined;
  for (const t of thresholds) {
    if (percentUsed >= t && (highest === undefined || t > highest)) highest = t;
  }
  return highest;
}

function withMessage(block: Omit<BudgetBlock, "message" | "summary">, zone: string): BudgetBlock {
  return { ...block, message: blockMessage(block), summary: blockSummary(block, zone) };
}

function blockSummary(block: Omit<BudgetBlock, "message" | "summary">, zone: string): string {
  const spent = `$${formatFixed(block.current_cost, 2)}/$${formatFixed(block.cost_limit, 2)}`;
  const resets = `resets ${formatLocalAmPm(block.reset_at, zone)}`;
  const paced = block.scope === "pace" ? `${block.period} pace ` : "";
  const name = `budget "${block.budget_name}"`;

  const threshold = block.warn_threshold;
  if (threshold !== undefined) {
    return `${name} ${paced}reached ${formatFixed(threshold * 100, 0)}% (${spent}); ${resets}`;
  }

  const projected = block.projected_cost;
  if (projected !== undefined && projected > 0) {
    return (
      `${name} ${paced}would be spent by this tool loop ` +
      `(${spent} plus up to $${formatFixed(projected, 2)}); ${resets}`
    );
  }

  return block.scope === "pace"
    ? `${name} ${block.period} pace is spent (${spent}); ${resets}`
    : `${name} is over its ${periodDebug(block.period).toLowerCase()} limit (${spent}); ${resets}`;
}

function budgetMatchesCall(
  budget: UsageBudgetConfig,
  call: BudgetCallContext,
): boolean {
  const mismatched = (
    configured: string | null | undefined,
    actual: string,
  ): boolean => configured !== null && configured !== undefined && configured !== actual;

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
  if (budget.api_key !== null && budget.api_key !== undefined) {
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
      return false;
  }
}

function shouldBlock(
  config: UsageConfig,
  budget: UsageBudgetConfig,
  action: UsageBudgetAction,
  callType: string,
): boolean {
  if (callType === "compaction" && compactionAllowed(budget)) {
    return false;
  }
  switch (action) {
    case "warn":
      return false;
    case "block":
      return true;
    case "pause_background":
      return isBackgroundCall(callType);
    case "pause_heartbeat":
      return isHeartbeatCall(callType);
  }
}

function compactionAllowed(
  budget: UsageBudgetConfig,
): boolean {
  return budget.allow_compaction_over_budget ?? false;
}

function isBackgroundCall(callType: string): boolean {
  return (
    isHeartbeatCall(callType) ||
    callType === "keepalive" ||
    callType === "compaction" ||
    callType === "dreaming" ||
    callType === "memory_query"
  );
}

function isHeartbeatCall(callType: string): boolean {
  return callType === "heartbeat" || callType === "heartbeat_tool_loop";
}

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
  name: string,
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
    .run(name, periodStart, thresholdKey, toRfc3339(now));
  return changes.changes > 0;
}
