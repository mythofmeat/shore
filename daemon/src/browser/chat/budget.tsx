import { useEffect, useState } from "react";
import type { UsageBudget } from "../../protocol/UsageBudget.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { focusedBudget, showUsage } from "../budget_display.ts";
import { navigate } from "../app/route.ts";
import { useDisplay, workspace } from "../app/state.ts";

export function BudgetChip({ state }: { state: WorkspaceSnapshot }) {
  const values = useDisplay();
  const [budgets, setBudgets] = useState<UsageBudget[]>([]);
  const finished = state.activity.filter((item) => item.type === "request_finished").length;
  useEffect(() => {
    if (values.usage === "off" || state.status !== "ready") return;
    let alive = true;
    workspace.actions.run("usage", { budget: true }, { remember: false }).then((result) => { if (alive && result.mode === "budget") setBudgets(result.budgets); }).catch(() => { if (alive) setBudgets([]); });
    return () => { alive = false; };
  }, [values.usage, state.status, state.character, finished]);
  if (values.usage === "off") return null;
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
