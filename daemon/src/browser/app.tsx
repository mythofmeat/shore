import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ImageUpload } from "../protocol/ImageUpload.ts";
import type { Message } from "../protocol/Message.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import { Providers } from "./providers.tsx";
import { Diagnostics } from "./diagnostics.tsx";
import { Memory } from "./memory.tsx";
import { ToolWorkbench } from "./tool_workbench.tsx";
import { Usage } from "./usage.tsx";
import { Archives } from "./archives.tsx";
import { toolNames } from "./tool_forms.ts";
import { Models } from "./models.tsx";
import { Settings } from "./settings.tsx";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";
import { BrowserConnection } from "./connection.ts";
import { Blocks, Field, ImageView, Inspect, Modal } from "./components.tsx";
import { operationPolicy } from "../operations/policy.ts";
import { actionControl, initialValue, record } from "./forms.ts";
import { Workspace, type WorkspaceSnapshot } from "./workspace.ts";

declare const SHORE_WEB_CONTRACT: string;
declare const SHORE_WEB_PROTOCOL: number;

const route = location.pathname.startsWith("/workspace/") ? location.pathname.slice(11).split("/").map(decodeURIComponent) : [];
const workspace = new Workspace(new BrowserConnection({ origin: location.origin, contract: SHORE_WEB_CONTRACT, protocol: SHORE_WEB_PROTOCOL, character: route[0] ?? null, thread: route[1] ?? null }));
const perform = (work: () => Promise<unknown>) => { void work().catch((error: unknown) => workspace.report(error)); };

function saved(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { workspace.report("Browser storage is unavailable. Keep this page open to retain your draft."); }
}

function Action({ operation, state, close, preset = {} }: { operation: OperationDescriptor; state: WorkspaceSnapshot; close: () => void; preset?: Record<string, unknown> }) {
  const control = actionControl(operation);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...record(initialValue(control)), ...preset }));
  const policy = operationPolicy(operation, values);
  const [confirming, setConfirming] = useState(false);
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
      void workspace.actions.run("tools", {}).then((access) => { if (current) setAvailableTools(toolNames(access)); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "providers")) {
      void workspace.actions.run("list_providers", {}).then((catalogue) => { if (current) setProviderNames(catalogue.providers.map((provider) => provider.name)); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "config_keys")) {
      void workspace.actions.run("config_schema", {}).then((catalogue) => { if (current) setConfigSchema(catalogue.schema); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "models")) {
      void workspace.actions.run("list_models", { include_hidden: true }).then((catalogue) => { if (current) setModelNames(Object.values(catalogue.models).flatMap((models) => models.map((model) => model.qualified_name))); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "subagents")) {
      void workspace.actions.run("tools", {}).then((access) => { if (current) setSubagentNames(["all", ...access.subagents.map((subagent) => subagent.name)]); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
    }
    if (state.status === "ready" && Object.values(operation.fields).some((field) => field.choices === "model_settings")) {
      void workspace.actions.run("model_settings", {}).then((settings) => { if (current && "setting_schema" in settings) setModelSettingKeys(settings.setting_schema.map((entry) => entry.key)); }).catch((failure: unknown) => { if (current) setError(String(failure)); });
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
    {result === undefined ? null : <div className="result"><h3>Action completed</h3><Inspect value={result} label="Complete action result" /></div>}
  </Modal>;
}

function Composer({ state }: { state: WorkspaceSnapshot }) {
  const key = `shore.draft.v1.${JSON.stringify([state.character, state.thread])}`;
  const [text, setText] = useState(() => saved(key));
  const [images, setImages] = useState<ImageUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const change = (value: string) => { setText(value); save(key, value); };
  const send = async () => {
    const submitted = text;
    const submittedImages = images;
    setBusy(true);
    try {
      const result = await workspace.connection.submit({ type: "message", text: submitted, stream: true, images: [], image_data: submittedImages }).finished;
      if (result.outcome === "completed") {
        setText((current) => { if (current !== submitted) return current; save(key, ""); return ""; });
        setImages((current) => current === submittedImages ? [] : current);
      } else workspace.report(result.error?.message ?? `Request ${result.outcome}. Your draft is retained.`);
    } catch (error) { workspace.report(error); } finally { setBusy(false); }
  };
  const attach = async (files: FileList | null) => {
    if (files === null) return;
    const added: ImageUpload[] = [];
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error("Choose PNG, JPEG, WebP or GIF images");
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose images smaller than 8 MiB");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.split(",", 2)[1] ?? "") : reject(new Error("Could not read image"));
        reader.onerror = () => reject(new Error("Could not read image")); reader.readAsDataURL(file);
      });
      added.push({ filename: file.name, data, mime_type: file.type });
    }
    if ([...images, ...added].reduce((sum, image) => sum + image.data.length, 0) > 16 * 1024 * 1024) throw new Error("Attachments exceed the 16 MiB browser limit");
    setImages((previous) => [...previous, ...added]);
  };
  useEffect(() => {
    const focus = (event: KeyboardEvent) => { if (event.altKey && event.key === "m") { event.preventDefault(); textRef.current?.focus(); } };
    window.addEventListener("keydown", focus); return () => { window.removeEventListener("keydown", focus); };
  }, []);
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!busy) void send(); }}>
    <label className="sr-only" htmlFor="message-composer">Message</label>
    <textarea id="message-composer" ref={textRef} rows={3} placeholder={state.character === null ? "Create or select a character to begin" : `Message ${state.character}…`} value={text} onChange={(event) => change(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !busy && state.status === "ready" && state.character !== null) { event.preventDefault(); void send(); } }} />
    {images.length === 0 ? null : <div className="attachments">{images.map((image, index) => <button type="button" key={index} onClick={() => setImages(images.filter((_, position) => position !== index))}>Remove {image.filename}</button>)}<small>Keep this page open to retain attachments.</small></div>}
    <div className="composer-footer"><label className="attach">Attach images<input aria-label="Attach images" className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { const files = event.target.files; perform(() => attach(files)); event.target.value = ""; }} /></label><small>Ctrl/⌘ Enter to send · draft saved locally</small><button type="button" onClick={() => workspace.connection.cancel()} disabled={state.status !== "ready"}>Stop</button><button type="submit" className="primary" disabled={busy || state.status !== "ready" || state.character === null || (text.trim() === "" && images.length === 0)}>{busy ? "Sending…" : "Send"}</button></div>
  </form>;
}

