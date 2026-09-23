import type { OpenImage } from "./media.ts";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { OperationClient } from "./operations.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { StatusReport } from "../protocol/StatusReport.ts";
import type { StatusSection } from "../protocol/StatusSection.ts";
import type { CallListing } from "../protocol/CallListing.ts";
import type { CallInspection } from "../protocol/CallInspection.ts";
import type { TranscriptResult } from "../protocol/TranscriptResult.ts";
import type { ErrorLogResult } from "../protocol/ErrorLogResult.ts";
import type { HeartbeatLogResult } from "../protocol/HeartbeatLogResult.ts";
import type { SubagentTraceResult } from "../protocol/SubagentTraceResult.ts";
import { Blocks, Field, Inspect, Modal } from "./components.tsx";
import { record } from "./forms.ts";

const views = { status: "Status", calls: "API calls", heartbeat: "Heartbeat transcript", events: "Heartbeat events", errors: "Errors & fallbacks", subagents: "Stored subagents", controls: "Runtime controls" };
type View = keyof typeof views;
const sectionLabels: Record<StatusSection, string> = { tokens: "Token usage", autonomy: "Autonomy", activity: "Activity", index: "Workspace index", history_index: "History index", mcp: "MCP servers" };

function Data({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="muted">None</span>;
  if (Array.isArray(value)) return value.length === 0 ? <p className="muted">No entries</p> : <ol className="diagnostic-data">{value.map((entry: unknown, index) => <li key={index}><Data value={entry} /></li>)}</ol>;
  if (typeof value === "object") return <dl className="diagnostic-data">{Object.entries(record(value)).map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{entry !== null && typeof entry === "object" ? <details><summary>View {key.replaceAll("_", " ")}</summary><Data value={entry} /></details> : <Data value={entry} />}</dd></div>)}</dl>;
  return <span className="message-text">{typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? value.toString() : "Unsupported value"}</span>;
}

function Result({ value, label = "Complete diagnostic result" }: { value: unknown; label?: string }) {
  return <><Data value={value} /><Inspect value={value} label={label} /></>;
}

