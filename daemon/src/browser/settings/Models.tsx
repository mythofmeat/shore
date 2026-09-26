import { useEffect, useState } from "react";
import type { ModelInfoResult } from "../../protocol/ModelInfoResult.ts";
import type { ModelSettingsDetail } from "../../protocol/ModelSettingsDetail.ts";
import type { ModelSettingSchemaEntry } from "../../protocol/ModelSettingSchemaEntry.ts";
import type { ModelPreferenceScope } from "../../protocol/ModelPreferenceScope.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { modelSettingControl } from "../model_forms.ts";
import { IconButton, Spinner } from "../ui/controls.tsx";
import { Field, fieldLabel } from "../ui/Field.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";
import { flattenModels, ModelPicker, shortModel, targetLabel, useModelListing, type ModelTarget } from "../chat/models.tsx";
import { SettingRow, SettingsSection } from "./layout.tsx";
import { NeedsCharacter, useAction, useOperation } from "./shared.tsx";
import { sourceLabel } from "./format.ts";

type Inspect = ModelTarget | { kind: "model"; name: string };

function inspectArgs(target: Inspect): { name?: string; background_task?: "all" | "heartbeat" | "compaction"; subagent?: string } {
  return target.kind === "model" ? { name: target.name } : targetArgs(target);
}

function targetArgs(target: ModelTarget): { background_task?: "all" | "heartbeat" | "compaction"; subagent?: string } {
  return target.kind === "background" ? { background_task: target.task } : target.kind === "subagent" ? { subagent: target.name } : {};
}


function targetKey(target: Inspect): string {
  if (target.kind === "model") return `model:${target.name}`;
  return target.kind === "background" ? `background:${target.task}` : target.kind === "subagent" ? `subagent:${target.name}` : target.kind;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ModelDetails({ info }: { info: ModelInfoResult }) {
  const rows: [string, unknown][] = [
    ["Provider", info.provider_key], ["Model ID", info.model_id], ["SDK", info.sdk], ["Context window", info.max_context_tokens?.toLocaleString()],
    ["Max output", info.max_output_tokens?.toLocaleString()], ["Temperature", info.temperature], ["Top P", info.top_p], ["Reasoning effort", info.reasoning_effort],
    ["Thinking budget", info.budget_tokens], ["Images", info.supports_images === null ? null : info.supports_images ? "Supported" : "Not supported"],
    ["Prompt cache TTL", info.cache_ttl], ["Cache keepalive", info.cache_keepalive], ["Tool iterations", info.max_tool_iterations], ["API key variable", info.api_key_env], ["Base URL", info.base_url],
  ];
  return <dl className="kv">{rows.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => <div key={label} className="kv-row"><dt>{label}</dt><dd className={label === "Model ID" || label === "Base URL" || label === "API key variable" ? "mono" : ""}>{display(value)}</dd></div>)}</dl>;
}

function SamplerRow({ entry, detail, scope, target, saved }: { entry: ModelSettingSchemaEntry; detail: ModelSettingsDetail; scope: ModelPreferenceScope; target: ModelTarget; saved: () => void }) {
  const stored = (scope === "global" ? detail.saved_global : detail.saved_character)?.[entry.key];
  const [value, setValue] = useState<unknown>(stored);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(stored); }, [stored]);
  let control;
  try { control = modelSettingControl(entry); } catch { return null; }
  const effective = detail.effective_sampler[entry.key];
  const { run } = useAction();
  const save = async (next: unknown) => {
    setBusy(true);
    try {
      const result = await workspace.actions.run("set_model_setting", { key: entry.key, scope, value: next === undefined ? null : next, name: detail.model, ...targetArgs(target) });
      if (result.warning !== undefined) toasts.show(result.warning, "error"); else toasts.show(next === undefined ? `${fieldLabel(entry.key)} reset` : `${fieldLabel(entry.key)} saved`);
      saved();
    } catch (failure) { toasts.show(errorText(failure), "error"); } finally { setBusy(false); }
  };
  const [scopes, setScopes] = useState<string>();
  const where = () => void run(async () => {
    const result = await workspace.actions.run("model_settings", { key: entry.key, name: detail.model, ...targetArgs(target) });
    if (!("setting_schema" in result)) return undefined;
    const global = result.saved_global?.[entry.key];
    const own = result.saved_character?.[entry.key];
    setScopes([own === undefined ? `Not set for ${detail.applies_to ?? "this character"}` : `Set for this character: ${display(own)}`, global === undefined ? "not set for all characters" : `set for all characters: ${display(global)}`, `in effect: ${display(result.effective_sampler[entry.key])}`, result.scopes[entry.key] === null || result.scopes[entry.key] === undefined ? "" : `from ${String(result.scopes[entry.key])}`].filter(Boolean).join("; "));
    return undefined;
  });
  const note = entry.applicability === "ignored" ? "This provider ignores this setting." : entry.applicability === "rejected" ? "This provider rejects this setting." : `Current value: ${display(effective)}`;
  return <SettingRow label={fieldLabel(entry.key)} description={scopes ?? note}>
    <Field control={control} value={value} change={setValue} label={fieldLabel(entry.key)} id={`sampler-${entry.key}`} />
    <button type="button" className="button" disabled={busy || JSON.stringify(value) === JSON.stringify(stored)} onClick={() => void save(value)}>Save</button>
    {stored === undefined ? null : <button type="button" className="button ghost" disabled={busy} onClick={() => void save(undefined)}>Reset</button>}
    <IconButton icon="info" label={`Where is ${fieldLabel(entry.key)} set?`} onClick={where} />
  </SettingRow>;
}