function MessageCard({ message, reasoning, tools, openImage, action }: { message: Message; reasoning: boolean; tools: boolean; openImage: (source: string) => void; action: (name: string, preset?: Record<string, unknown>) => void }) {
  return <article className={`message ${message.role}`} aria-label={`${message.role} message`}>
    <div className="message-heading"><strong>{message.role}</strong><time>{message.timestamp ? new Date(message.timestamp).toLocaleString() : ""}</time></div>
    {message.content_blocks.length === 0 ? <div className="message-text">{message.content}</div> : <Blocks blocks={message.content_blocks} reasoning={reasoning} tools={tools} openImage={openImage} />}
    {message.images.map((image, index) => <ImageView key={index} data={image.data ?? null} caption={image.caption ?? image.path.split("/").at(-1) ?? "Attached image"} open={openImage} />)}
    <div className="message-actions"><button onClick={() => perform(() => navigator.clipboard.writeText(message.content))}>Copy</button><button onClick={() => action("edit", { ref: message.msg_id, content: message.content })}>Edit</button><button onClick={() => action("delete", { refs: message.msg_id })}>Delete</button>{message.role === "assistant" ? <><button onClick={() => action("list_alternatives", { ref: message.msg_id })}>Alternatives</button><button onClick={() => action("alt", { ref: message.msg_id })}>Choose response</button></> : null}<Inspect label="Message details" value={message} /></div>
  </article>;
}

