import { useState } from "react";
import type { ProviderStatus } from "../../protocol/ProviderStatus.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Spinner } from "../ui/controls.tsx";
import { workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatNumber, formatTime, Loading, useAction, useOperation } from "./shared.tsx";

function ProviderModels({ state, provider }: { state: WorkspaceSnapshot; provider: string }) {
  const [hidden, setHidden] = useState(false);
  const listing = useOperation(state, "list_provider_models", { provider, include_hidden: hidden }, [provider, hidden]);
  const data = listing.data;
  return <div className="provider-models">
    <label className="check"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />Include hidden models</label>
    {listing.error === "" ? null : <p className="form-error" role="alert">{listing.error}</p>}
    {data === undefined ? listing.error === "" ? <Spinner label="Loading models" /> : null : <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Model</th><th>Source</th><th className="number">Context</th><th className="number">Max output</th><th>Supports</th></tr></thead>
        <tbody>
          {data.static.map((model) => <tr key={`s:${model.qualified_name}`}><td className="mono">{model.model_id}</td><td>Configured</td><td className="number">—</td><td className="number">{formatNumber(model.max_output_tokens)}</td><td>—</td></tr>)}
          {[...data.discovered, ...(hidden ? data.hidden : [])].map((model) => <tr key={`d:${model.model_id}`} className={data.hidden.includes(model) ? "muted-row" : ""}>
            <td><span className="mono">{model.model_id}</span>{model.display_name === null || model.display_name === model.model_id ? null : <div className="muted small">{model.display_name}</div>}</td>
            <td>{data.hidden.includes(model) ? "Hidden" : "Discovered"}</td>
            <td className="number">{formatNumber(model.context_length)}</td>
            <td className="number">{formatNumber(model.max_output_tokens)}</td>
            <td>{[model.supports_tools === true ? "tools" : "", model.supports_images === true ? "images" : "", model.supports_reasoning === true ? "reasoning" : "", model.supports_prompt_cache === true ? "caching" : ""].filter(Boolean).join(", ") || "—"}</td>
          </tr>)}
        </tbody>
      </table>
      {data.static.length + data.discovered.length === 0 ? <p className="settings-empty">No models listed. Refresh to discover models from this provider.</p> : null}
    </div>}
    {data?.cache.fetched_at === undefined || data.cache.fetched_at === null ? null : <p className="settings-description">Last refreshed {formatTime(data.cache.fetched_at)}.</p>}
  </div>;
}

function ProviderCard({ state, provider, refreshed }: { state: WorkspaceSnapshot; provider: ProviderStatus; refreshed: () => void }) {
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const missing = provider.keys.filter((key) => key.enabled && !key.env_set);
  return <div className={`provider ${provider.enabled ? "" : "disabled"}`}>
    <div className="provider-head">
      <div className="provider-title">
        <span className="setting-label">{provider.name}</span>
        <span className="setting-description">{provider.sdk}{provider.base_url === null ? "" : ` · ${provider.base_url}`}</span>
      </div>
      <span className={`status-pill ${!provider.enabled ? "off" : missing.length > 0 ? "warn" : "ok"}`}>{!provider.enabled ? "Disabled" : missing.length > 0 ? "Key missing" : "Ready"}</span>
    </div>
    <dl className="kv">
      <div className="kv-row"><dt>API keys</dt><dd>{provider.keys.length === 0 ? "None required" : provider.keys.map((key) => `${key.name}${key.env_set ? "" : " (not set)"}${key.enabled ? "" : " (disabled)"}`).join(", ")}</dd></div>
      <div className="kv-row"><dt>Model discovery</dt><dd>{provider.discovery_enabled ? provider.cache.present ? `${String(provider.cache.visible)} models (${String(provider.cache.hidden)} hidden), refreshed ${formatTime(provider.cache.fetched_at)}` : "On, not refreshed yet" : "Off"}</dd></div>
    </dl>
    <div className="actions-row">
      <button type="button" className="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide models" : "Show models"}</button>
      {provider.discovery_enabled && provider.enabled ? <button type="button" className="button ghost" disabled={busy} onClick={() => void run(async () => {
        const result = await workspace.actions.run("refresh_provider_models", { provider: provider.name }); refreshed(); return `Found ${String(result.model_count)} models on ${provider.name}`;
      })}>{busy ? "Refreshing…" : "Refresh models"}</button> : null}
    </div>
    {open ? <ProviderModels state={state} provider={provider.name} /> : null}
  </div>;
}

export function ProvidersPage({ state }: { state: WorkspaceSnapshot }) {
  const providers = useOperation(state, "list_providers", {}, []);
  const { busy, run } = useAction();
  return <>
    <p className="settings-description">Model providers configured on the daemon. Keys are read from environment variables on the daemon’s machine and are never shown here.</p>
    <SettingsSection title="Providers" actions={<button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
      const result = await workspace.actions.run("refresh_all_provider_models", {});
      providers.refresh();
      const failed = result.results.filter((item) => !item.ok);
      return failed.length === 0 ? `Refreshed ${String(result.results.length)} providers` : `Refreshed with errors: ${failed.map((item) => item.provider).join(", ")}`;
    })}>{busy ? "Refreshing…" : "Refresh all"}</button>}>
      <Loading error={providers.error} ready={providers.data !== undefined}>
        <div className="provider-list">{providers.data?.providers.map((provider) => <ProviderCard key={provider.name} state={state} provider={provider} refreshed={providers.refresh} />)}</div>
      </Loading>
    </SettingsSection>
  </>;
}
