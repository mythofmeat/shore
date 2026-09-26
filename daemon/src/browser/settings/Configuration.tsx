import { useMemo, useState } from "react";
import type { ConfigSchemaEntry } from "../../protocol/ConfigSchemaEntry.ts";
import type { ConfigSources } from "../../protocol/ConfigSources.ts";
import type { ConfigCheckResult } from "../../protocol/ConfigCheckResult.ts";
import type { ConfigReloadResult } from "../../protocol/ConfigReloadResult.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { Control } from "../forms.ts";
import { configAt, settingControl, settingText } from "../settings_forms.ts";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/icons.tsx";
import { workspace } from "../app/state.ts";
import { takeConfigSearch } from "../app/intents.ts";
import { SettingsSection } from "./layout.tsx";
import { Loading, useAction, useOperation } from "./shared.tsx";

function summary(value: unknown, secret: boolean): string {
  if (secret) return value === null || value === undefined || value === "" ? "Not set" : "Set (hidden)";
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ");
  return JSON.stringify(value);
}

function controlFor(entry: ConfigSchemaEntry, sources: ConfigSources | undefined): Control {
  const control = settingControl(entry);
  const source = entry.source ?? entry.key_source;
  const choices = source === undefined ? undefined : sources?.[source];
  if (control.kind === "string" && control.choices === undefined && choices !== undefined && choices.length > 0) return { kind: "string", choices: ["", ...choices] };
  return control;
}

