import { useState, type ReactNode } from "react";
import type { CredentialStatus } from "../../protocol/CredentialStatus.ts";
import type { ProviderPreset } from "../../protocol/ProviderPreset.ts";
import type { ProviderStatus } from "../../protocol/ProviderStatus.ts";
import type { OperationInput } from "../../operations/types.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Dialog, Menu, Spinner, Switch } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatCost, formatNumber, formatTime, Loading, useAction, useOperation } from "./shared.tsx";

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

function FormDialog({ title, close, submit, action, danger = false, disabled = false, children }: {
  title: string; close: () => void; submit: () => Promise<string | undefined>; action: string; danger?: boolean; disabled?: boolean; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title={title} close={close}>
    <form className="form" autoComplete="off" onSubmit={(event) => {
      event.preventDefault();
      setBusy(true); setError("");
      void submit().then((message) => { if (message !== undefined) toasts.show(message); close(); }).catch((failure: unknown) => setError(errorText(failure))).finally(() => setBusy(false));
    }}>
      {children}
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className={`button ${danger ? "danger" : "primary"}`} disabled={busy || disabled}>{busy ? "Working…" : action}</button></div>
    </form>
  </Dialog>;
}

type KeySource = "key" | "env" | "later";

function KeyFields({ source, setSource, secret, setSecret, env, setEnv, noCheck, setNoCheck, later, envHint }: {
  source: KeySource; setSource: (value: KeySource) => void; secret: string; setSecret: (value: string) => void; env: string; setEnv: (value: string) => void;
  noCheck: boolean; setNoCheck: (value: boolean) => void; later: boolean; envHint: string;
}) {
  return <>
    <fieldset className="field radio-group">
      <legend>The key</legend>
      <label className="check"><input type="radio" name="key-source" checked={source === "key"} onChange={() => setSource("key")} />Paste it here; it’s saved on the daemon and never shown again</label>
      <label className="check"><input type="radio" name="key-source" checked={source === "env"} onChange={() => setSource("env")} />Read it from an environment variable on the daemon’s machine</label>
      {later ? <label className="check"><input type="radio" name="key-source" checked={source === "later"} onChange={() => setSource("later")} />Add it later</label> : null}
    </fieldset>
    {source === "key" ? <label className="field"><span>API key</span><input className="input mono" type="password" autoComplete="new-password" spellCheck={false} data-autofocus value={secret} onChange={(event) => setSecret(event.target.value)} /></label> : null}
    {source === "env" ? <label className="field"><span>Environment variable</span><input className="input mono" spellCheck={false} placeholder={envHint} value={env} onChange={(event) => setEnv(event.target.value)} /></label> : null}
    {source === "later" ? null : <label className="check"><input type="checkbox" checked={noCheck} onChange={(event) => setNoCheck(event.target.checked)} />Save it without asking the provider whether it works</label>}
  </>;
}

function keyInput(provider: string, source: KeySource, secret: string, env: string, noCheck: boolean, name?: string): OperationInput<"add_credential"> | undefined {
  if (source === "later") return undefined;
  return {
    provider,
    ...(name === undefined || name.trim() === "" ? {} : { name: name.trim() }),
    ...(source === "key" ? { secret } : { env: env.trim() }),
    ...(noCheck ? { no_check: true } : {}),
  };
}

function AddProviderDialog({ presets, sdks, close, done }: { presets: readonly ProviderPreset[]; sdks: readonly string[]; close: () => void; done: () => void }) {
  const [choice, setChoice] = useState(presets.find((preset) => !preset.configured)?.name ?? "custom");
  const [name, setName] = useState("");
  const [sdk, setSdk] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [noAuth, setNoAuth] = useState(false);
  const [discover, setDiscover] = useState(true);
  const [source, setSource] = useState<KeySource>("key");
  const [secret, setSecret] = useState("");
  const [env, setEnv] = useState("");
  const [noCheck, setNoCheck] = useState(false);
  const preset = presets.find((item) => item.name === choice);
  const custom = preset === undefined;
  const login = preset?.credential_kind === "login";
  const wantsKey = !login && !(custom && noAuth);
  const provider = custom ? name.trim() : choice;
  const ready = provider !== "" && (!custom || baseUrl.trim() !== "" || sdk !== "openai") && (!wantsKey || source === "later" || (source === "key" ? secret.trim() !== "" : env.trim() !== ""));
  return <FormDialog title="Add provider" close={close} action="Add" disabled={!ready} submit={async () => {
    await workspace.actions.run("add_provider", {
      name: provider,
      ...(custom ? { sdk, ...(baseUrl.trim() === "" ? {} : { base_url: baseUrl.trim() }), ...(noAuth ? { no_auth: true } : {}) } : {}),
      ...(discover ? {} : { discover: false }),
    });
    done();
    const key = wantsKey ? keyInput(provider, source, secret, env, noCheck) : undefined;
    if (key === undefined) return `Added ${provider}`;
    try {
      const added = await workspace.actions.run("add_credential", key);
      done();
      return added.message;
    } catch (failure) {
      throw new Error(`Added ${provider}, but its key wasn’t saved: ${errorText(failure)}`);
    }
  }}>
    <label className="field"><span>Provider</span><select className="select" value={choice} onChange={(event) => setChoice(event.target.value)}>
      {presets.map((item) => <option key={item.name} value={item.name} disabled={item.configured}>{item.name}{item.configured ? " (added)" : ""}</option>)}
      <option value="custom">Another provider or a server of your own…</option>
    </select></label>
    {preset === undefined ? <>
      <label className="field"><span>Name</span><input className="input mono" spellCheck={false} placeholder="local" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} /></label>
      <label className="field"><span>SDK</span><select className="select" value={sdk} onChange={(event) => setSdk(event.target.value)}>{sdks.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="field"><span>Base URL</span><input className="input mono" spellCheck={false} placeholder="http://localhost:11434/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={noAuth} onChange={(event) => setNoAuth(event.target.checked)} />It takes no API key</label>
    </> : <p className="form-text">{preset.sdk}{preset.base_url === null ? "" : ` · ${preset.base_url}`}</p>}
    <label className="check"><input type="checkbox" checked={discover} onChange={(event) => setDiscover(event.target.checked)} />Discover its models</label>
    {login ? <p className="form-text">This provider signs in with Claude logins, which live in ~/.claude-accounts on the daemon’s machine.</p> : null}
    {wantsKey ? <KeyFields source={source} setSource={setSource} secret={secret} setSecret={setSecret} env={env} setEnv={setEnv} noCheck={noCheck} setNoCheck={setNoCheck} later envHint={preset?.api_key_env ?? "LLM_API_KEY"} /> : null}
  </FormDialog>;
}

function KeyDialog({ provider, replace, close, done }: { provider: ProviderStatus; replace?: CredentialStatus; close: () => void; done: () => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<KeySource>("key");
  const [secret, setSecret] = useState("");
  const [env, setEnv] = useState("");
  const [noCheck, setNoCheck] = useState(false);
  const ready = source === "key" ? secret.trim() !== "" : env.trim() !== "";
  return <FormDialog title={replace === undefined ? `Add a key to ${provider.name}` : `Replace ${provider.name} key ${replace.name}`} close={close} action={replace === undefined ? "Add key" : "Replace"} disabled={!ready} submit={async () => {
    const result = replace === undefined
      ? await workspace.actions.run("add_credential", keyInput(provider.name, source, secret, env, noCheck, name) ?? { provider: provider.name })
      : await workspace.actions.run("update_credential", { provider: provider.name, credential: replace.name, secret, ...(noCheck ? { no_check: true } : {}) });
    done();
    return result.message;
  }}>
    {replace === undefined ? <label className="field"><span>Name <span className="muted">(optional)</span></span><input className="input mono" spellCheck={false} placeholder={provider.credentials.length === 0 ? "default" : "work"} value={name} onChange={(event) => setName(event.target.value)} /></label> : null}
    {replace === undefined
      ? <KeyFields source={source} setSource={setSource} secret={secret} setSecret={setSecret} env={env} setEnv={setEnv} noCheck={noCheck} setNoCheck={setNoCheck} later={false} envHint="OPENROUTER_WORK_KEY" />
      : <>
        <label className="field"><span>New API key</span><input className="input mono" type="password" autoComplete="new-password" spellCheck={false} data-autofocus value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={noCheck} onChange={(event) => setNoCheck(event.target.checked)} />Save it without asking the provider whether it works</label>
      </>}
  </FormDialog>;
}

function LimitDialog({ provider, credential, close, done }: { provider: string; credential: CredentialStatus; close: () => void; done: () => void }) {
  const [amount, setAmount] = useState(credential.limit === null ? "" : String(credential.limit.cost_usd));
  const [period, setPeriod] = useState<"hour" | "day" | "week" | "month">(credential.limit?.period ?? "month");
  const [clearing, setClearing] = useState(false);
  const cost = Number(amount);
  return <FormDialog title={`Spending limit for ${credential.name}`} close={close} action={clearing ? "Remove limit" : "Save limit"} danger={clearing} disabled={!clearing && !(Number.isFinite(cost) && cost > 0)} submit={async () => {
    const result = await workspace.actions.run("set_credential_limit", clearing ? { provider, credential: credential.name, cost_usd: null } : { provider, credential: credential.name, cost_usd: cost, period });
    done();
    return result.message;
  }}>
    <p className="form-text">At the limit, calls move on to {provider}’s next key, or are refused if it has none.</p>
    <div className="inline-form">
      <label className="field"><span>Up to (USD)</span><input className="input" inputMode="decimal" data-autofocus value={amount} disabled={clearing} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} /></label>
      <label className="field"><span>Each</span><select className="select" value={period} disabled={clearing} onChange={(event) => setPeriod(event.target.value as typeof period)}>
        <option value="hour">hour</option><option value="day">day</option><option value="week">week</option><option value="month">month</option>
      </select></label>
    </div>
    {credential.limit === null ? null : <label className="check"><input type="checkbox" checked={clearing} onChange={(event) => setClearing(event.target.checked)} />Remove the limit instead</label>}
  </FormDialog>;
}

function RenameDialog({ provider, credential, close, done }: { provider: string; credential: CredentialStatus; close: () => void; done: () => void }) {
  const [name, setName] = useState(credential.name);
  return <FormDialog title={`Rename ${credential.name}`} close={close} action="Rename" disabled={name.trim() === "" || name.trim() === credential.name} submit={async () => {
    const result = await workspace.actions.run("update_credential", { provider, credential: credential.name, rename: name.trim() });
    done();
    return result.message;
  }}>
    <label className="field"><span>New name</span><input className="input mono" spellCheck={false} data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    <p className="form-text">Usage recorded so far stays under the old name.</p>
  </FormDialog>;
}

function ConfirmDialog({ title, text, action, close, run }: { title: string; text: string; action: string; close: () => void; run: () => Promise<string | undefined> }) {
  return <FormDialog title={title} close={close} action={action} danger submit={run}><p className="form-text">{text}</p></FormDialog>;
}

const STANDING: Record<CredentialStatus["standing"], { label: string; tone: string }> = {
  works: { label: "Works", tone: "ok" },
  invalid: { label: "Rejected", tone: "warn" },
  over_quota: { label: "Over quota", tone: "warn" },
  signed_out: { label: "Signed out", tone: "warn" },
  missing: { label: "Missing", tone: "warn" },
  not_checked: { label: "Not checked yet", tone: "off" },
};

function credentialSource(credential: CredentialStatus): string {
  if (credential.kind === "api_key") return `Saved on the daemon ${credential.hint ?? ""}`.trim();
  if (credential.kind === "env") return `$${credential.env ?? ""}${credential.hint === null ? "" : ` ${credential.hint}`}`;
  if (credential.kind === "login") return credential.hint === null ? "Claude login" : `Claude login · ${credential.hint}`;
  return "No key needed";
}

type CredentialDialog = { kind: "add" } | { kind: "replace" | "limit" | "rename" | "remove"; credential: CredentialStatus } | { kind: "remove-provider" };

function CredentialRow({ provider, credential, index, count, open, refreshed }: {
  provider: ProviderStatus; credential: CredentialStatus; index: number; count: number; open: (dialog: CredentialDialog) => void; refreshed: () => void;
}) {
  const { busy, run } = useAction();
  const standing = STANDING[credential.standing];
  const keys = provider.credentials.filter((item) => item.kind === "api_key" || item.kind === "env").map((item) => item.name);
  const act = (work: () => Promise<{ message: string }>) => void run(async () => { const result = await work(); refreshed(); return result.message; });
  const move = (step: number) => {
    const order = [...keys];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(index + step, 0, moved);
    act(() => workspace.actions.run("order_credentials", { provider: provider.name, order }));
  };
  const editable = credential.kind === "api_key" || credential.kind === "env";
  return <li className={`credential ${credential.enabled ? "" : "disabled"}`}>
    <div className="credential-main">
      <div className="credential-title">
        <span className="mono">{credential.name}</span>
        {credential.in_use ? <span className="tag">In use</span> : null}
        {credential.pinned ? <span className="tag">Pinned</span> : null}
        {credential.enabled ? null : <span className="tag muted-tag">Disabled</span>}
      </div>
      <span className="setting-description">{credentialSource(credential)}</span>
      {credential.detail === null || (credential.standing === "works" && credential.kind !== "login") ? null : <span className="setting-description">{credential.detail}</span>}
      <span className="setting-description">
        {[
          credential.usage === null ? "" : `${formatCost(credential.usage.cost_usd)} in the last 30 days, ${formatNumber(credential.usage.calls)} calls`,
          credential.limit === null ? "" : `Limit ${formatCost(credential.limit.cost_usd)} a ${credential.limit.period}: ${formatCost(credential.limit.spent_usd)} spent${credential.limit.at_limit ? ", at the limit" : ""}`,
          credential.checked_at === null ? "" : `Checked ${formatTime(credential.checked_at)}`,
        ].filter(Boolean).join(" · ")}
      </span>
      {credential.login_command === undefined ? null : <span className="setting-description">Sign in on the daemon’s machine: <code>{credential.login_command}</code></span>}
    </div>
    <span className={`status-pill ${standing.tone}`}>{standing.label}</span>
    {editable ? <div className="actions-row">
      <button type="button" className="button ghost" disabled={busy} onClick={() => act(() => workspace.actions.run("test_credential", { provider: provider.name, credential: credential.name }).then((result) => ({ message: `${credential.name}: ${result.detail}` })))}>{busy ? "Working…" : "Test"}</button>
      <Menu label={`Actions for ${credential.name}`} items={[
        credential.pinned
          ? { label: "Pick keys automatically", detail: "First that works, in order", onSelect: () => act(() => workspace.actions.run("select_credential", { provider: provider.name, credential: null })) }
          : { label: "Use only this key", disabled: !credential.enabled, onSelect: () => act(() => workspace.actions.run("select_credential", { provider: provider.name, credential: credential.name })) },
        { label: "Move up", disabled: index === 0, onSelect: () => move(-1) },
        { label: "Move down", disabled: index >= count - 1, onSelect: () => move(1) },
        "separator",
        credential.enabled
          ? { label: "Disable", onSelect: () => act(() => workspace.actions.run("update_credential", { provider: provider.name, credential: credential.name, enabled: false })) }
          : { label: "Enable", onSelect: () => act(() => workspace.actions.run("update_credential", { provider: provider.name, credential: credential.name, enabled: true })) },
        { label: credential.limit === null ? "Set a spending limit…" : "Change spending limit…", onSelect: () => open({ kind: "limit", credential }) },
        { label: "Rename…", onSelect: () => open({ kind: "rename", credential }) },
        ...(credential.kind === "api_key" ? [{ label: "Replace key…", onSelect: () => open({ kind: "replace", credential }) }] : []),
        "separator",
        { label: "Remove…", danger: true, onSelect: () => open({ kind: "remove", credential }) },
      ]} />
    </div> : null}
  </li>;
}

function TransportForm({ provider, sdks, close, done }: { provider: ProviderStatus; sdks: readonly string[]; close: () => void; done: () => void }) {
  const [sdk, setSdk] = useState(provider.sdk);
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [discover, setDiscover] = useState(provider.discovery_enabled);
  const [ignore, setIgnore] = useState(provider.ignore_models.join("\n"));
  const [subscription, setSubscription] = useState(provider.subscription);
  const patterns = ignore.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return <FormDialog title={`${provider.name} settings`} close={close} action="Save" submit={async () => {
    const changes: OperationInput<"update_provider"> = { provider: provider.name };
    if (sdk !== provider.sdk) changes.sdk = sdk;
    if (baseUrl.trim() !== (provider.base_url ?? "")) changes.base_url = baseUrl.trim() === "" ? null : baseUrl.trim();
    if (discover !== provider.discovery_enabled) changes.discover = discover;
    if (patterns.join("\n") !== provider.ignore_models.join("\n")) changes.ignore_models = patterns;
    if (subscription !== provider.subscription) changes.subscription = subscription;
    if (Object.keys(changes).length === 1) return undefined;
    const result = await workspace.actions.run("update_provider", changes);
    done();
    return result.message;
  }}>
    <label className="field"><span>SDK</span><select className="select" value={sdk} onChange={(event) => setSdk(event.target.value)}>{sdks.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="field"><span>Base URL <span className="muted">(empty for the default)</span></span><input className="input mono" spellCheck={false} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
    <div className="field-row"><span className="field-label">Discover models</span><div className="field-input"><Switch checked={discover} change={setDiscover} label="Discover models" /></div></div>
    <label className="field"><span>Ignored models <span className="muted">(one pattern a line; * matches anything, a leading ! shows a model again)</span></span><textarea className="input textarea mono" rows={3} value={ignore} onChange={(event) => setIgnore(event.target.value)} /></label>
    <div className="field-row"><span className="field-label">Billed as a subscription</span><div className="field-input"><Switch checked={subscription} change={setSubscription} label="Billed as a subscription" /></div></div>
  </FormDialog>;
}

function ProviderCard({ state, provider, sdks, refreshed }: { state: WorkspaceSnapshot; provider: ProviderStatus; sdks: readonly string[]; refreshed: () => void }) {
  const [models, setModels] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<CredentialDialog>();
  const { busy, run } = useAction();
  const usable = provider.no_auth || provider.credentials.some((credential) => credential.enabled && credential.standing !== "missing" && credential.standing !== "invalid" && credential.standing !== "signed_out");
  const logins = provider.credentials.some((credential) => credential.kind === "login");
  const close = () => setDialog(undefined);
  const keyCount = provider.credentials.filter((credential) => credential.kind === "api_key" || credential.kind === "env").length;
  return <div className={`provider ${provider.enabled ? "" : "disabled"}`}>
    <div className="provider-head">
      <div className="provider-title">
        <span className="setting-label">{provider.name}</span>
        <span className="setting-description">{provider.sdk}{provider.base_url === null ? "" : ` · ${provider.base_url}`}</span>
      </div>
      <div className="actions-row">
        <span className={`status-pill ${!provider.enabled ? "off" : usable ? "ok" : "warn"}`}>{!provider.enabled ? "Disabled" : usable ? "Ready" : logins ? "Not signed in" : "No working key"}</span>
        <Menu label={`Actions for ${provider.name}`} items={[
          { label: "Settings…", onSelect: () => setEditing(true) },
          provider.enabled
            ? { label: "Disable", onSelect: () => void run(async () => { const result = await workspace.actions.run("update_provider", { provider: provider.name, enabled: false }); refreshed(); return result.message; }) }
            : { label: "Enable", onSelect: () => void run(async () => { const result = await workspace.actions.run("update_provider", { provider: provider.name, enabled: true }); refreshed(); return result.message; }) },
          "separator",
          { label: "Remove…", danger: true, onSelect: () => setDialog({ kind: "remove-provider" }) },
        ]} />
      </div>
    </div>
    <dl className="kv">
      <div className="kv-row"><dt>Uses</dt><dd>{provider.no_auth ? "No key" : provider.pinned !== null ? `Only ${provider.pinned}` : provider.selection === "room" ? "The login with the most room left" : "The first key that works, in this order"}</dd></div>
      <div className="kv-row"><dt>Model discovery</dt><dd>{provider.discovery_enabled ? provider.cache.present ? `${String(provider.cache.visible)} models (${String(provider.cache.hidden)} hidden), refreshed ${formatTime(provider.cache.fetched_at)}` : "On, not refreshed yet" : "Off"}</dd></div>
      {provider.ignore_models.length === 0 ? null : <div className="kv-row"><dt>Ignored models</dt><dd className="mono">{provider.ignore_models.join(", ")}</dd></div>}
    </dl>
    {provider.no_auth ? null : <ul className="credential-list" aria-label={`${provider.name} ${logins ? "logins" : "keys"}`}>
      {provider.credentials.map((credential, index) => <CredentialRow key={credential.name} provider={provider} credential={credential} index={index} count={keyCount} open={setDialog} refreshed={refreshed} />)}
    </ul>}
    <div className="actions-row">
      {logins || provider.no_auth ? null : <button type="button" className="button" onClick={() => setDialog({ kind: "add" })}>Add key</button>}
      <button type="button" className="button ghost" aria-expanded={models} onClick={() => setModels(!models)}>{models ? "Hide models" : "Show models"}</button>
      {provider.discovery_enabled && provider.enabled ? <button type="button" className="button ghost" disabled={busy} onClick={() => void run(async () => {
        const result = await workspace.actions.run("refresh_provider_models", { provider: provider.name }); refreshed(); return `Found ${String(result.model_count)} models on ${provider.name}`;
      })}>{busy ? "Refreshing…" : "Refresh models"}</button> : null}
    </div>
    {models ? <ProviderModels state={state} provider={provider.name} /> : null}
    {editing ? <TransportForm provider={provider} sdks={sdks} close={() => setEditing(false)} done={refreshed} /> : null}
    {dialog?.kind === "add" ? <KeyDialog provider={provider} close={close} done={refreshed} /> : null}
    {dialog?.kind === "replace" ? <KeyDialog provider={provider} replace={dialog.credential} close={close} done={refreshed} /> : null}
    {dialog?.kind === "limit" ? <LimitDialog provider={provider.name} credential={dialog.credential} close={close} done={refreshed} /> : null}
    {dialog?.kind === "rename" ? <RenameDialog provider={provider.name} credential={dialog.credential} close={close} done={refreshed} /> : null}
    {dialog?.kind === "remove" ? <ConfirmDialog title={`Remove ${dialog.credential.name}?`} action="Remove key" close={close}
      text={dialog.credential.kind === "api_key" ? `${provider.name} stops using this key and the daemon deletes its saved copy.` : `${provider.name} stops reading $${dialog.credential.env ?? ""}; the variable itself stays set.`}
      run={async () => { const result = await workspace.actions.run("remove_credential", { provider: provider.name, credential: dialog.credential.name }); refreshed(); return result.message; }} /> : null}
    {dialog?.kind === "remove-provider" ? <ConfirmDialog title={`Remove ${provider.name}?`} action="Remove provider" close={close}
      text={`This takes ${provider.name} out of the configuration with its keys and their limits. Shore refuses if a character, thread or background task still uses one of its models.`}
      run={async () => { const result = await workspace.actions.run("remove_provider", { provider: provider.name }); refreshed(); return `Removed ${result.provider}`; }} /> : null}
  </div>;
}

export function ProvidersPage({ state }: { state: WorkspaceSnapshot }) {
  const providers = useOperation(state, "list_providers", {}, []);
  const presets = useOperation(state, "provider_presets", {}, [providers.data]);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction();
  const sdks = presets.data?.sdks ?? [];
  return <>
    <p className="settings-description">Model providers on the daemon and the keys they use. A key added here is saved on the daemon in a file only it can read, and is never shown again; a key can also come from an environment variable on the daemon’s machine.</p>
    <SettingsSection title="Providers" actions={<div className="actions-row">
      <button type="button" className="button primary" disabled={presets.data === undefined} onClick={() => setAdding(true)}>Add provider</button>
      <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
        const result = await workspace.actions.run("refresh_all_provider_models", {});
        providers.refresh();
        const failed = result.results.filter((item) => !item.ok);
        return failed.length === 0 ? `Refreshed ${String(result.results.length)} providers` : `Refreshed with errors: ${failed.map((item) => item.provider).join(", ")}`;
      })}>{busy ? "Refreshing…" : "Refresh all"}</button>
    </div>}>
      <Loading error={providers.error} ready={providers.data !== undefined}>
        {providers.data?.providers.length === 0 ? <p className="settings-empty">No providers yet. Add one to start choosing its models.</p> : null}
        <div className="provider-list">{providers.data?.providers.map((provider) => <ProviderCard key={provider.name} state={state} provider={provider} sdks={sdks} refreshed={providers.refresh} />)}</div>
      </Loading>
    </SettingsSection>
    {adding && presets.data !== undefined ? <AddProviderDialog presets={presets.data.presets} sdks={sdks} close={() => setAdding(false)} done={providers.refresh} /> : null}
  </>;
}