function App() {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [token, setToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedAction, setSelectedAction] = useState<{ name: string; preset: Record<string, unknown> }>();
  const [image, setImage] = useState<string>();
  const [activity, setActivity] = useState(false);
  const [providers, setProviders] = useState(false);
  const [settings, setSettings] = useState(false);
  const [models, setModels] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [memory, setMemory] = useState(false);
  const [toolWorkbench, setToolWorkbench] = useState(false);
  const [usage, setUsage] = useState(false);
  const [archives, setArchives] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const [reasoning, setReasoning] = useState(() => saved("shore.reasoning") !== "false");
  const [tools, setTools] = useState(() => saved("shore.tools") !== "false");
  const [guidance, setGuidance] = useState<string>();
  const tail = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const action = (name: string, preset: Record<string, unknown> = {}) => { setPalette(false); setSelectedAction({ name, preset }); };
  const operation = state.operations.find((item) => item.name === selectedAction?.name);
  const select = async (name: string, thread = false) => {
    if (thread) await workspace.actions.run("switch_thread", { name, resync: true });
    else await workspace.actions.run("switch_character", { name });
    setNavigation(false);
  };
  useEffect(() => { workspace.connection.connect(); return () => { workspace.connection.stop(); }; }, []);
  useEffect(() => { if (follow) tail.current?.scrollIntoView({ block: "end" }); }, [state.messages, state.streams, follow]);
  useEffect(() => { if (state.character !== null) history.replaceState(null, "", `/workspace/${encodeURIComponent(state.character)}/${encodeURIComponent(state.thread ?? "main")}`); }, [state.character, state.thread]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); setPalette((open) => !open); } };
    window.addEventListener("keydown", shortcut); return () => { window.removeEventListener("keydown", shortcut); };
  }, []);
  const ready = state.status === "ready";
  const warnings = state.activity.filter((item) => item.type.endsWith("warning")).slice(-3);
  if (state.status === "signed_out" || state.status === "stopped") return <main className="signin"><div className="brand">SHORE <span>WORKSPACE</span></div><h1>Your conversations,<br />where you need them.</h1><p>Sign in with your Shore daemon token.</p><form onSubmit={(event) => { event.preventDefault(); setSigningIn(true); perform(async () => { try { await workspace.connection.signIn(token); setToken(""); } finally { setSigningIn(false); } }); }}><label className="field">Daemon token<input autoFocus type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} /></label><button className="primary" disabled={signingIn || token === ""}>{signingIn ? "Connecting…" : "Open workspace"}</button></form><p role="alert">{state.error || state.detail}</p></main>;
  return <div className={`workspace ${activity ? "with-activity" : ""} ${navigation ? "with-navigation" : ""}`}>
    {navigation ? <button className="navigation-backdrop" aria-label="Close navigation" onClick={() => setNavigation(false)} /> : null}
    <aside className="sidebar"><div className="brand">SHORE <span>WORKSPACE</span></div><div className="section-heading"><h2>Characters</h2><button disabled={!ready} onClick={() => action("create_character")}>New</button></div>
      <nav aria-label="Characters">{state.characters.map((character) => <button key={character.name} aria-current={state.character === character.name ? "page" : undefined} disabled={!ready} onClick={() => perform(() => select(character.name))}><span className="avatar">{character.name.slice(0, 1).toUpperCase()}</span>{character.name}</button>)}</nav>
      <div className="section-heading"><h2>Threads</h2><button disabled={!ready || state.character === null} onClick={() => action("create_thread")}>New</button></div><nav aria-label="Threads">{state.threads.map((thread) => <button key={thread.id} aria-current={state.thread === thread.id ? "page" : undefined} disabled={!ready} onClick={() => perform(() => select(thread.id, true))}>{thread.label ?? thread.id}<small>{thread.home ? "Home" : thread.turns === undefined ? "" : `${String(thread.turns)} turns`}</small></button>)}</nav>
      <div className="sidebar-footer"><button disabled={!ready} onClick={() => { setArchives(true); setNavigation(false); }}>Character archives</button><button disabled={!ready} onClick={() => { setUsage(true); setNavigation(false); }}>Usage &amp; budgets</button><button disabled={!ready || state.character === null} onClick={() => { setToolWorkbench(true); setNavigation(false); }}>Tool workbench</button><button disabled={!ready || state.character === null} onClick={() => { setMemory(true); setNavigation(false); }}>Memory &amp; segments</button><button disabled={!ready || state.character === null} onClick={() => { setDiagnostics(true); setNavigation(false); }}>Diagnostics</button><button disabled={!ready} onClick={() => { setModels(true); setNavigation(false); }}>Models &amp; roles</button><button disabled={!ready} onClick={() => { setSettings(true); setNavigation(false); }}>Settings</button><button disabled={!ready} onClick={() => { setProviders(true); setNavigation(false); }}>Providers</button><button disabled={!ready} onClick={() => setPalette(true)}>All actions <kbd>⌘ K</kbd></button><button onClick={() => perform(() => workspace.connection.signOut())}>Sign out</button></div>
    </aside>
    <main className="conversation"><header className="topbar"><div><p className="eyebrow">CONVERSATION</p><h1>{state.character ?? "Welcome to Shore"}<span>{state.thread === null ? "" : ` / ${state.thread}`}</span></h1></div><div className="actions"><button className="mobile-navigation" onClick={() => setNavigation(!navigation)}>Navigation</button><span className={`connection ${ready ? "online" : ""}`} role="status">{state.status.replaceAll("_", " ")}</span><button disabled={!ready || state.character === null} onClick={() => action("fork_thread", { from: state.thread ?? "main" })}>Fork</button><button onClick={() => setActivity(!activity)} aria-pressed={activity}>Activity</button></div></header>
      {state.status === "reload_required" ? <div className="notice">Shore was upgraded. <button onClick={() => location.reload()}>Reload workspace</button></div> : !ready ? <div className="notice">{state.detail || "Connecting to Shore…"}<button onClick={() => workspace.connection.reconnect()}>Reconnect</button></div> : null}
      {state.error === "" ? null : <div role="alert" className="notice error">{state.error}<button aria-label="Dismiss error" onClick={() => workspace.dismissError()}>Dismiss</button></div>}
      {state.uncertain.map((item) => <div className="notice" key={item.rid}><strong>Request outcome uncertain</strong><p>The connection was interrupted in {item.selection.character} / {item.selection.thread ?? "main"}. Inspect the conversation before trying again.</p><Inspect value={item.request} label="Inspect interrupted request" /><button onClick={() => workspace.connection.reconnect()}>Refresh conversation</button><button onClick={() => workspace.acknowledge(item.rid)}>I checked the outcome</button></div>)}
      {warnings.map((item) => <div className="notice" key={item.id}><Inspect label={item.type.replaceAll("_", " ")} value={item.data} /></div>)}
      <div className="conversation-tools"><label className="check"><input type="checkbox" checked={reasoning} onChange={(event) => { setReasoning(event.target.checked); save("shore.reasoning", String(event.target.checked)); }} />Reasoning</label><label className="check"><input type="checkbox" checked={tools} onChange={(event) => { setTools(event.target.checked); save("shore.tools", String(event.target.checked)); }} />Tools</label><label className="check"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow</label><button disabled={!ready || state.character === null || !state.hasEarlier} onClick={() => perform(() => workspace.loadEarlier())}>Earlier history</button><button disabled={!ready || state.character === null} onClick={() => action("inject_system")}>System instruction</button><button disabled={!ready || state.messages.length === 0} onClick={() => setGuidance("")}>Regenerate</button></div>
      <div className="messages">{state.messages.length === 0 && state.streams.length === 0 ? <section className="empty"><p className="eyebrow">A SPACE TO THINK</p><h2>{state.character === null ? "Start with a character" : "Start a conversation"}</h2><p>{state.character === null ? "Create a character or choose one from the sidebar." : "Write a message below. Your history and tools are shared with the terminal."}</p>{state.character === null ? <button className="primary" disabled={!ready} onClick={() => action("create_character")}>Create character</button> : null}</section> : null}
        {state.messages.map((message, index) => <div key={message.msg_id}>{index === state.activeStart && index > 0 ? <div className="boundary">Active context</div> : null}<MessageCard message={message} reasoning={reasoning} tools={tools} openImage={setImage} action={action} /></div>)}
        {state.streams.filter((stream) => stream.subagent === null && !(stream.final && state.messages.some((message) => message.msg_id === stream.msgId))).map((stream) => <article className="message streaming" key={stream.key} aria-label="Streaming response"><strong>{stream.final ? "Response" : "Responding…"}</strong><div className="message-text">{stream.text}</div>{reasoning && stream.reasoning !== "" ? <details><summary>Reasoning</summary><pre>{stream.reasoning}</pre></details> : null}<Blocks blocks={stream.blocks.filter((block) => block.type !== "text")} reasoning={reasoning} tools={tools} openImage={setImage} /></article>)}<div ref={tail} />
      </div><Composer key={JSON.stringify([state.character, state.thread])} state={state} />
    </main>
    {activity ? <aside className="activity"><h2>Activity & details</h2><Inspect label="Conversation configuration" value={state.config} />{state.streams.filter((stream) => stream.subagent !== null).map((stream) => <section key={stream.key}><h3>{stream.subagent}</h3><div className="message-text">{stream.text}</div><Blocks blocks={stream.blocks} reasoning={reasoning} tools={tools} openImage={setImage} /></section>)}{state.activity.slice().reverse().map((item) => <Inspect key={item.id} label={item.type.replaceAll("_", " ")} value={item.data} />)}</aside> : null}
    {memory && state.character !== null ? <Memory key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} thread={state.thread} streams={state.streams} changed={() => workspace.refreshNavigation()} close={() => setMemory(false)} openImage={setImage} /> : null}
    {archives ? <Archives operations={state.operations} characters={state.characters} character={state.character} ready={ready} changed={() => workspace.refreshNavigation()} close={() => setArchives(false)} advanced={(name, args) => { setArchives(false); action(name, args); }} /> : null}
    {usage ? <Usage key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} close={() => setUsage(false)} advanced={(args) => { setUsage(false); action("usage", args); }} /> : null}
    {toolWorkbench && state.character !== null ? <ToolWorkbench key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} thread={state.thread} close={() => setToolWorkbench(false)} advanced={(args) => { setToolWorkbench(false); action("run_tool", args); }} /> : null}
    {diagnostics && state.character !== null ? <Diagnostics key={`${state.character}.${state.thread}`} actions={workspace.actions} operations={state.operations} ready={ready} character={state.character} characters={state.characters.map((item) => item.name)} changed={() => workspace.refreshNavigation()} advanced={(name) => { setDiagnostics(false); action(name); }} close={() => setDiagnostics(false)} openImage={setImage} /> : null}
    {models ? <Models actions={workspace.actions} ready={ready} character={state.character} close={() => setModels(false)} changed={async () => { await workspace.refreshNavigation(); if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true }); }} /> : null}
    {settings ? <Settings actions={workspace.actions} ready={ready} character={state.character} close={() => setSettings(false)} /> : null}
    {providers ? <Providers actions={workspace.actions} ready={ready} close={() => setProviders(false)} /> : null}
    {palette ? <Modal title="All actions" close={() => setPalette(false)}><label className="field">Find an action<input autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="action-list">{state.operations.filter((item) => `${item.label} ${item.category} ${item.name}`.toLowerCase().includes(search.toLowerCase())).map((item) => <button key={item.name} disabled={item.available === false} onClick={() => action(item.name)}><strong>{item.label}</strong><small>{item.category}{item.available === false ? " · unavailable for this selection" : ""}</small></button>)}</div></Modal> : null}
    {operation === undefined || selectedAction === undefined ? null : <Action key={`${operation.name}.${JSON.stringify(selectedAction.preset)}`} operation={operation} state={state} preset={selectedAction.preset} close={() => setSelectedAction(undefined)} />}
    {image === undefined ? null : <Modal title="Image" close={() => setImage(undefined)}><img className="full-image" alt="Full-size conversation image" src={image} /><a href={image} download="shore-image">Download image</a></Modal>}
    {guidance === undefined ? null : <Modal title="Regenerate response" close={() => setGuidance(undefined)}><form onSubmit={(event) => { event.preventDefault(); const text = guidance; setGuidance(undefined); perform(async () => { const completion = await workspace.connection.submit({ type: "regen", stream: true, guidance: text }).finished; if (completion.outcome !== "completed") throw new Error(completion.error?.message ?? `Regeneration ${completion.outcome}`); }); }}><label className="field">Guidance<textarea rows={4} value={guidance} onChange={(event) => setGuidance(event.target.value)} /></label><button className="primary">Regenerate</button></form></Modal>}
  </div>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Shore application root");
createRoot(root).render(<App />);
