import { useEffect, useState } from "react";
import type { OperationResult } from "../operations/types.ts";
import type { ProviderDiscoveredModel } from "../protocol/ProviderDiscoveredModel.ts";
import type { ProviderStatus } from "../protocol/ProviderStatus.ts";
import { Inspect, Modal } from "./components.tsx";
import type { OperationClient } from "./operations.ts";

function ProviderCard({ provider, busy, inspect, refresh }: { provider: ProviderStatus; busy: boolean; inspect: () => void; refresh: () => void }) {
  return <article className="provider-card" aria-label={`${provider.name} provider`}>
    <div className="section-heading"><h3>{provider.name}</h3><span className="muted">{provider.enabled ? "Enabled" : "Disabled"}</span></div>
    <p className="muted">{provider.sdk} · {provider.base_url ?? "No base URL"}</p>
    <ul>{provider.keys.map((key) => <li key={key.name}>{key.name}: {key.enabled ? key.env_set ? "key available" : "key missing" : "key disabled"}{key.warn_on_fallback ? " · warn on fallback" : ""}</li>)}</ul>
    <p>{provider.cache.present ? `${String(provider.cache.visible)} visible · ${String(provider.cache.hidden)} hidden models` : "No cached models"}</p>
    <p className="muted">{provider.cache.fetched_at === null ? "Never refreshed" : `Last refreshed ${provider.cache.fetched_at}`}{provider.discovery_enabled ? "" : " · discovery disabled"}</p>
    <div className="actions"><button disabled={busy} onClick={inspect}>Browse models</button><button disabled={busy || !provider.enabled || !provider.discovery_enabled} onClick={refresh}>Refresh models</button></div>
    <Inspect value={provider} label="Provider details" />
  </article>;
}

function ModelCard({ model }: { model: ProviderDiscoveredModel }) {
  const capabilities = [
    ["Tools", model.supports_tools], ["Images", model.supports_images],
    ["Reasoning", model.supports_reasoning], ["Prompt cache", model.supports_prompt_cache],
  ] as const;
  return <article className="provider-model" aria-label={model.model_id}><h4>{model.display_name ?? model.model_id}</h4>
    <p className="muted">{model.model_id} · {model.sdk}</p>
    <p>{model.context_length === null ? "Context unknown" : `${model.context_length.toLocaleString()} context tokens`} · {model.max_output_tokens === null ? "Output limit unknown" : `${model.max_output_tokens.toLocaleString()} output tokens`}</p>
    <dl className="capabilities">{capabilities.map(([label, supported]) => <div key={label}><dt>{label}</dt><dd>{supported === null ? "Unknown" : supported ? "Supported" : "Unsupported"}</dd></div>)}</dl>
    {model.subscription_included === undefined ? null : <p>{model.subscription_included ? "Included in subscription" : "Outside subscription"}{model.subscription_input_multiplier === undefined ? "" : ` · ${String(model.subscription_input_multiplier)}× input multiplier`}</p>}
    <Inspect value={model} label="Model details" />
  </article>;
}

export function Providers({ actions, ready, close }: { actions: OperationClient; ready: boolean; close: () => void }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [listing, setListing] = useState<OperationResult<"list_provider_models">>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshResult, setRefreshResult] = useState<OperationResult<"refresh_all_provider_models"> | OperationResult<"refresh_provider_models">>();
  const [search, setSearch] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  useEffect(() => {
    let current = true;
    if (ready) {
      setBusy(true);
      void actions.run("list_providers", {}).then((result) => { if (current) { setProviders(result.providers); setError(""); } }, (failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const browse = (provider: string, hidden = includeHidden) => run(async () => {
    setIncludeHidden(hidden);
    try {
      const result = await actions.run("list_provider_models", { provider, include_hidden: hidden });
      setListing(result); setSearch("");
    } catch (failure) { setIncludeHidden(listing?.include_hidden ?? false); throw failure; }
  });
  const refresh = (provider?: string) => run(async () => {
    setRefreshResult(undefined);
    setRefreshResult(provider === undefined ? await actions.run("refresh_all_provider_models", {}) : await actions.run("refresh_provider_models", { provider }));
    setProviders((await actions.run("list_providers", {})).providers);
    if (listing !== undefined) setListing(await actions.run("list_provider_models", { provider: listing.provider, include_hidden: includeHidden }));
  });
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const disabled = busy || !ready;
  return <Modal title="Providers" close={close}>
    <p className="muted">Browse configured providers and their model catalogues. Refresh contacts providers through the daemon and updates its cache.</p>
    <div className="actions"><button disabled={disabled} onClick={() => { void refresh(); }}>Refresh all providers</button>{busy ? <span role="status">Loading providers…</span> : null}</div>
    {!ready ? <p role="status">Reconnect to load current provider data.</p> : null}
    {error === "" ? null : <p role="alert" className="error">{error}</p>}
    {refreshResult === undefined ? null : <section className="provider-result" aria-label="Refresh results"><h3>Refresh results</h3>{"results" in refreshResult ? <>
      {refreshResult.results.map((result) => <p key={result.provider}>{result.provider}: {"error" in result ? `failed — ${result.error}` : `${String(result.model_count)} models refreshed`}</p>)}
      {refreshResult.skipped.map((result) => <p key={result.provider}>{result.provider}: skipped — {result.reason}</p>)}
    </> : <p>{refreshResult.provider}: {String(refreshResult.model_count)} models refreshed</p>}<Inspect value={refreshResult} label="Refresh details" /></section>}
    {providers.length === 0 && !busy ? <p>No providers are configured.</p> : null}
    {providers.map((provider) => <ProviderCard key={provider.name} provider={provider} busy={disabled} inspect={() => { void browse(provider.name); }} refresh={() => { void refresh(provider.name); }} />)}
    {listing === undefined ? null : <section className="provider-catalogue" aria-label={`${listing.provider} models`}><h3>{listing.provider} models</h3>
      <label className="field">Find a model<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={includeHidden} disabled={disabled} onChange={(event) => { void browse(listing.provider, event.target.checked); }} />Include hidden models</label>
      <p className="muted">{String(listing.discovered.length)} discovered · {String(listing.hidden.length)} excluded · {String(listing.static.length)} configured</p>
      {listing.discovered.filter((model) => matches(`${model.model_id} ${model.display_name ?? ""}`)).map((model) => <ModelCard key={model.model_id} model={model} />)}
      {listing.static.filter((model) => matches(`${model.model_id} ${model.name}`)).map((model) => <article key={model.qualified_name} className="provider-model"><h4>{model.name}</h4><p>{model.qualified_name} · configured</p><Inspect value={model} label="Model details" /></article>)}
      <Inspect value={listing} label="Catalogue details, including excluded models" />
    </section>}
  </Modal>;
}