export function Diagnostics({ actions, operations, ready, character, characters, changed, advanced, close, openImage }: {
  actions: OperationClient; operations: OperationDescriptor[]; ready: boolean; character: string; characters: string[];
  changed: () => Promise<void>; advanced: (name: string) => void; close: () => void; openImage: OpenImage;
}) {
  const [view, setView] = useState<View>("status");
  const [status, setStatus] = useState<StatusReport>();
  const [section, setSection] = useState("");
  const [calls, setCalls] = useState<CallListing>();
  const [call, setCall] = useState<CallInspection>();
  const [transcript, setTranscript] = useState<TranscriptResult>();
  const [events, setEvents] = useState<HeartbeatLogResult>();
  const [errors, setErrors] = useState<ErrorLogResult>();
  const [traces, setTraces] = useState<SubagentTraceResult>();
  const [count, setCount] = useState(20);
  const [callType, setCallType] = useState("");
  const [callCharacter, setCallCharacter] = useState(character);
  const [callId, setCallId] = useState<number>();
  const [wire, setWire] = useState(false);
  const [diff, setDiff] = useState(false);
  const [against, setAgainst] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionResult, setActionResult] = useState<unknown>();
  const disabled = busy || !ready;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const refresh = async (selected = view) => {
    switch (selected) {
      case "status": case "controls": setStatus(await actions.run("status", {})); break;
      case "calls": {
        const result = await actions.run("call_log", { count, ...(callType === "" ? {} : { call_type: callType }), character: callCharacter });
        if (!("entries" in result)) throw new Error("Expected a call listing");
        setCalls(result); break;
      }
      case "heartbeat": setTranscript(await actions.run("transcript", { source: selected, count })); break;
      case "events": setEvents(await actions.run("heartbeat_log", { count })); break;
      case "errors": setErrors(await actions.run("error_log", { count })); break;
      case "subagents": setTraces(await actions.run("subagent_trace", { count, ...(ids.length === 0 ? {} : { ids }) })); break;
    }
  };
  const inspectCall = async (id = callId) => {
    if (id === undefined) throw new Error("Choose a call ID");
    const result = await actions.run("call_log", { id, wire, diff, ...(diff && against !== "" ? { against: Number(against) } : {}) });
    if (!("call" in result)) throw new Error("Call capture is disabled");
    setCall(result);
  };
  useEffect(() => {
    let current = true;
    if (ready) {
      setBusy(true);
      void actions.run("status", {}).then((result) => { if (current) { setStatus(result); setError(""); } })
        .catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); })
        .finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready, character]);
  return <Modal title="Diagnostics" close={close}><div className="diagnostics"><p className="muted">{character} · runtime health, captured calls and stored traces</p>
    <label className="field">Diagnostic view<select disabled={disabled} value={view} onChange={(event) => {
      const selected = event.target.value;
      if (Object.hasOwn(views, selected)) { const next = selected as View; setView(next); void run(() => refresh(next)); }
    }}>{Object.entries(views).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {!ready ? <p role="status">Disconnected. Reconnect to refresh diagnostics or run controls.</p> : null}{busy ? <p role="status">Loading diagnostic result…</p> : null}{error === "" ? null : <p role="alert" className="error">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void run(() => refresh()); }}><fieldset disabled={disabled} className="action-fields">
      {view === "status" || view === "controls" ? null : <Field control={{ kind: "integer", minimum: 0, maximum: 4294967295 }} label="Recent entries" value={count} change={(next) => { if (typeof next === "number") setCount(next); }} />}
      {view === "calls" ? <div className="setting-values"><label className="field">Call type<input value={callType} placeholder="All types" onChange={(event) => setCallType(event.target.value)} /></label><label className="field">Call character<input list="diagnostic-characters" value={callCharacter} onChange={(event) => setCallCharacter(event.target.value)} /><datalist id="diagnostic-characters">{characters.map((name) => <option key={name}>{name}</option>)}</datalist></label></div> : null}
      {view === "subagents" ? <Field control={{ kind: "array", item: { kind: "string" } }} label="Parent tool IDs" value={ids} change={(next) => { if (Array.isArray(next) && next.every((id: unknown) => typeof id === "string")) setIds(next); }} /> : null}
      {view === "status" || view === "controls" ? null : <p className="muted">{view === "errors" || view === "events" ? "Zero returns no recent entries." : "Zero returns all matching stored entries."}</p>}<button type="submit">Refresh diagnostics</button>
    </fieldset></form>
    {view === "status" && status !== undefined ? <section aria-label="Runtime status"><h3>Runtime status</h3><dl className="capabilities"><div><dt>Model</dt><dd>{status.active_model ?? "Unresolved"}</dd></div><div><dt>Messages / turns</dt><dd>{String(status.message_count)} / {String(status.turn_count)}</dd></div><div><dt>Heartbeat</dt><dd>{status.autonomy?.heartbeat_state ?? "Not registered"}</dd></div></dl>
      <label className="field">Status section<select value={section} onChange={(event) => setSection(event.target.value)}><option value="">Overview</option>{status.sections.map((name) => <option key={name} value={name}>{Object.entries(sectionLabels).find(([key]) => key === name)?.[1] ?? name}</option>)}</select></label>
      <Result value={section === "" ? status : Object.hasOwn(status, section) ? record(status)[section] : undefined} label="Selected status data" /><Inspect value={status} label="Complete status report" />
    </section> : null}
    {view === "calls" ? <section aria-label="Captured API calls"><h3>Captured API calls</h3>{calls === undefined ? null : <>{!calls.enabled ? <p>Call capture is disabled.</p> : calls.entries.length === 0 ? <p>No calls match these filters.</p> : <div className="table-scroll"><table><thead><tr><th>Call</th><th>Time / type</th><th>Provider / model</th><th>Tokens in / out</th><th>Duration / outcome</th></tr></thead><tbody>{calls.entries.map((entry) => <tr key={entry.id}><td><button disabled={disabled} onClick={() => { setCallId(entry.id); void run(() => inspectCall(entry.id)); }}>Inspect call {String(entry.id)}</button></td><td>{entry.ts}<br />{entry.call_type ?? "Unknown"}</td><td>{entry.provider}<br />{entry.model}</td><td>{String(entry.usage.input_tokens)} / {String(entry.usage.output_tokens)}</td><td>{entry.duration_ms === null ? "Unknown duration" : `${String(entry.duration_ms)} ms`}<br />{entry.error ?? entry.finish_reason ?? "Unknown outcome"}</td></tr>)}</tbody></table></div>}<Inspect value={calls} label="Complete call listing" /></>}
      <form onSubmit={(event) => { event.preventDefault(); void run(() => inspectCall()); }}><fieldset disabled={disabled}><legend>Inspect and compare</legend><label className="field">Call ID<input required type="number" step="1" min="-9007199254740991" max="9007199254740991" value={callId ?? ""} onChange={(event) => setCallId(event.target.value === "" ? undefined : event.target.valueAsNumber)} /></label><div className="actions"><label className="check"><input type="checkbox" checked={wire} onChange={(event) => setWire(event.target.checked)} />Full wire headers and bodies</label><label className="check"><input type="checkbox" checked={diff} onChange={(event) => setDiff(event.target.checked)} />Compare requests</label></div>{diff ? <label className="field">Compare against call ID<input type="number" step="1" min="-9007199254740991" max="9007199254740991" placeholder="Previous call" value={against} onChange={(event) => setAgainst(event.target.value)} /></label> : null}<button type="submit">Load call details</button></fieldset></form>
      {call === undefined ? null : <article aria-label={`Call ${String(call.call.id)} details`}><h3>Call {String(call.call.id)} · {call.call.model}</h3><h4>Request</h4><Data value={call.call.request} /><h4>Response</h4><Data value={call.call.response} /><details><summary>HTTP exchanges ({String(call.wire.length)})</summary><Data value={call.wire} /></details>{call.diff === undefined ? null : <section aria-label="Request differences"><h4>Request differences · {call.diff.source}</h4><p>{String(call.diff.from_call)} → {String(call.diff.to_call)} · {String(call.diff.bytes.added)} bytes added · {String(call.diff.bytes.removed)} bytes removed · {String(call.diff.bytes.equal)} bytes unchanged</p>{call.diff.entries.map((entry, index) => <details key={index} className={`diff-${entry.op}`}><summary>{entry.op} · {String(entry.bytes)} bytes</summary><pre>{entry.text ?? entry.hash}</pre></details>)}</section>}<Inspect value={call} label="Complete call details" /></article>}
    </section> : null}
    {view === "heartbeat" && transcript?.source === view ? <section aria-label="Stored transcript"><h3>{views[view]}</h3>{!transcript.enabled ? <p>Transcript capture is disabled.</p> : transcript.entries.length === 0 ? <p>No stored transcript entries.</p> : transcript.entries.map((entry) => <article className="diagnostic-entry" key={entry.id}><h4>{entry.ts} · {entry.model ?? "Unknown model"}</h4><p className="muted">{entry.call_type} · iteration {String(entry.iteration)} · {String(entry.usage.input_tokens)} input / {String(entry.usage.output_tokens)} output tokens</p><Data value={entry.entry} /><Inspect value={entry} label="Complete transcript entry" /></article>)}<Inspect value={transcript} label="Complete transcript" /></section> : null}
    {view === "events" && events !== undefined ? <section aria-label="Heartbeat events"><h3>Heartbeat events</h3>{events.events.length === 0 ? <p>No heartbeat events.</p> : events.events.map((entry, index) => <article className="diagnostic-entry" key={index}><h4>{entry.kind.replaceAll("_", " ")}</h4><time>{entry.timestamp}</time><p className="message-text">{entry.detail}</p></article>)}<Inspect value={events} label="Complete heartbeat events" /></section> : null}
    {view === "errors" && errors !== undefined ? <section aria-label="Diagnostic errors"><h3>Errors and fallback decisions</h3>{(["errors", "key_fallbacks"] as const).map((key) => <section key={key}><h4>{key.replaceAll("_", " ")} · {String(errors[key].count)} total</h4><Data value={errors[key].recent} /></section>)}<Inspect value={errors} label="Complete errors and fallbacks" /></section> : null}
    {view === "subagents" && traces !== undefined ? <section aria-label="Stored subagent traces"><h3>Stored subagent traces</h3>{traces.entries.length === 0 ? <p>No stored subagent traces match these filters.</p> : traces.entries.map((entry, index) => <article className="diagnostic-entry" key={`${entry.parent_tool_use_id}.${String(index)}`}><h4>{entry.subagent} · {entry.model}</h4><p className="muted">{entry.ts} · parent {entry.parent_tool_use_id}{entry.rid === undefined ? "" : ` · request ${entry.rid}`}</p>{entry.messages_expired === true ? <p>Stored messages have expired. Retained metadata and result remain available.</p> : null}{entry.result === undefined ? null : <p className="message-text">{entry.result}</p>}{entry.error === undefined ? null : <p className="error">{entry.error}</p>}<details><summary>Messages ({String(entry.messages.length)})</summary>{entry.messages.map((message) => <article key={message.msg_id} className="message"><strong>{message.role}</strong>{message.content_blocks.length === 0 ? <p className="message-text">{message.content}</p> : <Blocks blocks={message.content_blocks} reasoning tools openImage={openImage} />}</article>)}</details><Inspect value={entry} label="Complete subagent trace" /></article>)}<Inspect value={traces} label="Complete stored subagents" /></section> : null}
    {view === "controls" ? <section aria-label="Runtime controls"><h3>Runtime controls</h3><p>Heartbeat: {status?.autonomy?.heartbeat_state ?? "Not registered"}</p><div className="action-list">{operations.filter((operation) => operation.category === "Diagnostics" && operation.effects.some((effect) => effect !== "read")).map((operation) => <button disabled={disabled || operation.available === false} key={operation.name} onClick={() => {
      if (Object.keys(operation.fields).length > 0 || operation.confirmation !== "none") { advanced(operation.name); return; }
      void run(async () => { setActionResult(undefined); setActionResult(await actions.runDiscovered(operation.name, {})); await changed(); await refresh("controls"); });
    }}><strong>{operation.label}</strong><small>{operation.available === false ? "Unavailable for this selection" : operation.effects.includes("provider_call") ? "May make a provider request" : "Updates runtime state"}</small></button>)}</div>{actionResult === undefined ? null : <section role="status"><h3>Runtime action completed</h3><Result value={actionResult} label="Complete runtime action result" /></section>}</section> : null}
  </div></Modal>;
}
