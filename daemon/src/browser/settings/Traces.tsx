import { useEffect, useState } from "react";
import type { CallInspection } from "../../protocol/CallInspection.ts";
import type { Role } from "../../protocol/Role.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Markdown } from "../markdown.tsx";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatNumber, formatTime, Loading, NeedsCharacter, useAction, useOperation } from "./shared.tsx";
import { Tree } from "./tree.tsx";

type Tab = "calls" | "log" | "heartbeat" | "events" | "errors" | "subagents";
const TABS: readonly [Tab, string][] = [["calls", "Model calls"], ["log", "Conversation log"], ["heartbeat", "Heartbeat transcript"], ["events", "Heartbeat events"], ["errors", "Errors"], ["subagents", "Subagents"]];

function Count({ value, change }: { value: number; change: (value: number) => void }) {
  return <select className="select" aria-label="Entries to show" value={value} onChange={(event) => change(Number(event.target.value))}>{[10, 25, 50, 100].map((count) => <option key={count} value={count}>Last {count}</option>)}</select>;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  return <details className="disclosure payload"><summary>{label}</summary><pre className="readout">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></details>;
}

function CallDialog({ id, close }: { id: number; close: () => void }) {
  const [inspection, setInspection] = useState<CallInspection>();
  const [against, setAgainst] = useState("");
  const [wire, setWire] = useState(false);
  const { busy, run } = useAction();
  const load = (diff: boolean) => void run(async () => {
    const result = await workspace.actions.run("call_log", { id, ...(wire ? { wire: true } : {}), ...(diff ? { diff: true, ...(against === "" ? {} : { against: Number(against) }) } : {}) });
    if ("call" in result) setInspection(result);
    return undefined;
  });
  useEffect(() => { load(false); }, [id]);
  const call = inspection?.call;
  return <Dialog title={`Call ${String(id)}`} close={close} wide>
    {call === undefined ? <Spinner label="Loading call" /> : <>
      <dl className="kv">
        <div className="kv-row"><dt>When</dt><dd>{formatTime(call.ts)}</dd></div>
        <div className="kv-row"><dt>Model</dt><dd className="mono">{call.provider ?? ""}:{call.model ?? "unknown"}</dd></div>
        <div className="kv-row"><dt>Type</dt><dd>{call.call_type ?? "—"} · {call.finish_reason ?? "no finish reason"}</dd></div>
        <div className="kv-row"><dt>Tokens</dt><dd>{formatNumber(call.usage.input_tokens)} in · {formatNumber(call.usage.output_tokens)} out · {formatNumber(call.usage.cache_read_tokens)} cache read · {formatNumber(call.usage.cache_write_tokens)} cache write</dd></div>
        <div className="kv-row"><dt>Duration</dt><dd>{call.duration_ms === null ? "—" : `${formatNumber(call.duration_ms)} ms`}</dd></div>
        {call.error === null ? null : <div className="kv-row"><dt>Error</dt><dd className="form-error">{call.error}</dd></div>}
      </dl>
      <Payload label={`Request (${formatNumber(call.request_bytes)} bytes)`} value={call.request} />
      <Payload label={`Response (${formatNumber(call.response_bytes)} bytes)`} value={call.response} />
      {inspection?.wire.map((exchange) => <Payload key={exchange.id} label={`HTTP ${exchange.method} ${exchange.url} → ${String(exchange.status ?? "no status")}`} value={{ request_headers: exchange.request_headers, request_body: exchange.request_body, response_headers: exchange.response_headers, response_body: exchange.response_body }} />)}
      {inspection?.diff === undefined ? null : <div className="rows padded">
        <div className="setting-label">Compared with call {inspection.diff.from_call}</div>
        <div className="setting-description">{inspection.diff.chunks.equal} unchanged, {inspection.diff.chunks.added} added, {inspection.diff.chunks.removed} removed chunks</div>
        <pre className="readout">{inspection.diff.entries.filter((entry) => entry.op !== "equal").map((entry) => `${entry.op === "added" ? "+" : "-"} ${entry.text ?? `(${String(entry.bytes)} bytes)`}`).join("\n")}</pre>
      </div>}
      <div className="inline-form wrap">
        <label className="check"><input type="checkbox" checked={wire} onChange={(event) => setWire(event.target.checked)} />Include HTTP exchanges</label>
        <input className="input compact" aria-label="Compare with call" inputMode="numeric" placeholder="Previous call" value={against} onChange={(event) => setAgainst(event.target.value.replace(/\D/g, ""))} />
        <button type="button" className="button" disabled={busy} onClick={() => load(true)}>Compare</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => load(false)}>Reload</button>
      </div>
    </>}
  </Dialog>;
}

