import { useState, type ReactNode } from "react";
import type { ClaudePlanLimit } from "../../protocol/ClaudePlanLimit.ts";
import type { ClaudePlanLimitsReport } from "../../protocol/ClaudePlanLimitsReport.ts";
import type { UsageArgs } from "../../protocol/UsageArgs.ts";
import type { UsageBudget } from "../../protocol/UsageBudget.ts";
import type { UsageDimension } from "../../protocol/UsageDimension.ts";
import type { UsageResult } from "../../protocol/UsageResult.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { budgetFocus, VIEW_CONTROLS } from "../preferences.ts";
import { PLAN_WINDOWS } from "../budget_display.ts";
import { toasts } from "../ui/toast.tsx";
import { display, useDisplay, workspace } from "../app/state.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";
import { downloadText, formatCost, formatNumber, formatTime, Loading, useAction, useOperation } from "./shared.tsx";

const PERIODS = [["", "Current budget window"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["all", "All time"]] as const;
const DIMENSIONS: readonly [UsageDimension, string][] = [["model", "Model"], ["provider", "Provider"], ["call_type", "Call type"], ["kind", "Kind"], ["api_key", "API key"], ["cost_source", "Cost source"]];
type View = "summary" | "grouped" | "budget" | "anomalies";

export function BudgetBar({ budget }: { budget: UsageBudget }) {
  const used = budget.percent_used * 100;
  const percent = Math.min(100, Math.max(0, used));
  return <div className="budget">
    <div className="budget-head"><span className="setting-label">{budget.name}</span><span className="mono">{formatCost(budget.current_cost)} of {formatCost(budget.cost_limit)}</span></div>
    <div className={`budget-track ${budget.status}`} role="progressbar" aria-label={`${budget.name} budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${String(percent)}%` }} /></div>
    <div className="setting-description">{Math.round(used)}% used · {budget.period} · resets {formatTime(budget.reset_at)}{budget.over_limit ? ` · over limit (${budget.effective_action})` : ""}{budget.pace === undefined ? "" : ` · pace ${String(Math.round(budget.pace.percent_used * 100))}%`}</div>
  </div>;
}

const PLAN_ACTIONS = { warn: "warns only", block: "blocks Claude calls", pause_background: "pauses background work", pause_heartbeat: "pauses the heartbeat" } as const;

