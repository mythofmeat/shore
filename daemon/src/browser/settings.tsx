import { useEffect, useState } from "react";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";
import type { ConfigSchemaResult } from "../protocol/ConfigSchemaResult.ts";
import type { ConfigView } from "../protocol/ConfigView.ts";
import type { ConfigSetResult } from "../protocol/ConfigSetResult.ts";
import type { ConfigCheckResult } from "../protocol/ConfigCheckResult.ts";
import type { ConfigReloadResult } from "../protocol/ConfigReloadResult.ts";
import type { ToolAccessResult } from "../protocol/ToolAccessResult.ts";
import { Field, Inspect, Modal } from "./components.tsx";
import { initialValue } from "./forms.ts";
import { configAt, settingControl, settingText } from "./settings_forms.ts";
import type { OperationClient } from "./operations.ts";

function Setting({ entry, effective, fallback, candidates, ready, save, browse }: {
  entry: ConfigSchemaEntry; effective: unknown; fallback: unknown; candidates: string[]; ready: boolean;
  save: (value: string) => Promise<ConfigSetResult>; browse: () => void;
}) {
  const control = entry.settable ? settingControl(entry) : undefined;
  const [value, setValue] = useState<unknown>(() => entry.secret ? "" : effective === null || effective === undefined ? control === undefined ? null : initialValue(control) : effective);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConfigSetResult>();
  const submit = async () => {
    setBusy(true); setError(""); setResult(undefined);
    try {
      const saved = await save(settingText(entry, value));
      setResult(saved); setValue(entry.secret ? "" : saved.value);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <section className="setting-detail" aria-label={`Setting ${entry.key}`}><h3>{entry.key}</h3>
    <p className="muted">{entry.type} · {entry.settable ? "Writable" : "Read only"}{entry.optional ? " · optional" : ""}{entry.restart_required ? " · restart required" : ""}</p>
    <div className="setting-values"><div><h4>Effective value</h4><pre>{JSON.stringify(effective, null, 2)}</pre></div><div><h4>Default</h4><pre>{JSON.stringify(fallback, null, 2)}</pre></div></div>
    {control === undefined ? <><p>Edit the individual fields in this section.</p><button onClick={browse}>Browse fields</button></> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy || !ready} className="action-fields"><Field control={control} value={value} change={setValue} label="Value" suggestions={candidates} secret={entry.secret} />
        {entry.secret ? <p className="muted">The saved secret is hidden. Enter a replacement to change it.</p> : null}
        {entry.kind === "duration" ? <p className="muted">Use a duration such as 30s, 5m, 1h or 7d.</p> : null}
        <div className="actions"><button type="submit" className="primary">{busy ? "Saving…" : "Save setting"}</button>{!entry.secret && fallback !== null ? <button type="button" onClick={() => setValue(fallback)}>Use default</button> : null}</div>
      </fieldset>
    </form>}
    {error === "" ? null : <p className="error" role="alert">{error}</p>}
    {result === undefined ? null : <div className="setting-result" role="status"><strong>Setting saved</strong><p>{result.set}</p>{result.restart_required.length === 0 ? null : <p>Restart required: {result.restart_required.join(", ")}</p>}{result.masked_by_preference === null ? null : <p>Character preference {result.masked_by_preference} still overrides this default.</p>}<Inspect value={result} label="Saved change details" /></div>}
  </section>;
}

export function Settings({ actions, ready, character, close }: { actions: OperationClient; ready: boolean; character: string | null; close: () => void }) {
  const [schema, setSchema] = useState<ConfigSchemaResult>();
  const [view, setView] = useState<ConfigView>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<ConfigCheckResult>();
  const [reload, setReload] = useState<ConfigReloadResult>();
  const [refreshPrompts, setRefreshPrompts] = useState(false);
  const [access, setAccess] = useState<ToolAccessResult>();
  useEffect(() => {
    let current = true;
    if (ready) {
      setBusy(true);
      void Promise.all([actions.run("config_schema", {}), actions.run("config", {})]).then(([nextSchema, nextView]) => {
        if (!current) return;
        if (!("config" in nextView)) throw new Error("Expected configuration values");
        setSchema(nextSchema); setView(nextView); setError("");
      }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready, character]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    const next = await actions.run("config", {});
    if (!("config" in next)) throw new Error("Expected configuration values");
    setView(next); setSchema(await actions.run("config_schema", {}));
  };
  const entry = schema?.schema.find((item) => item.key === selected);
  const entries = schema?.schema.filter((item) => `${item.key} ${item.type}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <Modal title="Settings" close={close}><p className="muted">{character === null ? "Global configuration" : `Configuration for ${character}`} · changes are validated and saved by the daemon.</p>
    <div className="actions settings-actions"><button disabled={busy || !ready} onClick={() => { void run(async () => { setCheck(await actions.run("config_check", {})); }); }}>Check configuration</button><button disabled={busy || !ready} onClick={() => { void run(async () => { setReload(await actions.run("config_reload", {})); }); }}>Preview reload</button><button disabled={busy || !ready} onClick={() => { void run(async () => { setAccess(await actions.run("tools", {})); }); }}>Tool access</button></div>
    {busy ? <p role="status">Loading settings…</p> : null}{!ready ? <p role="status">Reconnect before changing settings. Unsaved values are retained while this dialog stays open.</p> : null}
    {error === "" ? null : <p role="alert" className="error">{error}</p>}
    {check === undefined ? null : <section className="setting-result" aria-label="Configuration check"><h3>{check.valid ? "Configuration checks passed" : "Configuration needs attention"}</h3>{check.warnings.map((warning) => <p key={warning}>{warning}</p>)}{check.info.map((info) => <p className="muted" key={info}>{info}</p>)}<Inspect value={check} label="Check details" /></section>}
    {reload === undefined ? null : <section className="setting-result" aria-label="Configuration reload"><h3>{reload.applied ? "Configuration reloaded" : "Reload preview"}</h3><p>{reload.changed_prompt_files.length === 0 ? "No prompt changes" : `Changed prompts: ${reload.changed_prompt_files.join(", ")}`}</p><p>{(reload.restart_required?.length ?? 0) === 0 ? "No restart required" : `Restart required: ${reload.restart_required?.join(", ")}`}</p>
      {reload.applied ? <p>{reload.prompts_refreshed === true ? "Prompt snapshot refreshed" : "Prompt snapshot retained"}</p> : <><label className="check"><input type="checkbox" checked={refreshPrompts} disabled={busy || character === null} onChange={(event) => setRefreshPrompts(event.target.checked)} />Refresh prompt snapshot</label><button disabled={busy || !ready} onClick={() => { void run(async () => { setReload(await actions.run("config_reload", { apply: true, refresh_prompts: refreshPrompts && character !== null })); await refresh(); }); }}>Apply reload</button></>}
      <Inspect value={reload} label="Reload details" /></section>}
    {access === undefined ? null : <section className="setting-result" aria-label="Tool access"><h3>Tool access</h3>{access.warnings.map((warning) => <p key={warning}>{warning}</p>)}<div className="table-scroll"><table><thead><tr><th>Tool</th><th>Main</th><th>Subagents</th></tr></thead><tbody>{access.tools.map((tool) => <tr key={tool.tool}><td>{tool.tool}</td><td>{tool.main ? "Enabled" : "Disabled"}</td><td>{tool.subagents.join(", ") || "None"}</td></tr>)}</tbody></table></div><p>MCP tools: {access.mcp.join(", ") || "None"}</p><Inspect value={access} label="Tool and subagent details" /></section>}
    <label className="field">Find a setting<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="settings-keys" aria-label="Configuration keys">{entries.map((item) => <button key={item.key} aria-pressed={selected === item.key} onClick={() => setSelected(item.key)}><span>{item.key}</span><small>{item.type}{item.settable ? "" : " · read only"}{item.restart_required ? " · restart" : ""}</small></button>)}</div>
    {schema !== undefined && entries.length === 0 ? <p>No settings match this search.</p> : null}
    {entry === undefined || view === undefined ? <p className="muted">Select a setting to inspect its effective value and default.</p> : <Setting key={`${character ?? "global"}.${entry.key}`} entry={entry} effective={configAt(view.config, entry.key)} fallback={configAt(view.defaults, entry.key)} candidates={entry.source === undefined ? entry.values : schema?.sources[entry.source] ?? []} ready={ready && !busy} browse={() => setQuery(`${entry.key}.`)} save={async (value) => {
      setBusy(true);
      try {
        const result = await actions.run("config", { key: entry.key, value });
        if (!("set" in result)) throw new Error("Expected a saved setting");
        try { await refresh(); } catch (failure) { setError(`Setting saved, but refreshing its view failed: ${failure instanceof Error ? failure.message : String(failure)}`); }
        return result;
      } finally { setBusy(false); }
    }} />}
    {schema === undefined ? null : <Inspect value={schema} label="Configuration schema and value sources" />}
  </Modal>;
}
