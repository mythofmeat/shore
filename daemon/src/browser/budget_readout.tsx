import { useEffect, useState } from "react";
import type { UsageBudget } from "../protocol/UsageBudget.ts";
import type { Workspace, WorkspaceSnapshot } from "./workspace.ts";
import { focusedBudget, showUsage } from "./budget_display.ts";
import { useDisplay } from "./display_state.tsx";

export function useBudgets(workspace: Workspace, state: WorkspaceSnapshot, enabled: boolean) {
  const [result, setResult] = useState<{ budgets: UsageBudget[]; error: string; key: string }>({ budgets: [], error: "", key: "" });
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([state.status, state.character, state.thread]);
  const warning = state.activity.findLast((entry) => entry.type === "usage_warning")?.id;
  const available = state.operations.find((operation) => operation.name === "usage")?.available === true;
  useEffect(() => {
    if (!enabled || !available || state.status !== "ready") { setResult({ budgets: [], error: "", key: "" }); return; }
    let active = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const report = await workspace.actions.run("usage", { budget: true });
        if (report.mode !== "budget") throw new Error("Expected the budget report");
        if (active) setResult({ budgets: report.budgets, error: "", key });
      } catch (error) { if (active) setResult((previous) => ({ budgets: previous.key === key ? previous.budgets : [], error: error instanceof Error ? error.message : String(error), key })); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [workspace, key, state.status, state.messages, enabled, available, warning, refresh]);
  return { budgets: result.key === key ? result.budgets : [], error: result.key === key ? result.error : "", refresh: () => setRefresh((value) => value + 1) };
}

export function BudgetReadout({ budgets, error, refresh, open }: { budgets: UsageBudget[]; error: string; refresh: () => void; open: () => void }) {
  const display = useDisplay();
  const mode = display.option("usage");
  const selected = focusedBudget(budgets, display.option("budget"));
  if (mode === "off" || (mode === "warn" && error === "" && (selected === undefined || !showUsage(mode, selected.budget)))) return null;
  return <div className="budget-readout" aria-label="Usage readout">
    {error === "" ? null : <p role="status">Budget readings may be stale: {error}<button onClick={refresh}>Refresh budget reading</button></p>}
    {selected === undefined ? mode === "always" ? <p className="muted">No matching budget reading.</p> : null : showUsage(mode, selected.budget) ? <button onClick={open} aria-label={`Inspect budget ${selected.budget.name}`}><strong>{selected.budget.name}</strong> · {selected.scope === "pace" ? "Pace" : "Cap"} <meter min={0} max={1} value={Math.max(0, Math.min(1, selected.level.percent_used))} aria-label="Budget used" /> {Math.round(selected.level.percent_used * 100)}%{selected.level.over_limit ? " · over limit" : ""}</button> : null}
  </div>;
}