export function PlanLimitBar({ limit }: { limit: ClaudePlanLimit }) {
  const used = limit.percent_used * 100;
  const percent = Math.min(100, Math.max(0, used));
  const name = PLAN_WINDOWS[limit.window].name;
  const past = limit.over_limit ? ` · past its ${String(Math.round(limit.limit_at * 100))}% limit, so it ${PLAN_ACTIONS[limit.action]}` : "";
  return <div className="budget">
    <div className="budget-head"><span className="setting-label">{name}</span><span className="mono">{Math.round(used)}% of the plan</span></div>
    <div className={`budget-track ${limit.status}`} role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${String(percent)}%` }} /></div>
    <div className="setting-description">{limit.resets_at === null ? "no reset reported" : `resets ${formatTime(limit.resets_at)}`}{past}</div>
  </div>;
}

function PlanLimits({ report }: { report: ClaudePlanLimitsReport }) {
  return <div className="budgets">{report.windows.map((limit) => <PlanLimitBar key={limit.window} limit={limit} />)}</div>;
}

function Table({ head, rows }: { head: (string | [string, "number"])[]; rows: ReactNode[][] }) {
  return <div className="table-wrap"><table className="data-table">
    <thead><tr>{head.map((cell, index) => typeof cell === "string" ? <th key={index}>{cell}</th> : <th key={index} className="number">{cell[0]}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className={typeof head[column] === "string" ? "" : "number"}>{cell}</td>)}</tr>)}</tbody>
  </table>{rows.length === 0 ? <p className="settings-empty">No usage recorded for this period.</p> : null}</div>;
}

const TOTAL_HEAD: [string, "number"][] = [["Calls", "number"], ["Input", "number"], ["Output", "number"], ["Cache read", "number"], ["Cache write", "number"], ["Cost", "number"]];
const totals = (row: { call_count: number; total_input: number; total_output: number; total_cache_read: number; total_cache_write: number; total_cost: number }) =>
  [formatNumber(row.call_count), formatNumber(row.total_input), formatNumber(row.total_output), formatNumber(row.total_cache_read), formatNumber(row.total_cache_write), formatCost(row.total_cost)];

export function UsageReport({ result }: { result: UsageResult }) {
  switch (result.mode) {
    case "summary": return <>
      <Table head={["Provider", "Model", ...TOTAL_HEAD]} rows={result.summary.map((row) => [row.provider, <span className="mono">{row.model}</span>, ...totals(row)])} />
      {result.budgets.length === 0 ? null : <div className="budgets">{result.budgets.map((budget) => <BudgetBar key={budget.name} budget={budget} />)}</div>}
      {result.claude_plan_limits === null ? null : <PlanLimits report={result.claude_plan_limits} />}
      <dl className="kv usage-facts">
        <div className="kv-row"><dt>Period</dt><dd>{result.period}{result.period_since === undefined ? "" : ` since ${formatTime(result.period_since)}`} ({result.timezone})</dd></div>
        <div className="kv-row"><dt>Anomalies (7 days)</dt><dd>{result.anomaly_count_7d}</dd></div>
        {result.call_attempts.pending + result.call_attempts.unresolved === 0 ? null : <div className="kv-row"><dt>Unresolved calls</dt><dd>{result.call_attempts.pending} pending, {result.call_attempts.unresolved} unresolved, up to {formatCost(result.call_attempts.estimated_cost_at_risk)} at risk</dd></div>}
        {result.cost_sources.map((source) => <div key={source.cost_source} className="kv-row"><dt>Cost source: {source.cost_source}</dt><dd>{source.calls} calls{source.unpriced_calls === 0 ? "" : ` (${String(source.unpriced_calls)} unpriced)`}, {formatCost(source.total_cost)}</dd></div>)}
        {result.cache_health.map((item) => <div key={item.character} className="kv-row"><dt>Prompt cache: {item.character}</dt><dd>{item.state}{item.streak > 1 ? ` (${String(item.streak)} in a row)` : ""}</dd></div>)}
        {result.rate_limits.map((limit) => <div key={limit.host} className="kv-row"><dt>Rate limit: {limit.host}</dt><dd>{limit.requests_remaining === undefined ? "" : `${String(limit.requests_remaining)}/${String(limit.requests_limit ?? "?")} requests`}{limit.resets_at === undefined ? "" : `, resets ${formatTime(limit.resets_at)}`}</dd></div>)}
      </dl>
    </>;
    case "summary_by": return <Table head={[DIMENSIONS.find(([key]) => key === result.dimension)?.[1] ?? "Group", ...TOTAL_HEAD]} rows={result.summary.map((row) => [<span className="mono">{row.group}</span>, ...totals(row)])} />;
    case "budget": return <>
      {result.claude_plan_limits === undefined ? null : <PlanLimits report={result.claude_plan_limits} />}
      {result.budgets.length === 0
        ? result.claude_plan_limits === undefined ? <p className="settings-empty">No budgets are configured. Add a <code>[[budgets]]</code> section to the daemon configuration.</p> : null
        : <div className="budgets">{result.budgets.map((budget) => <BudgetBar key={budget.name} budget={budget} />)}</div>}
    </>;
    case "anomalies": return <Table head={["Time", "Character", "Model", "Call type", "Issue", ["Cache read", "number"], ["Cache write", "number"]]} rows={result.anomalies.map((item) => [formatTime(item.ts), item.character, <span className="mono">{item.model}</span>, item.call_type, item.anomaly ?? "—", formatNumber(item.cache_read_tokens), formatNumber(item.cache_write_tokens)])} />;
    case "csv": return <p className="settings-description">CSV export ready ({formatNumber(result.data.length)} characters).</p>;
    case "tsv": return <p className="settings-description">TSV export ready ({formatNumber(result.data.length)} characters).</p>;
  }
}

export function UsagePage({ state }: { state: WorkspaceSnapshot }) {
  const values = useDisplay();
  const [view, setView] = useState<View>("summary");
  const [period, setPeriod] = useState("");
  const [dimension, setDimension] = useState<UsageDimension>("model");
  const [filters, setFilters] = useState({ provider: "", model: "", api_key: "", call_type: "", character: "" });
  const args: UsageArgs = {
    ...(period === "" ? {} : { last: period }),
    ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value.trim() !== "").map(([key, value]) => [key, value.trim()])),
    ...(view === "grouped" ? { group_by: dimension } : view === "budget" ? { budget: true } : view === "anomalies" ? { anomalies: true } : {}),
  };
  const report = useOperation(state, "usage", args, []);
  const { busy, run } = useAction();
  const exportAs = (format: "csv" | "tsv") => void run(async () => {
    const result = await workspace.actions.run("usage", { ...args, group_by: null, budget: null, anomalies: null, ...(format === "csv" ? { export_csv: true } : { export_tsv: true }) });
    if (result.mode !== "csv" && result.mode !== "tsv") throw new Error("The daemon didn’t return an export");
    downloadText(`shore-usage.${format}`, result.data, format === "csv" ? "text/csv" : "text/tab-separated-values");
    return undefined;
  });
  const budgetNames = report.data?.mode === "summary" || report.data?.mode === "budget" ? report.data.budgets.map((budget) => budget.name) : [];
  let focus = { name: null as string | null, scope: "auto" as string };
  try { focus = budgetFocus(values.budget); } catch { focus = { name: null, scope: "auto" }; }
  return <>
    <p className="settings-description">Token usage and costs recorded by the daemon’s ledger.</p>
    <SettingsSection title="Report" actions={<div className="actions-row tight">
      <button type="button" className="button" disabled={busy} onClick={() => exportAs("csv")}>Export CSV</button>
      <button type="button" className="button" disabled={busy} onClick={() => exportAs("tsv")}>Export TSV</button>
    </div>}>
      <div className="usage-controls">
        <div className="segmented" role="radiogroup" aria-label="Report">
          {([["summary", "Summary"], ["grouped", "Breakdown"], ["budget", "Budgets"], ["anomalies", "Anomalies"]] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={view === id} onClick={() => setView(id)}>{label}</button>)}
        </div>
        {view === "grouped" ? <select className="select" aria-label="Group by" value={dimension} onChange={(event) => setDimension(event.target.value as UsageDimension)}>{DIMENSIONS.map(([id, label]) => <option key={id} value={id}>By {label.toLowerCase()}</option>)}</select> : null}
        <select className="select" aria-label="Period" value={period} onChange={(event) => setPeriod(event.target.value)}>{PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      </div>
      <details className="disclosure usage-filters"><summary>Filters</summary>
        <div className="filter-grid">
          {([["provider", "Provider"], ["model", "Model"], ["api_key", "API key"], ["call_type", "Call type"], ["character", "Character"]] as const).map(([key, label]) =>
            <label key={key} className="field"><span>{label}</span><input className="input" value={filters[key]} placeholder="Any" onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}
        </div>
      </details>
      <Loading error={report.error} ready={report.data !== undefined}>{report.data === undefined ? null : <UsageReport result={report.data} />}</Loading>
    </SettingsSection>
    <SettingsSection title="In the chat" description="Saved in this browser.">
      <div className="rows">
        <SettingRow label={VIEW_CONTROLS.usage.label} description="Show a budget chip in the top bar.">
          <select className="select" aria-label={VIEW_CONTROLS.usage.label} value={values.usage} onChange={(event) => display.change("usage", event.target.value)}>
            <option value="off">Never</option><option value="warn">Only near a limit</option><option value="always">Always</option>
          </select>
        </SettingRow>
        <SettingRow label={VIEW_CONTROLS.budget.label} description="Which budget the chip follows, and whether it tracks the cap or the pace.">
          <select className="select" aria-label="Budget" value={focus.name ?? ""} onChange={(event) => { try { display.change("budget", event.target.value === "" ? focus.scope : focus.scope === "auto" ? event.target.value : `${event.target.value}:${focus.scope}`, budgetNames); } catch (error) { toasts.show(String(error), "error"); } }}>
            <option value="">Most used</option>{budgetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select className="select" aria-label="Budget measure" value={focus.scope} onChange={(event) => display.change("budget", focus.name === null ? event.target.value : event.target.value === "auto" ? focus.name : `${focus.name}:${event.target.value}`, budgetNames)}>
            <option value="auto">Whichever is higher</option><option value="cap">Spending cap</option><option value="pace">Pace</option>
          </select>
        </SettingRow>
      </div>
    </SettingsSection>
  </>;
}