function ConfigRow({ entry, effective, fallback, sources, saved }: { entry: ConfigSchemaEntry; effective: unknown; fallback: unknown; sources: ConfigSources | undefined; saved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<unknown>(entry.secret ? "" : effective);
  const { busy, run } = useAction();
  const save = () => void run(async () => {
    const result = await workspace.actions.run("config", { key: entry.key, value: settingText(entry, value) });
    setEditing(false); saved();
    if (!("set" in result)) return `Saved ${entry.key}`;
    if (result.masked_by_preference !== null) return `Saved, but ${result.masked_by_preference} overrides it`;
    return result.restart_required.length > 0 ? `Saved ${entry.key}. Restart the daemon to apply it.` : `Saved ${entry.key}`;
  });
  return <div className="config-row">
    <div className="config-main">
      <div className="config-key"><span className="mono">{entry.key}</span>{entry.restart_required ? <span className="tag muted-tag">restart</span> : null}{entry.secret ? <span className="tag muted-tag">secret</span> : null}</div>
      <div className="config-value">{summary(effective, entry.secret)}{!entry.secret && fallback !== null && fallback !== undefined && JSON.stringify(fallback) !== JSON.stringify(effective) ? <span className="muted"> · default {summary(fallback, false)}</span> : null}</div>
    </div>
    {editing ? null : <button type="button" className="button ghost" onClick={() => { setValue(entry.secret ? "" : effective ?? undefined); setEditing(true); }}>Edit</button>}
    {editing ? <div className="config-editor">
      <Field control={controlFor(entry, sources)} value={value} change={setValue} label={entry.key} id={`config-${entry.key}`} secret={entry.secret} />
      <div className="actions-row tight"><button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="button primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>
    </div> : null}
  </div>;
}

function CheckResult({ result }: { result: ConfigCheckResult }) {
  return <div className={`notice-box ${result.valid ? "" : "bad"}`}>
    <p className="setting-label"><Icon name={result.valid ? "check" : "alert"} size={16} /> {result.valid ? "The configuration is valid." : "The configuration has problems."}</p>
    {[...result.warnings.map((text) => ["Warning", text]), ...result.info.map((text) => ["Note", text])].map(([kind, text], index) => <p key={index} className="setting-description">{kind}: {text}</p>)}
    <dl className="kv">
      <div className="kv-row"><dt>Config folder</dt><dd className="mono">{result.config_dir}</dd></div>
      <div className="kv-row"><dt>Data folder</dt><dd className="mono">{result.data_dir}</dd></div>
      <div className="kv-row"><dt>Cache folder</dt><dd className="mono">{result.cache_dir}</dd></div>
      <div className="kv-row"><dt>Chat models / providers</dt><dd>{result.chat_models} / {result.providers}</dd></div>
    </dl>
  </div>;
}

function ReloadResult({ result, apply, busy }: { result: ConfigReloadResult; apply: () => void; busy: boolean }) {
  return <div className="notice-box">
    <p className="setting-label">{result.applied ? "Reloaded the configuration from disk." : "Reloading would pick up the files below."}</p>
    <p className="setting-description mono">{result.config_path}</p>
    {result.changed_prompt_files.length === 0 ? <p className="setting-description">No prompt files changed.</p> : <p className="setting-description">Changed prompt files: <span className="mono">{result.changed_prompt_files.join(", ")}</span></p>}
    {(result.restart_required ?? []).length === 0 ? null : <p className="setting-description">Needs a daemon restart: <span className="mono">{result.restart_required?.join(", ")}</span></p>}
    {result.applied ? null : <div className="actions-row"><button type="button" className="button primary" disabled={busy} onClick={apply}>Apply and refresh prompts</button></div>}
  </div>;
}

export function ConfigurationPage({ state }: { state: WorkspaceSnapshot }) {
  const schema = useOperation(state, "config_schema", {}, []);
  const view = useOperation(state, "config", {}, []);
  const tools = useOperation(state, "tools", {}, []);
  const [query, setQuery] = useState(takeConfigSearch);
  const [check, setCheck] = useState<ConfigCheckResult>();
  const [reload, setReload] = useState<ConfigReloadResult>();
  const action = useAction();
  const config = view.data !== undefined && "config" in view.data ? view.data : undefined;
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const entries = (schema.data?.schema ?? []).filter((entry) => entry.settable && !entry.key.includes("<") && (needle === "" || entry.key.toLowerCase().includes(needle)));
    const map = new Map<string, ConfigSchemaEntry[]>();
    for (const entry of entries) { const group = entry.key.split(".")[0] ?? entry.key; map.set(group, [...(map.get(group) ?? []), entry]); }
    return [...map.entries()];
  }, [schema.data, needle]);
  return <>
    <p className="settings-description">The daemon’s configuration file, as it applies to {state.character ?? "the current character"}. Tables such as providers and budgets are edited in the file itself.</p>
    <SettingsSection title="Maintenance">
      <div className="actions-row tight">
        <button type="button" className="button" disabled={action.busy} onClick={() => void action.run(async () => { setCheck(await workspace.actions.run("config_check", {})); return undefined; })}>Check configuration</button>
        <button type="button" className="button" disabled={action.busy} onClick={() => void action.run(async () => { setReload(await workspace.actions.run("config_reload", {})); return undefined; })}>Reload from disk…</button>
      </div>
      {check === undefined ? null : <CheckResult result={check} />}
      {reload === undefined ? null : <ReloadResult result={reload} busy={action.busy} apply={() => void action.run(async () => { setReload(await workspace.actions.run("config_reload", { apply: true, refresh_prompts: true })); view.refresh(); return "Configuration reloaded"; })} />}
    </SettingsSection>
    <SettingsSection title="Settings" actions={<label className="sidebar-search config-search"><Icon name="search" size={16} /><input type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}>
      <Loading error={schema.error || view.error} ready={schema.data !== undefined && config !== undefined}>
        {groups.length === 0 ? <p className="settings-empty">No settings match “{query}”.</p> : groups.map(([group, entries]) => <details key={group} className="config-group" open={needle !== ""}>
          <summary><Icon name="chevronRight" size={14} className="config-chevron" /><span className="mono">{group}</span><span className="muted">{entries.length}</span></summary>
          <div className="rows">{entries.map((entry) => <ConfigRow key={entry.key} entry={entry} effective={configAt(config?.config, entry.key)} fallback={configAt(config?.defaults, entry.key)} sources={schema.data?.sources} saved={view.refresh} />)}</div>
        </details>)}
      </Loading>
    </SettingsSection>
    <SettingsSection title="Tool access" description="Which tools the character and its subagents can use.">
      <Loading error={tools.error} ready={tools.data !== undefined}>
        {tools.data === undefined ? null : <>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Tool</th><th>Character</th><th>Subagents</th></tr></thead>
            <tbody>{tools.data.tools.map((tool) => <tr key={tool.tool}><td className="mono">{tool.tool}</td><td>{tool.main ? "Yes" : "No"}</td><td>{tool.subagents.join(", ") || "—"}</td></tr>)}</tbody>
          </table></div>
          {tools.data.mcp.length === 0 ? null : <p className="setting-description">MCP tools: <span className="mono">{tools.data.mcp.join(", ")}</span></p>}
          {tools.data.subagents.map((agent) => <p key={agent.name} className="setting-description">Subagent <strong>{agent.name}</strong>{agent.enabled ? "" : " (disabled)"}: {agent.tools.join(", ") || "no tools"}{agent.model === null ? "" : ` · ${agent.model}`}</p>)}
          {tools.data.warnings.map((warning, index) => <p key={index} className="form-error">{warning}</p>)}
        </>}
      </Loading>
    </SettingsSection>
  </>;
}
