import { useEffect, useState } from "react";
import type { OperationClient } from "./operations.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { ToolDescription } from "../protocol/ToolDescription.ts";
import type { ToolRunReport } from "../protocol/ToolRunReport.ts";
import type { RunToolArgs } from "../protocol/RunToolArgs.ts";
import { operationPolicy } from "../operations/policy.ts";
import { Field, Inspect, JsonValue, Modal } from "./components.tsx";
import { initialValue, record, type Control } from "./forms.ts";
import { toolControl, toolNames } from "./tool_forms.ts";

export function ToolWorkbench({ actions, operations, character, thread, ready, close, advanced }: {
  actions: OperationClient; operations: OperationDescriptor[]; character: string; thread: string | null; ready: boolean;
  close: () => void; advanced: (args: RunToolArgs) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [lookup, setLookup] = useState("");
  const [definition, setDefinition] = useState<ToolDescription>();
  const [control, setControl] = useState<Extract<Control, { kind: "object" }>>();
  const [schemaError, setSchemaError] = useState("");
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ToolRunReport>();
  const operation = operations.find((item) => item.name === "run_tool");
  const disabled = !ready || busy || review || operation?.available === false;
  const args = (): RunToolArgs => ({ tool: definition?.tool ?? "", input, pairs, raw });
  const refresh = async () => setNames(toolNames(await actions.run("tools", {})));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const describe = async (tool: string) => {
    const response = await actions.run("run_tool", { tool, describe: true });
    if (!("mode" in response)) throw new Error("Expected a tool definition");
    setDefinition(response); setLookup(response.tool); setPairs({}); setResult(undefined); setReview(false);
    try { const field = toolControl(response.input_schema); setControl(field); setInput(record(initialValue(field))); setSchemaError(""); }
    catch (failure) { setControl(undefined); setInput({}); setSchemaError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const execute = async () => {
    await run(async () => {
      const response = await actions.run("run_tool", args());
      if ("mode" in response) throw new Error("Expected a tool execution result");
      setResult(response);
    });
    setReview(false);
  };
  useEffect(() => {
    let current = true;
    if (ready) void actions.run("tools", {}).then((access) => { if (current) setNames(toolNames(access)); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [actions, ready, character, thread]);
  return <Modal title="Tool workbench" close={close}><div className="tool-workbench"><p className="muted">{character} / {thread ?? "home"} · explicit tool calls</p>
    <p>Inspect a tool's definition, enter its arguments and review the call. Manual tools can change files, contact services or spend provider tokens.</p>
    {!ready ? <p role="status">Reconnect to run tools. Unsaved arguments remain while this dialog stays open.</p> : null}
    {busy ? <p role="status">Working on tool request…</p> : null}{error === "" ? null : <p role="alert" className="error">{error}</p>}
    <div className="section-heading"><label className="field">Find a tool<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button disabled={disabled} onClick={() => { void run(refresh); }}>Refresh tools</button></div>
    <nav aria-label="Available tools" className="tool-choices">{names.filter((name) => name.toLowerCase().includes(search.toLowerCase())).map((name) => <button key={name} disabled={disabled} aria-current={definition?.tool === name ? "true" : undefined} onClick={() => { void run(() => describe(name)); }}>{name}</button>)}</nav>
    {names.length === 0 ? <p>No tools listed.</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void run(() => describe(lookup)); }}><fieldset disabled={disabled} className="action-fields"><label className="field">Tool name<input required value={lookup} onChange={(event) => setLookup(event.target.value)} /></label><button type="submit">Inspect tool</button></fieldset></form>
    {definition === undefined ? null : <section aria-label="Selected tool"><h3>{definition.tool}</h3><p>{definition.kind} · {definition.enabled ? "Enabled for automatic calls" : "Not enabled for automatic calls; explicit manual runs are allowed"}</p><details><summary>Tool description</summary><p className="message-text">{definition.description}</p></details>
      <form onSubmit={(event) => { event.preventDefault(); if (operation !== undefined && operationPolicy(operation, args()).confirmation === "none") void execute(); else setReview(true); }}><fieldset disabled={disabled}>
        {control === undefined ? <><p className="notice">This tool schema needs advanced input controls: {schemaError}. Edit the structured fields below; the daemon checks the complete schema.</p><JsonValue label="Tool input" objectOnly value={input} change={(value) => setInput(record(value))} /></> : <Field key={definition.tool} label="Tool input" control={control} value={input} change={(value) => setInput(record(value))} />}
        <details><summary>Argument overrides</summary><p>These text values override matching fields above. Shore converts them using the tool's declared types.</p><Field label="Overrides" control={{ kind: "object", fields: {}, required: [], additional: { kind: "string" } }} value={pairs} change={(value) => setPairs(Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, String(item)])))} /></details>
        <label className="check"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />Include full output</label><p className="muted">Retain the complete result and nested calls as well as the normal output window.</p>
        <div className="actions"><button type="submit">Review tool run</button><button type="button" onClick={() => advanced(args())}>All tool options</button></div>
      </fieldset></form>
      <Inspect value={definition} label="Complete tool definition" />
    </section>}
    {review ? <section aria-label="Review tool run" className="confirmation"><h3>Review tool run</h3><p>{character} / {thread ?? "home"} · {definition?.tool}</p><pre>{JSON.stringify(args(), null, 2)}</pre><div className="actions"><button disabled={busy} onClick={() => setReview(false)}>Go back</button><button className="danger" disabled={busy || !ready} onClick={() => { void execute(); }}>Run tool now</button></div></section> : null}
    {result === undefined ? null : <section aria-label="Tool result"><h3>{result.rejected ? "Tool input rejected" : result.ok ? "Tool completed" : "Tool failed"}</h3><p>{result.tool} · {result.duration_ms.toFixed(1)} ms · {String(result.result_chars)} result characters</p><pre>{result.output}</pre>{result.truncated ? <p className="notice">The normal output window is truncated.{result.raw === null ? " Full output was not requested." : " The complete output is available below."}</p> : null}{result.raw === null ? null : <details><summary>Complete raw output</summary><pre>{result.raw}</pre></details>}
      {result.calls.length === 0 ? <p>No nested tool calls.</p> : <section aria-label="Nested tool calls"><h4>Nested calls</h4>{result.calls.map((call, index) => <details key={index}><summary>{call.tool} · {call.subagent ?? "main"} · {call.ok ? "completed" : "failed"}</summary><h5>Input</h5><pre>{call.input}</pre><h5>Output</h5><pre>{call.output}</pre></details>)}</section>}
      <Inspect value={result} label="Complete tool result" />
    </section>}
  </div></Modal>;
}
