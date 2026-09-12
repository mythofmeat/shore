import { useEffect, useState } from "react";
import type { OperationClient } from "./operations.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { UsageArgs } from "../protocol/UsageArgs.ts";
import type { UsageResult } from "../protocol/UsageResult.ts";
import type { UsageBudget } from "../protocol/UsageBudget.ts";
import type { UsageSummaryReport } from "../protocol/UsageSummaryReport.ts";
import type { UsageDimension } from "../protocol/UsageDimension.ts";
import { Field, Inspect, Modal } from "./components.tsx";
import { actionControl } from "./forms.ts";

type View = "overview" | "grouped" | "budgets" | "cache" | "anomalies" | "limits";
const money = (value: number) => `$${value.toFixed(2)}`;

function Table({ rows, empty = "Nothing recorded for these filters." }: { rows: readonly object[]; empty?: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => value === undefined || value === null ? "—" : typeof value === "string" ? value : typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : typeof value === "boolean" ? value.toString() : JSON.stringify(value);
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable report table"><table><thead><tr>{columns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{cell(Object.entries(row).find(([key]) => key === column)?.[1])}</td>)}</tr>)}</tbody></table></div>;
}

function Budgets({ budgets }: { budgets: UsageBudget[] }) {
  return <section aria-label="Budget meters"><h3>Budget meters</h3><p className="muted">These meters use their configured scopes and reset windows.</p>{budgets.length === 0 ? <p>No budgets configured. Set them in Settings.</p> : budgets.map((budget, index) => <article className="usage-budget" key={index}><h4>{budget.name} · {budget.status.replaceAll("_", " ")}</h4><p><strong>{money(budget.current_cost)}</strong> of {money(budget.cost_limit)} · {(budget.percent_used * 100).toFixed(1)}%</p><meter aria-label={`${budget.name} budget used`} min={0} max={1} value={Math.min(1, Math.max(0, budget.percent_used))} /><p>Resets {budget.reset_at} · {budget.timezone}</p><p>Current action: {budget.effective_action.replaceAll("_", " ")} · compaction {budget.compaction_allowed_over_budget ? "allowed" : "subject to the limit"}</p><Table rows={[budget.filters]} />{budget.pace === undefined ? null : <section aria-label={`${budget.name} pace`}><h5>Pace · {budget.pace.period}</h5><p>{money(budget.pace.current_cost)} of {money(budget.pace.allowance)} · {money(budget.pace.remaining)} remaining · {budget.pace.status.replaceAll("_", " ")}</p><Table rows={[budget.pace]} /></section>}<Inspect value={budget} label={`Complete budget: ${budget.name}`} /></article>)}</section>;
}

function Cache({ result }: { result: UsageSummaryReport }) {
  return <section aria-label="Cache health"><h3>Cache health</h3><Table rows={result.cache_health} empty="No active Anthropic cache records." /><h4>Coverage in this period</h4><Table rows={result.cache_coverage} /><h4>Seven-day anomalies · all characters</h4><p>{String(result.anomaly_count_7d)} recorded anomalies</p><Table rows={result.anomaly_counts_7d} empty="No anomalies in the last seven days." /></section>;
}

function Limits({ result }: { result: UsageSummaryReport }) {
  const subscription = result.nanogpt_subscription;
  return <section aria-label="Provider limits"><h3>Provider limits</h3><p className="muted">The latest stored response for each host; these readings may be stale.</p><Table rows={result.rate_limits} empty="No provider rate-limit readings recorded." /><h4>NanoGPT subscription</h4>{subscription === null ? <p>No cached subscription information.</p> : <><p>{subscription.state} · fetched {subscription.fetched_at}</p>{subscription.weeklyInputTokens === undefined ? null : <Table rows={[subscription.weeklyInputTokens]} />}<Inspect value={subscription} label="Complete subscription information" /></>}</section>;
}

function downloadExport(result: Extract<UsageResult, { mode: "csv" | "tsv" }>) {
  const type = result.mode === "csv" ? "text/csv" : "text/tab-separated-values";
  const url = URL.createObjectURL(new Blob([result.data], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a"); link.href = url; link.download = `shore-usage.${result.mode}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function UsageReport({ result, view }: { result: UsageResult; view: View }) {
  switch (result.mode) {
    case "summary": return <><p>Period: {result.period}{result.period_since === undefined ? "" : ` since ${result.period_since}`} · {result.timezone}</p>{view === "cache" ? <Cache result={result} /> : view === "limits" ? <Limits result={result} /> : <><section aria-label="Spending summary"><h3>Recorded spend · {money(result.summary.reduce((sum, row) => sum + row.total_cost, 0))}</h3><Table rows={result.summary} /><h4>Cost sources</h4><Table rows={result.cost_sources} /></section><Budgets budgets={result.budgets} /><Cache result={result} /><Limits result={result} /></>}<section aria-label="Unsettled calls"><h3>Unsettled calls · all scopes</h3><p>{String(result.call_attempts.pending)} pending · {String(result.call_attempts.unresolved)} unresolved · {money(result.call_attempts.estimated_cost_at_risk)} estimated cost at risk</p></section></>;
    case "summary_by": return <section aria-label="Grouped spending"><h3>Spend by {result.dimension.replaceAll("_", " ")}</h3><p>Period: {result.period}{result.period_since === undefined ? "" : ` since ${result.period_since}`}</p><Table rows={result.summary} /></section>;
    case "budget": return <><p>{result.timezone} · compaction over budget {result.allow_compaction_over_budget ? "allowed by default" : "not allowed by default"}</p><Budgets budgets={result.budgets} /><h3>Unsettled calls</h3><Table rows={[result.call_attempts]} /></>;
    case "anomalies": return <section aria-label="Cache anomalies"><h3>Cache anomalies</h3><p className="muted">The today preset uses a seven-day lookback for this report.</p><Table rows={result.anomalies} empty="No anomalies for these filters." /></section>;
    case "csv": case "tsv": return <section aria-label="Ledger export"><h3>{result.mode.toUpperCase()} export ready</h3><button onClick={() => downloadExport(result)}>Download {result.mode.toUpperCase()}</button><details><summary>Preview exported ledger</summary><pre>{result.data}</pre></details></section>;
  }
}

export function Usage({ actions, operations, ready, character, close, advanced }: {
  actions: OperationClient; operations: OperationDescriptor[]; ready: boolean; character: string | null;
  close: () => void; advanced: (args: UsageArgs) => void;
}) {
  const operation = operations.find((item) => item.name === "usage");
  const groupControl = operation === undefined ? undefined : actionControl(operation).fields["group_by"];
  const [view, setView] = useState<View>("overview");
  const [last, setLast] = useState("");
  const [filterCharacter, setFilterCharacter] = useState(character ?? "");
  const [provider, setProvider] = useState("");
  const [keyName, setKeyName] = useState("");
  const [model, setModel] = useState("");
  const [callType, setCallType] = useState("");
  const [group, setGroup] = useState<UsageDimension | null>("provider");
  const [result, setResult] = useState<UsageResult>();
  const [loaded, setLoaded] = useState<UsageArgs>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || !ready || operation?.available === false || operation === undefined;
  const args = (selected = view): UsageArgs => ({
    ...(last === "" ? {} : { last }), ...(filterCharacter === "" ? {} : { character: filterCharacter }), ...(provider === "" ? {} : { provider }),
    ...(keyName === "" ? {} : { api_key: keyName }), ...(model === "" ? {} : { model }), ...(callType === "" ? {} : { call_type: callType }),
    ...(selected === "grouped" && group !== null ? { group_by: group } : {}), ...(selected === "budgets" ? { budget: true } : {}), ...(selected === "anomalies" ? { anomalies: true } : {}),
  });
  const refresh = async (input = args()) => {
    setBusy(true); setError("");
    try { setResult(await actions.run("usage", input)); setLoaded(input); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let current = true;
    if (ready && operation?.available === true) {
      const input: UsageArgs = character === null ? {} : { character };
      setBusy(true);
      void actions.run("usage", input).then((response) => { if (current) { setResult(response); setLoaded(input); } }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready, operation?.available, character]);
  return <Modal title="Usage & budgets" close={close}><div className="usage-workspace"><p>Review recorded spending, cache behaviour, budget scopes and stored provider limits.</p>{!ready ? <p role="status">Reconnect to refresh reports. Your filters remain available.</p> : null}{operation?.available === false ? <p role="status">Usage is unavailable because this daemon has no ledger.</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><fieldset disabled={disabled}><label className="field">Report<select value={view} onChange={(event) => setView(event.target.value as View)}><option value="overview">Overview</option><option value="grouped">Group spending</option><option value="budgets">Budgets</option><option value="cache">Cache health</option><option value="anomalies">Cache anomalies</option><option value="limits">Provider limits</option></select></label>
      <div className="usage-filters"><label className="field">Period<input list="usage-periods" placeholder="Current budget window or today" value={last} onChange={(event) => setLast(event.target.value)} /><datalist id="usage-periods">{["today", "week", "month", "all", "4h", "7d", "2w", "1M"].map((period) => <option key={period} value={period} />)}</datalist></label><label className="field">Character filter<input placeholder="All characters" value={filterCharacter} onChange={(event) => setFilterCharacter(event.target.value)} /></label><label className="field">Provider filter<input value={provider} onChange={(event) => setProvider(event.target.value)} /></label><label className="field">API key name<input placeholder="Configured name, not a credential" value={keyName} onChange={(event) => setKeyName(event.target.value)} /></label><label className="field">Model filter<input value={model} onChange={(event) => setModel(event.target.value)} /></label><label className="field">Call type<input value={callType} onChange={(event) => setCallType(event.target.value)} /></label></div>
      {view === "grouped" && groupControl !== undefined ? <Field label="Group by" control={groupControl} value={group} change={(value) => setGroup(value as UsageDimension | null)} /> : null}<p className="muted">Budgets and pending calls have their own scopes. The seven-day anomaly count spans all characters.</p><div className="actions"><button type="submit">Refresh report</button><button type="button" onClick={() => advanced(args())}>All usage options</button><button type="button" onClick={() => { void refresh({ ...args("overview"), export_csv: true }); }}>Prepare CSV</button><button type="button" onClick={() => { void refresh({ ...args("overview"), export_tsv: true }); }}>Prepare TSV</button></div>
    </fieldset></form>{busy ? <p role="status">Loading usage report…</p> : null}{error === "" ? null : <p role="alert" className="error">{error}</p>}{result === undefined ? null : <section aria-label="Usage result"><UsageReport result={result} view={view} /><Inspect value={loaded} label="Loaded report filters" /><Inspect value={result} label="Complete usage result" /></section>}
  </div></Modal>;
}