function ModelSettings({ target, state }: { target: ModelTarget; state: WorkspaceSnapshot }) {
  const [scope, setScope] = useState<ModelPreferenceScope>("character");
  const [version, setVersion] = useState(0);
  const { data, error } = useOperation(state, "model_settings", targetArgs(target), [targetKey(target), version]);
  const detail = data !== undefined && "setting_schema" in data ? data : undefined;
  return <SettingsSection title={detail === undefined ? "Model settings" : `Settings for ${shortModel(detail.model)}`} description="Sampler and provider options. Empty fields use the model’s configured value."
    actions={<div className="segmented" role="radiogroup" aria-label="Save settings for">
      <button type="button" role="radio" aria-checked={scope === "character"} onClick={() => setScope("character")}>{state.character}</button>
      <button type="button" role="radio" aria-checked={scope === "global"} onClick={() => setScope("global")}>All characters</button>
    </div>}>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    {detail === undefined ? error === "" ? <Spinner label="Loading model settings" /> : null : <div className="rows">
      {detail.setting_schema.filter((entry) => entry.applicability !== "rejected").map((entry) => <SamplerRow key={`${entry.key}:${scope}`} entry={entry} detail={detail} scope={scope} target={target} saved={() => setVersion((value) => value + 1)} />)}
    </div>}
  </SettingsSection>;
}

export function ModelsPage({ state }: { state: WorkspaceSnapshot }) {
  const { listing, refresh } = useModelListing(state);
  const [picker, setPicker] = useState<{ target: ModelTarget; current: string | null } | null>(null);
  const [inspect, setInspect] = useState<Inspect>({ kind: "character" });
  const tools = useOperation(state, "tools", {}, []);
  const info = useOperation(state, "model_info", inspectArgs(inspect), [targetKey(inspect), listing]);
  if (state.character === null) return <NeedsCharacter />;
  const thread = state.threads.find((item) => item.id === state.thread);
  const role = (name: string) => listing?.roles.find((item) => item.role === name);
  const chat = role("chat");
  const subagents = tools.data?.subagents ?? [];
  const row = (target: ModelTarget, model: string | null | undefined, source: string | null | undefined) => <SettingRow key={targetKey(target)} label={targetLabel(target, state.character)} description={sourceLabel(source, state.character)}>
    <button type="button" className="select-button" onClick={() => setPicker({ target, current: model ?? null })}><span className="mono">{model ?? "Not set"}</span></button>
  </SettingRow>;
  return <>
    <p className="settings-description">Which models {state.character} uses. Changes apply to the next response.</p>
    <SettingsSection title="Chat">
      <div className="rows">
        {row({ kind: "character" }, chat?.model, chat?.source)}
        {state.thread === null ? null : row({ kind: "thread" }, thread?.chat_model ?? null, thread?.chat_model === undefined ? `thread-default` : `thread ${state.thread}`)}
      </div>
    </SettingsSection>
    <SettingsSection title="Background tasks" description="Heartbeat check-ins and compaction can use a different model from chat.">
      <div className="rows">
        {(["heartbeat", "compaction"] as const).map((task) => { const item = role(task); return row({ kind: "background", task }, item?.model, item?.source); })}
      </div>
    </SettingsSection>
    {subagents.length === 0 ? null : <SettingsSection title="Subagents">
      <div className="rows">{subagents.map((agent) => row({ kind: "subagent", name: agent.name }, agent.model ?? role("sub-agents")?.model, agent.model === null ? "inherits" : undefined))}</div>
    </SettingsSection>}
    <SettingsSection title="Model details" actions={<select className="select" aria-label="Show details for" value={targetKey(inspect)} onChange={(event) => {
      const value = event.target.value;
      setInspect(value === "character" ? { kind: "character" } : value.startsWith("background:") ? { kind: "background", task: value.slice(11) as "heartbeat" | "compaction" } : value.startsWith("model:") ? { kind: "model", name: value.slice(6) } : { kind: "subagent", name: value.slice(9) });
    }}>
      <option value="character">Chat</option><option value="background:heartbeat">Heartbeat</option><option value="background:compaction">Compaction</option>
      {subagents.map((agent) => <option key={agent.name} value={`subagent:${agent.name}`}>Subagent {agent.name}</option>)}
      <optgroup label="Any model">{flattenModels(listing).map((model) => <option key={model.qualified_name} value={`model:${model.qualified_name}`}>{model.qualified_name}</option>)}</optgroup>
    </select>}>
      {info.error === "" ? null : <p className="form-error" role="alert">{info.error}</p>}
      {info.data === undefined ? info.error === "" ? <Spinner label="Loading model details" /> : null : <div className="rows padded"><p className="setting-label mono">{info.data.qualified_name}</p><ModelDetails info={info.data} /></div>}
    </SettingsSection>
    {inspect.kind === "model" ? null : <ModelSettings key={targetKey(inspect)} target={inspect} state={state} />}
    {picker === null ? null : <ModelPicker state={state} target={picker.target} current={picker.current} scopes={false} close={() => setPicker(null)} changed={refresh} />}
  </>;
}
