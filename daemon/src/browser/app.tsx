import { AppearanceProvider, useAppearance } from "./appearance.tsx";
import { WorkspaceSettings } from "./workspace_settings.tsx";
import { Icon } from "./icons.tsx";
import { OperationImages } from "./operation_images.tsx";
import { copyText } from "./clipboard.ts";
import { LocalHelp } from "./local_help.tsx";
import { TERMINAL_SHORTCUTS } from "./preferences.generated.ts";
import { ActionOutput } from "./action_output.tsx";
import { Gallery } from "./gallery.tsx";
import { conversationImages, type OpenImage } from "./media.ts";
import { KeyboardControls, useBindings } from "./keyboard_controls.tsx";
import { bindingId, keyFromEvent, scrollAmount, matchingBinding, validateBinding, validateSavedConfig, type Binding, type LocalShortcut } from "./keyboard.ts";
import type { ViewKey } from "./preferences.ts";
import type { StreamMetadata } from "../protocol/StreamMetadata.ts";
import { metadataLabel } from "./metadata.ts";
import { ActivityPanel, LiveResponse } from "./activity.tsx";
import { DisplayControls } from "./display.tsx";
import { DisplayProvider, useDisplay } from "./display_state.tsx";
import { BudgetReadout, useBudgets } from "./budget_readout.tsx";
import { RequestFields } from "./request_fields.tsx";
import { conversationRequest } from "./request_forms.ts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Composer, type ComposerHandle } from "./composer.tsx";
import type { Message } from "../protocol/Message.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import { Providers } from "./providers.tsx";
import { Diagnostics } from "./diagnostics.tsx";
import { Memory } from "./memory.tsx";
import { ToolWorkbench } from "./tool_workbench.tsx";
import { Usage } from "./usage.tsx";
import { Archives } from "./archives.tsx";
import { RequestRecovery } from "./requests.tsx";
import { toolNames } from "./tool_forms.ts";
import { Models } from "./models.tsx";
import { Settings } from "./settings.tsx";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";
import { BrowserConnection } from "./connection.ts";
import { Blocks, CancelWork, Field, ImageView, Inspect, Menu, Modal } from "./components.tsx";
import { operationPolicy } from "../operations/policy.ts";
import { actionControl, initialValue, record } from "./forms.ts";
import { Workspace, type WorkspaceSnapshot } from "./workspace.ts";

declare const SHORE_WEB_CONTRACT: string;
declare const SHORE_WEB_PROTOCOL: number;

const route = location.pathname.startsWith("/workspace/") ? location.pathname.slice(11).split("/").map(decodeURIComponent) : [];
const workspace = new Workspace(new BrowserConnection({ origin: location.origin, contract: SHORE_WEB_CONTRACT, protocol: SHORE_WEB_PROTOCOL, character: route[0] ?? null, thread: route[1] ?? null }));
const perform = (work: () => Promise<unknown>) => { void work().catch((error: unknown) => workspace.report(error)); };

