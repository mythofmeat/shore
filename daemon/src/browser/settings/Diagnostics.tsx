import { useEffect, useState } from "react";
import type { StatusReport } from "../../protocol/StatusReport.ts";
import type { WebRequestList } from "../../protocol/WebRequestList.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { errorText, workspace } from "../app/state.ts";
import { listRequests, requestHistory } from "../request_history.ts";
import { fieldLabel } from "../ui/Field.tsx";
import { SettingsSection } from "./layout.tsx";
import { formatNumber, formatTime, Loading, NeedsCharacter, useAction, useOperation } from "./shared.tsx";
import { Tree } from "./tree.tsx";
import { requestStatus } from "./format.ts";


export function RequestHistory({ state }: { state: WorkspaceSnapshot }) {
  const [listing, setListing] = useState<WebRequestList>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const { busy, run } = useAction();
  const ready = state.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void listRequests().then((value) => {
      if (!alive) return;
      setListing(value); setError("");
      for (const item of workspace.getSnapshot().uncertain) if (value.requests.some((request) => request.rid === item.rid)) workspace.acknowledge(item.rid);
    }).catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, [ready, version]);
  const requests = listing?.requests ?? [];
  return <SettingsSection title="Recent requests" description="Changes and messages sent from this browser, kept across reloads and daemon restarts until you sign out." actions={<button type="button" className="button" onClick={() => setVersion((value) => value + 1)}>Refresh</button>}>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    {listing !== undefined && requests.length === 0 ? <p className="settings-empty">No recent requests.</p> : null}
    <div className="archive-list">{requests.map((request) => { const status = requestStatus(request); return <div key={request.id} className="archive" aria-label={`${request.label} request`}>
      <div className="archive-main">
        <span className="setting-label">{request.label}</span>
        <span className={`status-text ${status.tone}`}>{status.text}</span>
        <span className="setting-description">{request.character ?? "Daemon"}{request.thread === null ? "" : ` / ${request.thread}`} · {formatTime(new Date(request.started_at).toISOString())}{request.result_omitted ? " · result too large to keep" : ""}</span>
      </div>
      {request.phase === "running" ? null : <button type="button" className="button ghost" disabled={busy} onClick={() => void run(async () => { await requestHistory(`/${request.id}/acknowledge`); workspace.acknowledge(request.rid); setVersion((value) => value + 1); return undefined; })}>{request.phase === "uncertain" ? "I checked it" : "Dismiss"}</button>}
    </div>; })}</div>
  </SettingsSection>;
}

const SECTION_FIELDS: Record<string, readonly (keyof StatusReport)[]> = {
  conversation: ["message_count", "turn_count", "context_tokens", "active_model", "tokens"],
  folders: ["config_dir", "data_dir", "cache_dir"],
  autonomy: ["autonomy"], activity: ["activity"], index: ["index", "history_index"], mcp: ["mcp"], keepalive: ["keepalive_halts"], edits: ["pending_deferred_edit_count", "pending_deferred_edits"],
};

export function StatusView({ report }: { report: StatusReport }) {
  const [section, setSection] = useState("all");
  const sections = [...new Set(["conversation", "folders", ...report.sections.filter((name) => SECTION_FIELDS[name] !== undefined), "edits"])];
  const shown = section === "all" ? sections : [section];
  return <>
    <div className="stat-grid">
      <div className="stat"><div className="stat-label">Messages</div><div className="stat-value">{formatNumber(report.message_count)}</div></div>
      <div className="stat"><div className="stat-label">Turns</div><div className="stat-value">{formatNumber(report.turn_count)}</div></div>
      <div className="stat"><div className="stat-label">Context tokens</div><div className="stat-value">{formatNumber(report.context_tokens)}</div></div>
      <div className="stat"><div className="stat-label">Model</div><div className="stat-value small mono">{report.active_model ?? "—"}</div></div>
    </div>
    <div className="usage-controls"><select className="select" aria-label="Status section" value={section} onChange={(event) => setSection(event.target.value)}>
      <option value="all">All sections</option>{sections.map((name) => <option key={name} value={name}>{fieldLabel(name)}</option>)}
    </select></div>
    {shown.map((name) => <div key={name} className="rows padded status-section"><div className="setting-label">{fieldLabel(name)}</div>
      {(() => {
        const fields = (SECTION_FIELDS[name] ?? []).filter((key) => report[key] !== undefined);
        return fields.length === 1 && fields[0] !== undefined ? <Tree value={report[fields[0]]} /> : <Tree value={Object.fromEntries(fields.map((key) => [key, report[key]]))} />;
      })()}
    </div>)}
  </>;
}

export function DiagnosticsPage({ state }: { state: WorkspaceSnapshot }) {
  const status = useOperation(state, "status", {}, [state.thread], state.character !== null);
  if (state.character === null) return <><NeedsCharacter /><RequestHistory state={state} /></>;
  return <>
    <p className="settings-description">What the daemon knows about {state.character} right now.</p>
    <SettingsSection title="Status" actions={<button type="button" className="button" onClick={status.refresh}>Refresh</button>}>
      <Loading error={status.error} ready={status.data !== undefined}>{status.data === undefined ? null : <StatusView report={status.data} />}</Loading>
    </SettingsSection>
    <RequestHistory state={state} />
  </>;
}
