import type { UsageBudget } from "../protocol/UsageBudget.ts";
import type { UsagePace } from "../protocol/UsagePace.ts";
import { budgetFocus, type BudgetScope } from "./preferences.ts";

export type DisplayLevel = Pick<UsageBudget, "percent_used" | "over_limit" | "crossed_warn_at">;
export type DisplayBudget = DisplayLevel & Pick<UsageBudget, "name"> & { pace?: Pick<UsagePace, "percent_used" | "over_limit" | "crossed_warn_at"> };
export const levelWarning = (level: DisplayLevel): boolean => level.over_limit || level.crossed_warn_at.length > 0;
export const budgetWarning = (budget: DisplayBudget): boolean => levelWarning(budget) || (budget.pace !== undefined && levelWarning(budget.pace));

export function budgetLevel(budget: DisplayBudget, scope: BudgetScope): { level: DisplayLevel; scope: "cap" | "pace" } {
  const pace = budget.pace;
  switch (scope) {
    case "cap": return { level: budget, scope: "cap" };
    case "pace": return pace === undefined ? { level: budget, scope: "cap" } : { level: pace, scope: "pace" };
    case "auto": {
      const preferPace = pace !== undefined && (levelWarning(pace) !== levelWarning(budget) ? levelWarning(pace) : pace.percent_used > budget.percent_used);
      return preferPace && pace !== undefined ? { level: pace, scope: "pace" } : { level: budget, scope: "cap" };
    }
  }
}

export function focusedBudget(budgets: readonly DisplayBudget[], value: string): { budget: DisplayBudget; level: DisplayLevel; scope: "cap" | "pace" } | undefined {
  const focus = budgetFocus(value);
  const budget = focus.name === null
    ? budgets.reduce<DisplayBudget | undefined>((selected, current) => selected === undefined || budgetLevel(current, focus.scope).level.percent_used >= budgetLevel(selected, focus.scope).level.percent_used ? current : selected, undefined)
    : budgets.find((item) => item.name.toLowerCase() === focus.name?.toLowerCase());
  return budget === undefined ? undefined : { budget, ...budgetLevel(budget, focus.scope) };
}

export function showPlanLimit(mode: string, limit: DisplayLevel): boolean {
  return showUsage(mode, { name: "", percent_used: limit.percent_used, over_limit: limit.over_limit, crossed_warn_at: limit.crossed_warn_at });
}

export function showUsage(mode: string, budget: DisplayBudget): boolean {
  switch (mode) {
    case "off": return false;
    case "always": return true;
    case "warn": return budgetWarning(budget);
    default: throw new Error(`Unsupported usage display mode: ${mode}`);
  }
}
