import { useEffect, useState } from "react";
import type { ToolDescription } from "../../protocol/ToolDescription.ts";
import type { ToolRunReport } from "../../protocol/ToolRunReport.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { initialValue } from "../forms.ts";
import { mediaSource } from "../media.ts";
import { toolControl, toolNames } from "../tool_forms.ts";
import { Field } from "../ui/Field.tsx";
import { Spinner } from "../ui/controls.tsx";
import { errorText, workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatNumber, Loading, NeedsCharacter, useAction, useOperation } from "./shared.tsx";
import { parsePairs } from "./format.ts";


function Report({ report }: { report: ToolRunReport }) {
  const images = (report.images ?? []).flatMap((image) => { const source = mediaSource(image.data); return source === undefined ? [] : [{ source, caption: image.caption ?? image.path }]; });
  return <div className="rows padded">
    <div className={`status-text ${report.ok ? "ok" : "bad"}`}>{report.rejected ? "Rejected before running" : report.ok ? "Finished" : "Failed"} in {formatNumber(report.duration_ms)} ms{report.truncated ? ` · output truncated to ${formatNumber(report.result_chars)} characters` : ""}</div>
    <pre className="readout">{report.output === "" ? "(no output)" : report.output}</pre>
    {images.length === 0 ? null : <div className="images">{images.map((image, index) => <img key={index} className="tool-image" src={image.source} alt={image.caption} />)}</div>}
    {report.calls.length === 0 ? null : <><div className="tool-label">Nested calls</div>{report.calls.map((call, index) => <details key={index} className="disclosure payload"><summary>{call.subagent === null ? "" : `${call.subagent} → `}{call.tool} {call.ok ? "" : "(failed)"}</summary><pre className="readout">{call.input}{"\n\n"}{call.output}</pre></details>)}</>}
    {report.raw === null ? null : <details className="disclosure payload"><summary>Raw result</summary><pre className="readout">{report.raw}</pre></details>}
  </div>;
}

function ToolForm({ tool }: { tool: string }) {
  const [description, setDescription] = useState<ToolDescription>();
  const [error, setError] = useState("");
  const [value, setValue] = useState<unknown>({});
  const [mode, setMode] = useState<"form" | "pairs">("form");
  const [pairs, setPairs] = useState("");
  const [raw, setRaw] = useState(false);
  const [report, setReport] = useState<ToolRunReport>();
  const { busy, run } = useAction();
  useEffect(() => {
    let alive = true;
    setDescription(undefined); setReport(undefined); setError("");
    workspace.actions.run("run_tool", { tool, describe: true }).then((result) => {
      if (!alive || !("input_schema" in result)) return;
      setDescription(result);
      try { setValue(initialValue(toolControl(result.input_schema))); } catch (failure) { setError(errorText(failure)); setMode("pairs"); }
    }).catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, [tool]);
  let control;
  try { control = description === undefined ? undefined : toolControl(description.input_schema); } catch { control = undefined; }
  return <div className="tool-runner">
    {description === undefined ? error === "" ? <Spinner label="Loading tool" /> : null : <p className="setting-description">{description.description}{description.enabled ? "" : " (not enabled for this character)"}</p>}
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    <div className="segmented" role="radiogroup" aria-label="Input">
      <button type="button" role="radio" aria-checked={mode === "form"} disabled={control === undefined} onClick={() => setMode("form")}>Form</button>
      <button type="button" role="radio" aria-checked={mode === "pairs"} onClick={() => setMode("pairs")}>key=value lines</button>
    </div>
    {mode === "form" && control !== undefined ? <div className="rows padded"><Field control={control} value={value} change={setValue} label={tool} id={`tool-${tool}`} /></div> : null}
    {mode === "pairs" ? <textarea className="input textarea mono" aria-label="Arguments as key=value lines" rows={4} placeholder={"path=notes/trip.md\nlimit=20"} value={pairs} onChange={(event) => setPairs(event.target.value)} /> : null}
    <div className="inline-form wrap">
      <label className="check"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />Include the raw result</label>
      <button type="button" className="button primary" disabled={busy || description === undefined} onClick={() => void run(async () => {
        const input = mode === "pairs" ? { pairs: parsePairs(pairs) } : { input: value as Record<string, unknown> };
        const result = await workspace.actions.run("run_tool", { tool, ...input, ...(raw ? { raw: true } : {}) });
        if ("output" in result) setReport(result);
        return undefined;
      })}>{busy ? "Running…" : "Run tool"}</button>
    </div>
    {report === undefined ? null : <Report report={report} />}
  </div>;
}

export function ToolsPage({ state }: { state: WorkspaceSnapshot }) {
  const access = useOperation(state, "tools", {}, [], state.character !== null);
  const [tool, setTool] = useState("");
  if (state.character === null) return <NeedsCharacter />;
  const enabled = new Set(access.data?.tools.filter((item) => item.main).map((item) => item.tool) ?? []);
  const names = access.data === undefined ? [] : toolNames(access.data).sort((a, b) => Number(enabled.has(b)) - Number(enabled.has(a)) || a.localeCompare(b));
  const selected = names.includes(tool) ? tool : names[0] ?? "";
  return <>
    <p className="settings-description">Run one of {state.character}’s tools by hand, as the character would. Results aren’t added to the conversation.</p>
    <SettingsSection title="Tool" actions={<select className="select" aria-label="Tool" value={selected} onChange={(event) => setTool(event.target.value)}>{names.map((name) => <option key={name} value={name}>{name}</option>)}</select>}>
      <Loading error={access.error} ready={access.data !== undefined}>{selected === "" ? <p className="settings-empty">No tools are available.</p> : <ToolForm key={selected} tool={selected} />}</Loading>
    </SettingsSection>
  </>;
}