function Action({ operation, state, close, preset = {}, review = false }: { review?: boolean; operation: OperationDescriptor; state: WorkspaceSnapshot; close: () => void; preset?: Record<string, unknown> }) {
  const control = actionControl(operation);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...record(initialValue(control)), ...preset }));
  const policy = operationPolicy(operation, values);
  const [confirming, setConfirming] = useState(review);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [subagentNames, setSubagentNames] = useState<string[]>([]);
  const [modelSettingKeys, setModelSettingKeys] = useState<string[]>([]);
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [configSchema, setConfigSchema] = useState<ConfigSchemaEntry[]>([]);
  useEffect(() => {
    let current = true;
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "tools")) {
      void workspace.actions.run("tools", {}, { remember: false }).then((access) => { if (current) setAvailableTools(toolNames(access)); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "providers")) {
      void workspace.actions.run("list_providers", {}, { remember: false }).then((catalogue) => { if (current) setProviderNames(catalogue.providers.map((provider) => provider.name)); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "config_keys")) {
      void workspace.actions.run("config_schema", {}, { remember: false }).then((catalogue) => { if (current) setConfigSchema(catalogue.schema); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "models")) {
      void workspace.actions.run("list_models", { include_hidden: true }, { remember: false }).then((catalogue) => { if (current) setModelNames(Object.values(catalogue.models).flatMap((models) => models.map((model) => model.qualified_name))); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "subagents")) {
      void workspace.actions.run("tools", {}, { remember: false }).then((access) => { if (current) setSubagentNames(["all", ...access.subagents.map((subagent) => subagent.name)]); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "model_settings")) {
      void workspace.actions.run("model_settings", {}, { remember: false }).then((settings) => { if (current && "setting_schema" in settings) setModelSettingKeys(settings.setting_schema.map((entry) => entry.key)); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    return () => { current = false; };
  }, [operation, state.status]);
  const choices = { tools: availableTools, models: modelNames, subagents: subagentNames, model_settings: modelSettingKeys, config_keys: configSchema.map((entry) => entry.key), providers: providerNames, characters: state.characters.map((character) => character.name), threads: state.threads.map((thread) => thread.id) };
  const execute = async () => {
    setBusy(true); setError("");
    try { setResult(await workspace.actions.runDiscovered(operation.name, values)); await workspace.refreshNavigation(); setConfirming(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setConfirming(false); }
    finally { setBusy(false); }
  };
  return <Modal title={operation.label} close={close}><p className="muted">{operation.category} · {operation.scope.replaceAll("_", " ")}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (policy.confirmation !== "none" && !confirming) setConfirming(true); else void execute(); }}>
      <fieldset disabled={busy || confirming || state.status !== "ready"} className="action-fields">
        {Object.entries(control.fields).map(([key, field]) => {
          const presentation = operation.fields[key];
          const label = presentation?.label ?? key;
          const included = Object.hasOwn(values, key);
          return <section className="action-field" key={key}>
            {control.required.includes(key) ? null : <label className="check"><input type="checkbox" checked={included} onChange={(event) => setValues((previous) => {
              const next = { ...previous }; if (event.target.checked) next[key] = initialValue(field); else delete next[key]; return next;
            })} />Set {label.toLowerCase()}</label>}
            {included ? <Field label={label} control={field} value={values[key]} change={(value) => setValues({ ...values, [key]: value })} {...(presentation === undefined ? {} : { presentation })} choices={choices} secret={operation.name === "config" && key === "value" && configSchema.some((entry) => entry.key === values["key"] && entry.secret)} /> : <p className="muted">{label}: daemon default</p>}
            {presentation?.hint === undefined ? null : <small>{presentation.hint}</small>}
          </section>;
        })}
      </fieldset>
      {error === "" ? null : <p role="alert" className="error">{error}</p>}
      {operation.available === false ? <p>This action is unavailable in the selected conversation.</p> : null}
      {confirming ? <div className="confirmation"><strong>Confirm {policy.confirmation}</strong><p>Review the selected values before continuing.</p><pre>{JSON.stringify(values, null, 2)}</pre><button type="button" onClick={() => setConfirming(false)}>Go back</button></div> : null}
      <div className="actions"><button className={confirming ? "danger" : "primary"} disabled={busy || operation.available === false || state.status !== "ready"} type="submit">{busy ? "Working…" : confirming ? `Confirm ${policy.confirmation}` : "Run action"}</button></div>
    </form>
    <CancelWork active={busy} ready={state.status === "ready"} cancel={() => workspace.connection.cancel()} />
    {result === undefined ? null : <div className="result"><h3>Action completed</h3><OperationImages name={operation.name} result={result} /><Inspect value={result} label="Complete action result" /></div>}
  </Modal>;
}

function MessageCard({ message, character, metadata, reasoning, tools, openImage, action }: { message: Message; character: string | null; metadata: StreamMetadata | undefined; reasoning: boolean; tools: boolean; openImage: OpenImage; action: (name: string, preset?: Record<string, unknown>) => void }) {
  const display = useDisplay();
  return <article className={`message ${message.role}`} aria-label={`${message.role} message`}>
    <div className="message-heading"><strong><span className="message-avatar" aria-hidden="true">{(message.role === "assistant" ? character ?? "S" : message.role === "user" ? "Y" : "S").slice(0, 1).toUpperCase()}</span>{message.role === "assistant" ? character ?? "Shore" : message.role === "user" ? "You" : "System"}</strong>{display.option("timestamps") === "on" ? <time dateTime={message.timestamp} title={message.timestamp ? new Date(message.timestamp).toLocaleString() : ""}>{message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</time> : null}</div>
    {message.content_blocks.length === 0 ? <div className="message-text">{message.content}</div> : <Blocks blocks={message.content_blocks} reasoning={reasoning} tools={tools} openImage={openImage} />}
    {message.images.map((image, index) => <ImageView key={index} data={image.data ?? null} caption={image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Attached image"} open={openImage} />)}
    {display.option("metadata") === "on" ? <p className="message-metadata" aria-label="Message metadata">{[metadata === undefined ? message.provider_key : "", metadata === undefined ? message.model : metadataLabel(metadata), message.alt_count === undefined || message.alt_count === null ? "" : `Response ${String((message.alt_index ?? 0) + 1)} of ${String(message.alt_count)}`].filter(Boolean).join(" · ") || `Message ${message.msg_id}`}</p> : null}
    <div className="message-actions"><button onClick={() => perform(() => copyText(message.content))}>Copy</button><button onClick={() => action("edit", { ref: message.msg_id, content: message.content })}>Edit</button><button onClick={() => action("delete", { refs: message.msg_id })}>Delete</button>{message.role === "assistant" ? <><button onClick={() => action("list_alternatives", { ref: message.msg_id })}>Alternatives</button><button onClick={() => action("alt", { ref: message.msg_id })}>Choose response</button></> : null}<Inspect label="Message details" value={message} /></div>
  </article>;
}

function App() {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [token, setToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [quickOnly, setQuickOnly] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const quickNames = new Set<string>(TERMINAL_SHORTCUTS.map(([name]) => name));
  const [outputOpen, setOutputOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedAction, setSelectedAction] = useState<{ name: string; preset: Record<string, unknown>; review?: boolean }>();
  const [image, setImage] = useState<{ source: string; caption: string } | null>();
  const imageOpen = image !== undefined;
  const galleryImages = useMemo(() => imageOpen ? conversationImages(state.messages, state.streams, state.media) : [], [imageOpen, state.messages, state.streams, state.media]);
  const openImage: OpenImage = (source, caption = "Conversation image") => setImage({ source, caption });
  const privateView = state.status !== "signed_out" && state.status !== "stopped";
  useEffect(() => { setImage(undefined); }, [state.character, state.thread, privateView]);
  const [activity, setActivity] = useState(false);
  const [providers, setProviders] = useState(false);
  const [settings, setSettings] = useState(false);
  const [workspaceSettings, setWorkspaceSettings] = useState(false);
  const [requestHistory, setRequestHistory] = useState(false);
  const appearance = useAppearance();
  const [models, setModels] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [memory, setMemory] = useState(false);
  const [toolWorkbench, setToolWorkbench] = useState(false);
  const [usage, setUsage] = useState(false);
  const [archives, setArchives] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const display = useDisplay();
  const [displayOpen, setDisplayOpen] = useState(false);
  const bindings = useBindings();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [shortcutResult, setShortcutResult] = useState<{ label: string; data: unknown }>();
  const [template, setTemplate] = useState<{ request: OperationDescriptor; values: Record<string, unknown> }>();
  const composer = useRef<ComposerHandle>(null);
  const runningKeys = useRef(new Set<string>());
  const privateEpoch = useRef(0);

  const reasoning = display.option("thinking") === "on";
  const tools = display.option("tools") === "on";
  const budgets = useBudgets(workspace, state, displayOpen || display.option("usage") !== "off");
  const [guidance, setGuidance] = useState<Record<string, unknown>>();
  const tail = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (privateView) return;
    privateEpoch.current += 1;
    setSelectedAction(undefined); setShortcutResult(undefined); setTemplate(undefined); setGuidance(undefined); setImage(undefined);
    setPalette(false); setHelpOpen(false); setOutputOpen(false); setActivity(false); setProviders(false); setSettings(false); setModels(false);
    setDiagnostics(false); setMemory(false); setToolWorkbench(false); setUsage(false); setArchives(false); setNavigation(false); setDisplayOpen(false); setKeyboardOpen(false);
    setSearch(""); setFollow(true); setWorkspaceSettings(false); setRequestHistory(false);
  }, [privateView]);
  const action = (name: string, preset: Record<string, unknown> = {}) => { setPalette(false); setSelectedAction({ name, preset }); };
  const regenRequest = state.requests.find((item) => item.name === "regen");
  function openRequest(name: string) {
    setPalette(false);
    switch (name) {
      case "message": requestAnimationFrame(() => document.getElementById("message-composer")?.focus()); break;
      case "regen": setGuidance({ stream: true, guidance: "" }); break;
      case "cancel":
        try { workspace.connection.cancel(); } catch (error) { workspace.report(error); }
        break;
      default: workspace.report(`Unsupported conversation action: ${name}`);
    }
  }
  const operation = state.operations.find((item) => item.name === selectedAction?.name);
  const select = async (name: string, thread = false) => {
    if (thread) await workspace.actions.run("switch_thread", { name, resync: true });
    else await workspace.actions.run("switch_character", { name });
    setNavigation(false);
  };
  useEffect(() => { workspace.connection.connect(); return () => { workspace.connection.stop(); }; }, []);
  useEffect(() => { if (follow) tail.current?.scrollIntoView({ block: "end" }); }, [state.messages, state.streams, follow]);
  useEffect(() => { if (state.character !== null) history.replaceState(null, "", `/workspace/${encodeURIComponent(state.character)}/${encodeURIComponent(state.thread ?? "main")}`); }, [state.character, state.thread]);
  const scrollTranscript = (direction: "up" | "down" | "top" | "bottom", amount = 1) => {
    const node = transcript.current; if (node === null) return;
    setFollow(direction === "bottom");
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 24;
    if (direction === "top") { node.scrollTo({ top: 0 }); if (ready && state.character !== null && state.hasEarlier) perform(() => workspace.loadEarlier()); }
    else if (direction === "bottom") node.scrollTo({ top: node.scrollHeight });
    else node.scrollBy({ top: (direction === "up" ? -1 : 1) * amount * line });
  };
  const localShortcuts: Record<LocalShortcut, (args: Record<string, unknown>) => void | Promise<void>> = {
    help: () => setHelpOpen(true), quick: () => { setQuickOnly(true); setSearch(""); setPalette(true); }, transcript: () => transcript.current?.focus(), focus_home: () => composer.current?.focus("home"), focus_end: () => composer.current?.focus("end"),
    sign_out: () => workspace.connection.signOut(), attach: () => composer.current?.attach(), clear_images: () => composer.current?.clearImages(),
    edit_cancel: () => { if (selectedAction?.name === "edit") setSelectedAction(undefined); }, output: () => setOutputOpen(true), images: () => setImage(null), palette: () => { setQuickOnly(false); setPalette(true); }, keyboard: () => setKeyboardOpen(true), display: () => setDisplayOpen(true), activity: () => setActivity((open) => !open),
    settings: () => setSettings(true), models: () => setModels(true), providers: () => setProviders(true), diagnostics: () => setDiagnostics(true),
    memory: () => setMemory(true), tools: () => setToolWorkbench(true), usage: () => setUsage(true), archives: () => setArchives(true),
    editor: () => composer.current?.expand(), undo: () => composer.current?.undo(), redo: () => composer.current?.redo(), focus: () => composer.current?.focus(), send: () => composer.current?.send(), follow: () => setFollow((value) => !value),
    top: () => scrollTranscript("top"), bottom: () => scrollTranscript("bottom"),
    up: (args) => scrollTranscript("up", scrollAmount(args)), down: (args) => scrollTranscript("down", scrollAmount(args)),
  };
  async function runConversation(name: string, values: Record<string, unknown>) {
    if (name === "cancel") { workspace.connection.cancel(); return; }
    if (name !== "message" && name !== "regen") throw new Error("Unsupported conversation action");
    const completion = await workspace.connection.submit(conversationRequest(name, values)).finished;
    if (completion.outcome !== "completed") throw new Error(completion.error?.message ?? `Conversation action ${completion.outcome}`);
  }
  async function runBinding(binding: Binding) {
    const epoch = privateEpoch.current;
    const active = () => epoch === privateEpoch.current && !["signed_out", "stopped"].includes(workspace.connection.status);
    const current = workspace.getSnapshot();
    validateBinding(binding, current.operations, current.requests);
    const [kind, name = ""] = binding.target.split(":");
    switch (kind) {
      case "local":
        if (["diagnostics", "memory", "tools"].includes(name) && current.character === null) throw new Error("Select a character first");
        await localShortcuts[name as LocalShortcut](binding.args); return;
      case "view": display.change(name as ViewKey, String(binding.args["value"]), budgets.budgets.map((budget) => budget.name)); return;
      case "operation": {
        const selected = current.operations.find((item) => item.name === name);
        if (current.status !== "ready" || (selected === undefined || selected.available === false)) throw new Error("This operation is unavailable for the current connection or conversation");
        if (name === "config" && Object.hasOwn(binding.args, "value")) validateSavedConfig(binding, (await workspace.actions.run("config_schema", {}, { remember: false })).schema);
        if (!active()) return;
        if (binding.mode === "open" || operationPolicy(selected, binding.args).confirmation !== "none") {
          setSelectedAction({ name, preset: binding.args, review: binding.mode === "run" }); return;
        }
        const result = await workspace.actions.runDiscovered(name, binding.args);
        if (active()) { setShortcutResult({ label: selected.label, data: result }); await workspace.refreshNavigation(); } return;
      }
      case "request": {
        const request = current.requests.find((item) => item.name === name);
        if (current.status !== "ready" || (request === undefined || request.available === false)) throw new Error("This conversation action is unavailable");
        if (binding.mode === "open" && name !== "cancel") { setTemplate({ request, values: binding.args }); return; }
        await runConversation(name, binding.args); return;
      }
      default: throw new Error("Unsupported shortcut target");
    }
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.getModifierState("AltGraph") || state.status === "signed_out" || state.status === "stopped") return;
      const key = keyFromEvent(event); if (key === undefined) return;
      const editing = event.target instanceof Element && event.target.closest('input,textarea,select,button,a,summary,[role="button"],[role="textbox"],[contenteditable]:not([contenteditable="false"])') !== null;
      const binding = matchingBinding(bindings.getSnapshot().bindings, key, editing, document.querySelector("dialog[open]") !== null);
      if (binding === undefined) return;
      event.preventDefault(); const id = bindingId(binding);
      if (runningKeys.current.has(id)) return;
      runningKeys.current.add(id);
      void runBinding(binding).catch((error: unknown) => workspace.report(error)).finally(() => runningKeys.current.delete(id));
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [bindings, state.status, runBinding]);
  const ready = state.status === "ready";
  const warnings = state.activity.filter((item) => item.type.endsWith("warning")).slice(-3);
  if (state.status === "signed_out" || state.status === "stopped") return <main className="signin"><div className="brand">shore<span>Characters &amp; conversations</span></div><h1>Step into<br />the conversation.</h1><p>Connect with your Shore daemon’s access token.</p><form onSubmit={(event) => { event.preventDefault(); setSigningIn(true); perform(async () => { try { await workspace.connection.signIn(token); setToken(""); } finally { setSigningIn(false); } }); }}><label className="field">Daemon token<input autoFocus type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} /></label><button className="primary" disabled={signingIn || token === ""}>{signingIn ? "Connecting…" : "Open workspace"}</button></form><p role="alert">{state.error || state.detail}</p></main>;
  return <div className={`workspace ${activity ? "with-activity" : ""} ${navigation ? "with-navigation" : ""}`}>
    {navigation ? <button className="navigation-backdrop" aria-label="Close navigation" onClick={() => setNavigation(false)} /> : null}
    <aside className="sidebar"><div className="sidebar-brand"><div className="brand">shore<span>Characters &amp; conversations</span></div><button className="icon-button mobile-navigation" aria-label="Close navigation" onClick={() => setNavigation(false)}><Icon name="close" /></button></div>
      <div className="sidebar-content"><div className="section-heading"><h2>Characters</h2><button className="icon-button" title="New character" aria-label="New character" disabled={!ready} onClick={() => action("create_character")}><Icon name="plus" /></button></div>
      <nav aria-label="Characters">{state.characters.map((character) => <button key={character.name} aria-current={state.character === character.name ? "page" : undefined} disabled={!ready} onClick={() => perform(() => select(character.name))}><span className="avatar">{character.name.slice(0, 1).toUpperCase()}</span><span className="nav-name">{character.name}</span></button>)}</nav>
      {state.characters.length === 0 ? <p className="sidebar-hint">Your cast of characters will appear here.</p> : null}
      <div className="section-heading thread-heading"><h2>Conversations</h2><button className="icon-button" title="New conversation" aria-label="New conversation" disabled={!ready || state.character === null} onClick={() => action("create_thread")}><Icon name="plus" /></button></div><nav aria-label="Threads">{state.threads.map((thread) => <button key={thread.id} aria-current={state.thread === thread.id ? "page" : undefined} disabled={!ready} onClick={() => perform(() => select(thread.id, true))}><Icon name="chat" /><span className="nav-name">{thread.label ?? thread.id}</span><small>{thread.home ? "Home" : thread.turns === undefined ? "" : `${String(thread.turns)} turns`}</small></button>)}</nav></div>
      <div className="sidebar-footer"><button className="sidebar-action" disabled={!ready} onClick={() => { setQuickOnly(false); setSearch(""); setPalette(true); setNavigation(false); }}><Icon name="search" />All actions</button><div className="sidebar-bottom"><button className="sidebar-action" aria-label="Workspace settings" onClick={() => { setWorkspaceSettings(true); setNavigation(false); }}><Icon name="settings" />Settings</button><button className="icon-button" title="Appearance" aria-label="Display preferences" onClick={() => { setDisplayOpen(true); setNavigation(false); }}><Icon name="palette" /></button></div><span className={`connection ${ready ? "online" : ""}`} role="status">{ready ? "Connected to Shore" : state.status.replaceAll("_", " ")}</span></div>
    </aside>
    <main className="conversation"><header className="topbar"><button className="icon-button mobile-navigation" aria-label="Navigation" onClick={() => setNavigation(!navigation)}><Icon name="menu" /></button><div className="conversation-title"><span className="avatar header-avatar" aria-hidden="true">{(state.character ?? "S").slice(0, 1).toUpperCase()}</span><div><h1>{state.character ?? "Welcome to Shore"}<span>{state.thread === null ? "" : ` / ${state.threads.find((thread) => thread.id === state.thread)?.label ?? state.thread}`}</span></h1><p className="conversation-subtitle">{state.character === null ? "Choose a character to begin" : state.thread === "main" ? "Home conversation" : "Conversation"}</p></div></div><div className="actions"><button className="icon-button" title="Images" aria-label="Images" onClick={() => setImage(null)}><Icon name="image" /></button><button className="icon-button" title="Activity" aria-label="Activity" onClick={() => setActivity(!activity)} aria-pressed={activity}><Icon name="activity" /></button><Menu label="Conversation options"><button disabled={!ready || state.character === null} onClick={() => action("fork_thread", { from: state.thread ?? "main" })}><Icon name="branch" />Fork</button><button disabled={!ready || state.messages.length === 0 || regenRequest?.available !== true} onClick={() => setGuidance({ stream: true, guidance: "" })}>Regenerate</button><button disabled={!ready || state.character === null || !state.hasEarlier} onClick={() => perform(() => workspace.loadEarlier())}>Earlier history</button><button disabled={!ready || state.character === null} onClick={() => action("inject_system")}>System instruction</button><button onClick={() => setRequestHistory(true)}>Request history</button><div className="menu-divider" /><label className="check"><input type="checkbox" checked={reasoning} onChange={(event) => display.change("thinking", event.target.checked ? "on" : "off")} />Reasoning</label><label className="check"><input type="checkbox" checked={tools} onChange={(event) => display.change("tools", event.target.checked ? "on" : "off")} />Tools</label><label className="check"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow</label></Menu></div></header>
      {state.status === "reload_required" ? <div className="notice">Shore was upgraded. <button onClick={() => location.reload()}>Reload workspace</button></div> : !ready ? <div className="notice">{state.detail || "Connecting to Shore…"}<button onClick={() => workspace.connection.reconnect()}>Reconnect</button></div> : null}
      {state.error === "" ? null : <div role="alert" className="notice error">{state.error}<button aria-label="Dismiss error" onClick={() => workspace.dismissError()}>Dismiss</button></div>}
      {displayOpen || display.getSnapshot().error === "" ? null : <div role="alert" className="notice error">{display.getSnapshot().error}<button onClick={() => setDisplayOpen(true)}>Review display preferences</button></div>}
      {displayOpen || appearance.error === "" ? null : <div role="alert" className="notice error">{appearance.error}<button onClick={() => setDisplayOpen(true)}>Review appearance</button></div>}
      {keyboardOpen || bindings.getSnapshot().error === "" ? null : <div role="alert" className="notice error">{bindings.getSnapshot().error}<button onClick={() => setKeyboardOpen(true)}>Review keyboard shortcuts</button></div>}
      <RequestRecovery workspace={workspace} ready={ready} opened={requestHistory} setOpened={setRequestHistory} />
      {state.mediaLimited ? <p className="notice">Some live images were released to limit memory.</p> : null}
      {warnings.map((item) => <div className="notice" key={item.id}><Inspect label={item.type.replaceAll("_", " ")} value={item.data} /></div>)}
      <div className="messages" ref={transcript} tabIndex={0} role="region" aria-label="Conversation transcript" onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return;
        const node = event.currentTarget;
        const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 24;
        switch (event.key) {
          case "ArrowUp": event.preventDefault(); scrollTranscript("up"); break;
          case "ArrowDown": event.preventDefault(); scrollTranscript("down"); break;
          case "PageUp": event.preventDefault(); scrollTranscript("up", node.clientHeight / line); break;
          case "PageDown": event.preventDefault(); scrollTranscript("down", node.clientHeight / line); break;
          case "Home": event.preventDefault(); scrollTranscript("top"); break;
          case "End": event.preventDefault(); scrollTranscript("bottom"); break;
        }
      }}>{state.messages.length === 0 && state.streams.length === 0 ? <section className="empty"><div className="empty-mark" aria-hidden="true">s.</div><p className="eyebrow">YOURS TO UNFOLD</p><h2>{state.character === null ? "Start with a character" : `A new chapter with ${state.character}`}</h2><p>{state.character === null ? "Choose a character, or create someone new. There’s a conversation waiting to happen." : "Set the scene, say hello, or see where the conversation takes you."}</p>{state.character === null ? <button className="primary" disabled={!ready} onClick={() => action("create_character")}>Create character</button> : null}</section> : null}
        {state.messages.map((message, index) => <div key={message.msg_id}>{index === state.activeStart && index > 0 ? <div className="boundary">Active context</div> : null}<MessageCard message={message} character={state.character} metadata={state.metadata[message.msg_id]} reasoning={reasoning} tools={tools} openImage={openImage} action={action} /></div>)}
        {state.streams.filter((stream) => stream.subagent === null && !(stream.final && state.messages.some((message) => message.msg_id === stream.msgId))).map((stream) => <article className="message streaming" key={stream.key} aria-label="Streaming response"><strong>{stream.final ? "Response" : "Responding…"}</strong><LiveResponse stream={stream} openImage={openImage} /></article>)}{state.media.filter((item) => item.subagent === undefined || item.subagent === null).map((item) => <section className="message" aria-label="Live image" key={item.path}><ImageView data={item.data ?? null} caption={item.caption ?? item.path.split(/[\\/]/).at(-1) ?? "Live image"} open={openImage} /></section>)}<div ref={tail} />
      </div><BudgetReadout budgets={budgets.budgets} error={budgets.error} refresh={budgets.refresh} open={() => setUsage(true)} /><Composer ref={composer} key={JSON.stringify([state.character, state.thread])} state={state} workspace={workspace} />
    </main>
    {activity ? <ActivityPanel state={state} openImage={openImage} /> : null}
    {workspaceSettings ? <WorkspaceSettings ready={ready} character={state.character} close={() => setWorkspaceSettings(false)} run={(target) => { setWorkspaceSettings(false); requestAnimationFrame(() => perform(async () => { await localShortcuts[target]({}); })); }} /> : null}
    {keyboardOpen ? <KeyboardControls store={bindings} operations={state.operations} requests={state.requests} actions={workspace.actions} close={() => setKeyboardOpen(false)} /> : null}
    {helpOpen ? <LocalHelp bindings={bindings.getSnapshot().bindings} operations={state.operations} requests={state.requests} close={() => setHelpOpen(false)} run={(target, args = {}) => { setHelpOpen(false); requestAnimationFrame(() => perform(async () => { await localShortcuts[target](args); })); }} /> : null}
    {outputOpen ? <ActionOutput actions={workspace.actions} close={() => setOutputOpen(false)} /> : null}
    {shortcutResult === undefined ? null : <Modal title="Shortcut result" close={() => setShortcutResult(undefined)}><h3>{shortcutResult.label}</h3><Inspect value={shortcutResult.data} label="Complete shortcut result" /></Modal>}
    {template === undefined ? null : <Modal title={template.request.label} close={() => setTemplate(undefined)}><form onSubmit={(event) => { event.preventDefault(); const pending = template; setTemplate(undefined); perform(() => runConversation(pending.request.name, pending.values)); }}><RequestFields request={template.request} values={template.values} change={(values) => setTemplate({ ...template, values })} /><button type="submit">Run conversation action</button></form></Modal>}
    {displayOpen ? <DisplayControls budgets={budgets.budgets.map((budget) => budget.name)} close={() => setDisplayOpen(false)} /> : null}
    {memory && state.character !== null ? <Memory key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} thread={state.thread} streams={state.streams} changed={() => workspace.refreshNavigation()} close={() => setMemory(false)} openImage={openImage} /> : null}
    {archives ? <Archives operations={state.operations} characters={state.characters} character={state.character} ready={ready} changed={() => workspace.refreshNavigation()} close={() => setArchives(false)} advanced={(name, args) => { setArchives(false); action(name, args); }} /> : null}
    {usage ? <Usage key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} close={() => setUsage(false)} advanced={(args) => { setUsage(false); action("usage", args); }} /> : null}
    {toolWorkbench && state.character !== null ? <ToolWorkbench key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} thread={state.thread} close={() => setToolWorkbench(false)} advanced={(args) => { setToolWorkbench(false); action("run_tool", args); }} /> : null}
    {diagnostics && state.character !== null ? <Diagnostics key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} characters={state.characters.map((item) => item.name)} changed={() => workspace.refreshNavigation()} advanced={(name) => { setDiagnostics(false); action(name); }} close={() => setDiagnostics(false)} openImage={openImage} /> : null}
    {models ? <Models actions={workspace.actions} ready={ready} character={state.character} close={() => setModels(false)} changed={async () => { await workspace.refreshNavigation(); if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true }); }} /> : null}
    {settings ? <Settings actions={workspace.actions} ready={ready} character={state.character} close={() => setSettings(false)} /> : null}
    {providers ? <Providers actions={workspace.actions} ready={ready} close={() => setProviders(false)} /> : null}
    {palette ? <Modal title={quickOnly ? "Conversation shortcuts" : "All actions"} close={() => setPalette(false)}><label className="field">Find an action<input autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="action-list">{state.requests.filter((item) => (!quickOnly || quickNames.has(item.name))).filter((item) => `${item.label} ${item.name}`.toLowerCase().includes(search.toLowerCase())).map((item) => <button key={item.name} disabled={!ready || item.available === false} onClick={() => openRequest(item.name)}><strong>{item.label}</strong><small>Conversation</small></button>)}{state.operations.filter((item) => (!quickOnly || quickNames.has(item.name))).filter((item) => `${item.label} ${item.category} ${item.name}`.toLowerCase().includes(search.toLowerCase())).map((item) => <button key={item.name} disabled={item.available === false} onClick={() => action(item.name)}><strong>{item.label}</strong><small>{item.category}{item.available === false ? " · unavailable for this selection" : ""}</small></button>)}</div></Modal> : null}
    {operation === undefined || selectedAction === undefined ? null : <Action key={`${operation.name}.${JSON.stringify(selectedAction.preset)}`} operation={operation} state={state} preset={selectedAction.preset} review={selectedAction.review ?? false} close={() => setSelectedAction(undefined)} />}
    {image === undefined ? null : <Gallery mediaLimited={state.mediaLimited} images={galleryImages} {...(image === null ? {} : { opened: image })} earlier={() => workspace.loadEarlier()} canLoadEarlier={ready && state.character !== null && state.hasEarlier} close={() => setImage(undefined)} />}
    {guidance === undefined || regenRequest === undefined ? null : <Modal title="Regenerate response" close={() => setGuidance(undefined)}><form onSubmit={(event) => { event.preventDefault(); const values = guidance; setGuidance(undefined); perform(async () => { const completion = await workspace.connection.submit(conversationRequest("regen", values)).finished; if (completion.outcome !== "completed") throw new Error(completion.error?.message ?? `Regeneration ${completion.outcome}`); }); }}><RequestFields request={regenRequest} values={guidance} change={setGuidance} /><button className="primary">Regenerate</button></form></Modal>}
  </div>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Shore application root");
createRoot(root).render(<AppearanceProvider><DisplayProvider><App /></DisplayProvider></AppearanceProvider>);