function Calls({ state }: { state: WorkspaceSnapshot }) {
  const [count, setCount] = useState(25);
  const [callType, setCallType] = useState("");
  const [open, setOpen] = useState<number>();
  const calls = useOperation(state, "call_log", { count, ...(callType === "" ? {} : { call_type: callType }) }, []);
  const listing = calls.data !== undefined && "entries" in calls.data ? calls.data : undefined;
  return <>
    <div className="usage-controls"><Count value={count} change={setCount} />
      <select className="select" aria-label="Call type" value={callType} onChange={(event) => setCallType(event.target.value)}>{["", "chat", "heartbeat", "compaction", "subagent", "keepalive"].map((type) => <option key={type} value={type}>{type === "" ? "All call types" : type}</option>)}</select>
    </div>
    <Loading error={calls.error} ready={listing !== undefined}>
      {listing?.enabled === false ? <p className="settings-empty">Call logging is off. Enable <code>diagnostics.call_log</code> in the configuration.</p> : null}
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th className="number">#</th><th>When</th><th>Type</th><th>Model</th><th className="number">In</th><th className="number">Out</th><th className="number">ms</th><th>Result</th></tr></thead>
        <tbody>{listing?.entries.map((entry) => <tr key={entry.id} className="clickable" tabIndex={0} onClick={() => setOpen(entry.id)} onKeyDown={(event) => { if (event.key === "Enter") setOpen(entry.id); }}>
          <td className="number">{entry.id}</td><td>{formatTime(entry.ts)}</td><td>{entry.call_type ?? "—"}</td><td className="mono">{entry.model ?? "—"}</td>
          <td className="number">{formatNumber(entry.usage.input_tokens)}</td><td className="number">{formatNumber(entry.usage.output_tokens)}</td><td className="number">{formatNumber(entry.duration_ms)}</td>
          <td className={entry.error === null ? "" : "form-error"}>{entry.error ?? entry.finish_reason ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>
    </Loading>
    {open === undefined ? null : <CallDialog id={open} close={() => setOpen(undefined)} />}
  </>;
}

function ConversationLog({ state }: { state: WorkspaceSnapshot }) {
  const [turns, setTurns] = useState(10);
  const [role, setRole] = useState<Role | "">("");
  const log = useOperation(state, "log", { turns, ...(role === "" ? {} : { role }) }, [state.thread]);
  return <>
    <div className="usage-controls">
      <select className="select" aria-label="Turns" value={turns} onChange={(event) => setTurns(Number(event.target.value))}>{[5, 10, 25, 50].map((count) => <option key={count} value={count}>Last {count} turns</option>)}</select>
      <select className="select" aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as Role | "")}><option value="">All roles</option><option value="user">You</option><option value="assistant">Character</option><option value="system">System</option></select>
    </div>
    <Loading error={log.error} ready={log.data !== undefined}>
      <p className="setting-description">{formatNumber(log.data?.total_messages)} messages, {formatNumber(log.data?.total_turns)} turns in total.</p>
      <div className="segment-messages">{log.data?.messages.map((message) => <div key={message.msg_id} className="segment-message"><span className="setting-label">{message.role} · {formatTime(message.timestamp)}</span><Markdown text={message.content} /></div>)}</div>
    </Loading>
  </>;
}

function Diagnostic({ state, tab }: { state: WorkspaceSnapshot; tab: "heartbeat" | "events" | "errors" | "subagents" }) {
  const [count, setCount] = useState(25);
  const [ids, setIds] = useState("");
  const heartbeat = useOperation(state, "transcript", { count }, [], tab === "heartbeat");
  const events = useOperation(state, "heartbeat_log", { count }, [], tab === "events");
  const errors = useOperation(state, "error_log", { count }, [], tab === "errors");
  const subagents = useOperation(state, "subagent_trace", { count, ...(ids.trim() === "" ? {} : { ids: ids.split(/[\s,]+/).filter(Boolean) }) }, [], tab === "subagents");
  return <>
    <div className="usage-controls"><Count value={count} change={setCount} />
      {tab === "subagents" ? <input className="input" aria-label="Tool call IDs" placeholder="Filter by tool call IDs" value={ids} onChange={(event) => setIds(event.target.value)} /> : null}
    </div>
    {tab === "heartbeat" ? <Loading error={heartbeat.error} ready={heartbeat.data !== undefined}>
      {heartbeat.data?.enabled === false ? <p className="settings-empty">Heartbeat transcripts are off.</p> : null}
      {heartbeat.data?.entries.map((row) => <details key={row.id} className="disclosure payload"><summary>{formatTime(row.ts)} · round {row.iteration} · {row.model ?? "?"} · {row.finish_reason ?? ""}</summary><Tree value={row.entry} /></details>)}
      {heartbeat.data?.entries.length === 0 ? <p className="settings-empty">No heartbeat calls yet.</p> : null}
    </Loading> : null}
    {tab === "events" ? <Loading error={events.error} ready={events.data !== undefined}>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
        <tbody>{events.data?.events.map((event, index) => <tr key={index}><td>{formatTime(event.timestamp)}</td><td>{event.kind.replaceAll("_", " ")}</td><td>{event.detail}</td></tr>)}</tbody></table></div>
      {events.data?.events.length === 0 ? <p className="settings-empty">No heartbeat events yet.</p> : null}
    </Loading> : null}
    {tab === "errors" ? <Loading error={errors.error} ready={errors.data !== undefined}>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Type</th><th>Message</th><th>Context</th></tr></thead>
        <tbody>{errors.data?.errors.recent.map((entry, index) => <tr key={index}><td>{formatTime(entry.timestamp)}</td><td>{entry.error_type}</td><td>{entry.message}</td><td className="mono">{entry.context}</td></tr>)}</tbody></table></div>
      {errors.data?.errors.recent.length === 0 ? <p className="settings-empty">No errors recorded.</p> : null}
      {errors.data === undefined || errors.data.key_fallbacks.recent.length === 0 ? null : <><div className="tool-label">API key fallbacks</div><div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Provider</th><th>Model</th><th>From → to</th><th>Reason</th></tr></thead>
        <tbody>{errors.data.key_fallbacks.recent.map((entry, index) => <tr key={index}><td>{formatTime(entry.timestamp)}</td><td>{entry.provider}</td><td className="mono">{entry.model}</td><td>{entry.from_key} → {entry.to_key ?? "none"}</td><td>{entry.reason}</td></tr>)}</tbody></table></div></>}
    </Loading> : null}
    {tab === "subagents" ? <Loading error={subagents.error} ready={subagents.data !== undefined}>
      {subagents.data?.entries.map((trace, index) => <details key={index} className="disclosure payload"><summary>{formatTime(trace.ts)} · {trace.subagent} · {trace.model}{trace.error === undefined ? "" : " · failed"}</summary>
        {trace.result === undefined ? null : <div className="readout prose-readout"><Markdown text={trace.result} /></div>}
        {trace.error === undefined ? null : <p className="form-error">{trace.error}</p>}
        {trace.messages_expired === true ? <p className="setting-description">The subagent’s messages have expired.</p> : <div className="segment-messages">{trace.messages.map((message) => <div key={message.msg_id} className="segment-message"><span className="setting-label">{message.role}</span><Markdown text={message.content} /></div>)}</div>}
      </details>)}
      {subagents.data?.entries.length === 0 ? <p className="settings-empty">No subagent runs recorded.</p> : null}
    </Loading> : null}
  </>;
}

export function TracesPage({ state }: { state: WorkspaceSnapshot }) {
  const [tab, setTab] = useState<Tab>("calls");
  if (state.character === null) return <NeedsCharacter />;
  return <>
    <p className="settings-description">Stored diagnostics for {state.character}: model calls, background activity and errors.</p>
    <SettingsSection title="Traces">
      <div className="segmented wrap" role="tablist" aria-label="Trace type">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} aria-checked={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === "calls" ? <Calls state={state} /> : tab === "log" ? <ConversationLog state={state} /> : <Diagnostic key={tab} state={state} tab={tab} />}
    </SettingsSection>
  </>;
}
