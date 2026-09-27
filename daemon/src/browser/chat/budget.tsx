import { useEffect, useState } from "react";
import type { ClaudePlanLimit } from "../../protocol/ClaudePlanLimit.ts";
import type { ClaudePlanLimitsReport } from "../../protocol/ClaudePlanLimitsReport.ts";
import type { ClaudePlanWindow } from "../../protocol/ClaudePlanWindow.ts";
import type { UsageBudget } from "../../protocol/UsageBudget.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { focusedBudget, levelWarning, showPlanLimit, showUsage } from "../budget_display.ts";
import { configAt } from "../settings_forms.ts";
import { navigate } from "../app/route.ts";
import { useDisplay, workspace } from "../app/state.ts";

const PLAN_WINDOWS: Record<ClaudePlanWindow, [string, string]> = { five_hour: ["5h", "Claude 5-hour limit"], seven_day: ["7d", "Claude weekly limit"] };

function PlanChip({ plan, mode }: { plan: ClaudePlanLimitsReport; mode: string }) {
  let shown: ClaudePlanLimit[];
  try { shown = plan.windows.filter((limit) => showPlanLimit(mode, limit)); } catch { shown = []; }
  if (shown.length === 0) return null;
  const percentOf = (fraction: number) => Math.round(fraction * 100);
  return <button type="button" className="budget-chip" title={shown.map((limit) => `${PLAN_WINDOWS[limit.window][1]}: ${String(percentOf(limit.percent_used))}% used`).join(" · ")} onClick={() => navigate({ view: "settings", page: "usage" })}>
    {shown.map((limit) => <span key={limit.window} className={`budget-chip-window ${levelWarning(limit) ? "warning" : ""}`}>
      <span className="budget-chip-bar"><span style={{ width: `${String(Math.min(100, percentOf(limit.percent_used)))}%` }} /></span>
      <span>{PLAN_WINDOWS[limit.window][0]} {percentOf(limit.percent_used)}%</span>
    </span>)}
  </button>;
}

export function BudgetChip({ state }: { state: WorkspaceSnapshot }) {
  const values = useDisplay();
  const [budgets, setBudgets] = useState<UsageBudget[]>([]);
  const [plan, setPlan] = useState<ClaudePlanLimitsReport | undefined>(undefined);
  const finished = state.activity.filter((item) => item.type === "request_finished").length;
  useEffect(() => {
    if (values.usage === "off" || state.status !== "ready") return;
    let alive = true;
    workspace.actions.run("usage", { budget: true }, { remember: false }).then((result) => { if (alive && result.mode === "budget") { setBudgets(result.budgets); setPlan(result.claude_plan_limits); } }).catch(() => { if (alive) { setBudgets([]); setPlan(undefined); } });
    return () => { alive = false; };
  }, [values.usage, state.status, state.character, state.thread, configAt(state.config, "active_model"), finished]);
  if (values.usage === "off") return null;
  if (plan !== undefined) return <PlanChip plan={plan} mode={values.usage} />;
  let focused;
  try { focused = focusedBudget(budgets, values.budget); } catch { focused = undefined; }
  if (focused === undefined || !showUsage(values.usage, focused.budget)) return null;
  const budget = budgets.find((item) => item.name === focused.budget.name);
  const percent = Math.round(focused.level.percent_used * 100);
  const warning = focused.level.over_limit || focused.level.crossed_warn_at.length > 0;
  return <button type="button" className={`budget-chip ${warning ? "warning" : ""}`} title={`${focused.budget.name}: ${String(percent)}% of its ${focused.scope === "pace" ? "pace" : "cap"} used`} onClick={() => navigate({ view: "settings", page: "usage" })}>
    <span className="budget-chip-bar"><span style={{ width: `${String(Math.min(100, percent))}%` }} /></span>
    <span>{focused.budget.name} {percent}%{budget === undefined ? "" : ` · $${budget.current_cost.toFixed(2)}`}</span>
  </button>;
}
