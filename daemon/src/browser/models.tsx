import { useEffect, useState } from "react";
import type { ModelPreferenceScope } from "../protocol/ModelPreferenceScope.ts";
import type { ModelListing } from "../protocol/ModelListing.ts";
import type { ModelSettingsOverview } from "../protocol/ModelSettingsOverview.ts";
import type { ModelSettingsDetail } from "../protocol/ModelSettingsDetail.ts";
import type { ModelSettingSchemaEntry } from "../protocol/ModelSettingSchemaEntry.ts";
import type { ModelInfoResult } from "../protocol/ModelInfoResult.ts";
import type { ModelInfoArgs } from "../protocol/ModelInfoArgs.ts";
import type { ModelSettingChanged } from "../protocol/ModelSettingChanged.ts";
import type { OperationClient } from "./operations.ts";
import { Field, Inspect, JsonValue, Modal } from "./components.tsx";
import { initialValue } from "./forms.ts";
import { modelSettingControl } from "./model_forms.ts";

function ModelSetting({ entry, detail, scope, busy, save }: { entry: ModelSettingSchemaEntry; detail: ModelSettingsDetail; scope: string; busy: boolean; save: (key: string, value: unknown) => Promise<ModelSettingChanged> }) {
  const effective = detail.effective_sampler[entry.key] ?? null;
  const control = modelSettingControl(entry);
  const [value, setValue] = useState<unknown>(() => effective ?? (entry.kind === "json_object" ? {} : initialValue(control)));
  const [error, setError] = useState("");
  const [result, setResult] = useState<ModelSettingChanged>();
  const submit = async (next: unknown) => {
    setError(""); setResult(undefined);
    try { const changed = await save(entry.key, next); setResult(changed); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const applicable = entry.applicability === "always" || entry.applicability === "honored";
  return <section className="setting-detail" aria-label={`Model setting ${entry.key}`}><h4>{entry.key}</h4><p className="muted">{entry.kind} · {entry.applicability} · saving to {scope} preferences</p>
    <div className="setting-values"><div><h4>Effective value</h4><pre>{JSON.stringify(effective, null, 2)}</pre><small>{detail.scopes[entry.key] ?? "Default"}</small></div><div><h4>Saved global</h4><pre>{JSON.stringify(detail.saved_global?.[entry.key] ?? null, null, 2)}</pre><h4>Saved character</h4><pre>{JSON.stringify(detail.saved_character?.[entry.key] ?? null, null, 2)}</pre></div></div>
    <form onSubmit={(event) => { event.preventDefault(); void submit(value); }}><fieldset disabled={busy || !applicable} className="action-fields">
      {entry.kind === "json_object" ? <JsonValue label="Value" value={value} change={setValue} objectOnly /> : <Field control={control} value={value} change={setValue} label="Value" suggestions={entry.suggestions} />}
      {entry.editor === undefined ? null : <label className="field">Suggested range<input type="range" min={entry.editor.min} max={entry.editor.max} step={entry.editor.step} value={typeof value === "number" ? value : entry.editor.min} onChange={(event) => setValue(event.target.valueAsNumber)} /></label>}
      <button type="submit" className="primary">Save model setting</button>
    </fieldset></form>
    {!applicable ? <p>This provider does not honor this setting for the selected model.</p> : null}
    <button disabled={busy} onClick={() => { void submit(null); }}>Clear saved setting</button>
    {error === "" ? null : <p role="alert" className="error">{error}</p>}
    {result === undefined ? null : <div role="status"><strong>{result.value === null ? "Saved setting cleared" : "Model setting saved"}</strong>{result.also_affects === undefined ? null : <p>Also affects: {result.also_affects.join(", ")}</p>}<Inspect value={result} label="Setting change details" /></div>}
  </section>;
}

export function Models({ actions, ready, character, changed, close }: { actions: OperationClient; ready: boolean; character: string | null; changed: () => Promise<void>; close: () => void }) {
  const [listing, setListing] = useState<ModelListing>();
  const [overview, setOverview] = useState<ModelSettingsOverview>();
  const [subagents, setSubagents] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState(false);
  const [favorites, setFavorites] = useState(false);
  const [target, setTarget] = useState("chat");
  const [named, setNamed] = useState("");
  const [scope, setScope] = useState<ModelPreferenceScope>(character === null ? "global" : "character");
  const [detail, setDetail] = useState<ModelSettingsDetail>();
  const [info, setInfo] = useState<ModelInfoResult>();
  const [setting, setSetting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>();
  const targetArgs = (choice = target, model = named): ModelInfoArgs => choice === "background:all" ? { background_task: "all" } : choice === "background:heartbeat" ? { background_task: "heartbeat" } : choice === "background:compaction" ? { background_task: "compaction" } : choice.startsWith("subagent:") ? { subagent: choice.slice(9) } : choice === "named" ? { name: model } : {};
  const refresh = async (includeHidden = hidden, favoritesOnly = favorites) => {
    const [models, roles, tools] = await Promise.all([actions.run("list_models", { include_hidden: includeHidden, favorites_only: favoritesOnly }), actions.run("model_settings", { overview: true }), actions.run("tools", {})]);
    if (!("overview" in roles)) throw new Error("Expected model role overview");
    setListing(models); setOverview(roles); setSubagents(tools.subagents.map((subagent) => subagent.name));
  };
  const inspect = async (choice = target, model = named) => {
    const args = targetArgs(choice, model);
    const [nextInfo, nextDetail] = await Promise.all([actions.run("model_info", args), actions.run("model_settings", args)]);
    if (!("setting_schema" in nextDetail)) throw new Error("Expected model settings");
    setInfo(nextInfo); setDetail(nextDetail);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let current = true;
    if (ready) {
      setBusy(true);
      void Promise.all([actions.run("list_models", {}), actions.run("model_settings", { overview: true }), actions.run("tools", {})]).then(([models, roles, tools]) => {
        if (!current) return;
        if (!("overview" in roles)) throw new Error("Expected model role overview");
        setListing(models); setOverview(roles); setSubagents(tools.subagents.map((subagent) => subagent.name)); setError(""); setHidden(false); setFavorites(false);
      }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready, character]);
  const selectTarget = (choice: string, model = named) => {
    setTarget(choice); setNamed(model); setDetail(undefined); setInfo(undefined); setSetting(undefined);
    void run(() => inspect(choice, model));
  };
  const disabled = busy || !ready;
  const roleTarget = target.startsWith("background:") || target.startsWith("subagent:");
  const entry = detail?.setting_schema.find((item) => item.key === setting);
  return <Modal title="Models & roles" close={close}><p className="muted">Active chat: {listing?.active ?? "No model selected"}. Favorites are global. Role selections update global configuration; chat selection pins the current thread.</p>
    <p className="muted">Background and subagent models inherit the character default independently of thread pins.</p>
    {!ready ? <p role="status">Reconnect before changing models. Unsaved settings remain while this dialog stays open.</p> : null}{busy ? <p role="status">Loading models…</p> : null}{error === "" ? null : <p role="alert" className="error">{error}</p>}
    <section aria-label="Model roles"><h3>Roles and inheritance</h3><div className="table-scroll"><table><thead><tr><th>Role</th><th>Model</th><th>Source</th></tr></thead><tbody>{listing?.roles.map((role) => <tr key={role.role}><td>{role.role}</td><td>{role.model ?? "Not configured"}</td><td>{role.source ?? "None"}</td></tr>)}</tbody></table></div>
      {overview?.roles.map((role) => <details key={role.role}><summary>{role.role} · {role.model ?? "Unresolved"}{role.settings.length > 0 ? ` · ${String(role.settings.length)} saved settings` : ""}</summary>{role.error === null ? null : <p className="error">{role.error}</p>}<Inspect value={role} label="Role and saved settings" /></details>)}<Inspect value={overview} label="Complete role overview" />
    </section>
    <label className="field">Target role<select disabled={disabled} value={target} onChange={(event) => selectTarget(event.target.value)}><option value="chat">Chat (current thread)</option><option value="background:all">All background tasks</option><option value="background:heartbeat">Heartbeat</option><option value="background:compaction">Compaction</option><option value="subagent:all">All subagents</option>{subagents.map((name) => <option key={name} value={`subagent:${name}`}>Subagent: {name}</option>)}{named === "" ? null : <option value="named">Named model: {named}</option>}</select></label>
    <div className="actions"><button disabled={disabled} onClick={() => { void run(() => inspect()); }}>Inspect target settings</button><button disabled={disabled || (!roleTarget && character === null) || target === "named"} onClick={() => { void run(async () => {
      setResult(await actions.run("reset_model", targetArgs())); await refresh(); await inspect(); await changed();
    }); }}>Reset model selection</button></div>
    <label className="field">Find a model<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="actions"><label className="check"><input disabled={disabled} type="checkbox" checked={hidden} onChange={(event) => { const value = event.target.checked; setHidden(value); void run(async () => { try { await refresh(value, favorites); } catch (failure) { setHidden(hidden); throw failure; } }); }} />Include hidden models</label><label className="check"><input disabled={disabled} type="checkbox" checked={favorites} onChange={(event) => { const value = event.target.checked; setFavorites(value); void run(async () => { try { await refresh(hidden, value); } catch (failure) { setFavorites(favorites); throw failure; } }); }} />Favorites only</label></div>
    {listing === undefined ? null : <p className="muted">{String(listing.favorite_count)} favorites · {String(listing.hidden_count)} hidden models</p>}
    <div className="model-cards">{Object.entries(listing?.models ?? {}).flatMap(([provider, models]) => models.map((model) => ({ ...model, provider }))).filter((model) => `${model.name} ${model.qualified_name} ${model.model_id}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.qualified_name.localeCompare(b.qualified_name)).map((model) => <article className="provider-card" key={model.qualified_name} aria-label={`${model.qualified_name} model`}><h3>{model.name}</h3><p className="muted">{model.qualified_name} · {model.source}{model.hidden ? " · hidden" : ""}{model.qualified_name === listing?.active ? " · active" : ""}</p>
      <div className="actions"><button disabled={disabled} aria-pressed={model.favorite} onClick={() => { void run(async () => { setResult(await actions.run("favorite_model", { name: model.qualified_name, favorite: !model.favorite })); await refresh(); }); }}>{model.favorite ? "Remove favorite" : "Favorite"}</button><button disabled={disabled} onClick={() => selectTarget("named", model.qualified_name)}>Inspect model</button><button disabled={disabled || (!roleTarget && character === null)} onClick={() => { void run(async () => {
        setResult(await actions.run("switch_model", { ...(roleTarget ? targetArgs() : {}), name: model.qualified_name, include_hidden: hidden })); await refresh(); if (detail !== undefined) await inspect(); await changed();
      }); }}>Use for {roleTarget ? target.replace(":", " ") : "chat"}</button></div><Inspect value={model} label="Catalogue entry" />
    </article>)}</div>
    {result === undefined ? null : <section role="status"><h3>Model change completed</h3><Inspect value={result} label="Model change details" /></section>}
    {info === undefined || detail === undefined ? null : <section aria-label="Target model settings"><h3>{detail.model}</h3><p className="muted">{info.sdk} · {info.max_context_tokens === null ? "Unknown context" : `${info.max_context_tokens.toLocaleString()} context tokens`}{detail.subagent === undefined ? "" : ` · subagent ${detail.subagent}`}</p><Inspect value={info} label="Model information and limits" />
      <label className="field">Preference scope<select disabled={disabled} value={scope} onChange={(event) => { if (event.target.value === "character" || event.target.value === "global") setScope(event.target.value); }}><option value="character" disabled={character === null}>This character</option><option value="global">Global</option></select></label>
      <label className="field">Model setting<select disabled={disabled} value={setting ?? ""} onChange={(event) => setSetting(event.target.value)}><option value="">Choose a setting</option>{detail.setting_schema.map((item) => <option key={item.key} value={item.key}>{item.key} · {item.applicability}</option>)}</select></label>
      {entry === undefined ? null : <ModelSetting key={`${target}.${named}.${entry.key}.${scope}`} entry={entry} detail={detail} scope={scope} busy={disabled} save={async (key, value) => {
        setBusy(true); setError("");
        try {
          const saved = await actions.run("set_model_setting", { ...targetArgs(), key, value, scope });
          try { await refresh(); await inspect(); await changed(); } catch (failure) { setError(`Setting saved, but refreshing its view failed: ${failure instanceof Error ? failure.message : String(failure)}`); }
          return saved;
        } finally { setBusy(false); }
      }} />}
      <Inspect value={detail} label="Effective settings, scopes and schema" />
    </section>}
    <Inspect value={listing} label="Complete model listing" />
  </Modal>;
}
