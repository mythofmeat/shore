import { useEffect, useState, useSyncExternalStore } from "react";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";
import type { OperationClient } from "./operations.ts";
import { actionControl, initialValue, record } from "./forms.ts";
import { Modal } from "./components.tsx";
import { RequestFields } from "./request_fields.tsx";
import { type ViewKey } from "./preferences.ts";
import { VIEW_PREFERENCES } from "./preferences.generated.ts";
import { KeyboardBindings, KEYBOARD_STORAGE, shortcutTargets, bindingId, keyFromEvent, validateBinding, validateSavedConfig, type Binding } from "./keyboard.ts";

export function useBindings() {
  const [store] = useState(() => new KeyboardBindings({ get length() { return localStorage.length; }, key: (index) => localStorage.key(index), getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key) }));
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { const update = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(KEYBOARD_STORAGE)) store.reload(); }; window.addEventListener("storage", update); return () => window.removeEventListener("storage", update); }, [store]);
  return store;
}
export function KeyboardControls({ store, operations, requests, actions, close }: { store: KeyboardBindings; operations: OperationDescriptor[]; requests: OperationDescriptor[]; actions: OperationClient; close: () => void }) {
  const { bindings, error: storageError } = store.getSnapshot();
  const [binding, setBinding] = useState<Binding>({ key: "", scope: "normal", target: "local:palette", args: {}, mode: "open" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [resetting, setResetting] = useState(false);
  const [schema, setSchema] = useState<ConfigSchemaEntry[]>();
  useEffect(() => {
    if (binding.target !== "operation:config") return;
    let current = true; setSchema(undefined);
    void actions.run("config_schema", {}).then((result) => { if (current) setSchema(result.schema); }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [binding.target, actions]);
  const [kind, name = ""] = binding.target.split(":");
  const descriptor = (kind === "operation" ? operations : kind === "request" ? requests : []).find((item) => item.name === name);
  const view = kind === "view" && Object.hasOwn(VIEW_PREFERENCES, name) ? name as ViewKey : undefined;
  const targets = shortcutTargets(operations, requests);
  const choose = (target: string) => {
    const [category, action] = target.split(":");
    const input = (category === "operation" ? operations : category === "request" ? requests : []).find((item) => item.name === action);
    setBinding({ ...binding, target, args: category === "view" ? { value: "toggle" } : input === undefined ? {} : record(initialValue(actionControl(input))) });
    setError(""); setSaved("");
  };
  return <Modal title="Keyboard shortcuts" close={close}>
    <p>Bindings and arguments are saved on this device and shared across its tabs. “Outside controls” leaves typing, buttons and links alone. “While typing” also works in the composer. Dialogs keep their own keys; cancellation remains available.</p>
    <p>Escape, Tab, browser navigation and standard editing shortcuts remain available. Use Ctrl on Windows/Linux or Command on macOS; these modifiers are separate bindings.</p>
    <form aria-label="Shortcut editor" onSubmit={(event) => { event.preventDefault(); try { validateBinding(binding, operations, requests); validateSavedConfig(binding, schema); store.put(binding); setError(""); setSaved("Shortcut applied"); } catch (failure) { setSaved(""); setError(failure instanceof Error ? failure.message : String(failure)); } }}>
      <label className="field">Shortcut key<input required value={binding.key} placeholder="alt+u" onChange={(event) => setBinding({ ...binding, key: event.target.value })} /></label>
      <label className="field">Record a shortcut<input readOnly value="" placeholder="Focus here and press the keys" onKeyDown={(event) => { if (event.key === "Tab" || event.key === "Escape") return; event.preventDefault(); event.stopPropagation(); if (event.nativeEvent.isComposing) return; const key = keyFromEvent(event); if (key !== undefined) setBinding({ ...binding, key }); }} /></label>
      <label className="field">Shortcut scope<select aria-label="Shortcut scope" value={binding.scope} onChange={(event) => setBinding({ ...binding, scope: event.target.value === "global" ? "global" : "normal" })}><option value="normal">Outside controls</option><option value="global">While typing</option></select></label>
      <label className="field">Shortcut action<select aria-label="Shortcut action" value={binding.target} onChange={(event) => choose(event.target.value)}>{targets.some((item) => item.id === binding.target) ? null : <option value={binding.target}>{binding.target} · unavailable</option>}{targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {kind === "operation" || kind === "request" ? <><label className="field">When pressed<select aria-label="When pressed" value={binding.mode} onChange={(event) => setBinding({ ...binding, mode: event.target.value === "run" ? "run" : "open" })}><option value="open">Open the form with these arguments</option><option value="run">Run with these arguments</option></select></label><p>Actions that require confirmation still ask before running. Arguments use the conversation selected when the shortcut is pressed.</p>{descriptor === undefined ? <p>This action is currently unavailable.</p> : <RequestFields request={descriptor} values={binding.args} secret={binding.target === "operation:config" && schema?.find((entry) => entry.key === binding.args["key"])?.secret !== false ? ["value"] : []} change={(args) => setBinding({ ...binding, args })} />}</> : null}
      {view === undefined ? null : <label className="field">Display value<input aria-label="Display value" list="keyboard-view-values" value={typeof binding.args["value"] === "string" ? binding.args["value"] : "toggle"} onChange={(event) => setBinding({ ...binding, args: { value: event.target.value } })} /><datalist id="keyboard-view-values">{VIEW_PREFERENCES[view].map((value) => <option key={value} value={value} />)}</datalist></label>}
      {bindings.some((item) => bindingId(item) === bindingId(binding)) ? <p>This replaces the binding for that key and scope.</p> : null}
      <button type="submit">Save shortcut</button>
    </form>
    {error === "" ? null : <p role="alert">{error}</p>}{saved === "" ? null : <p role="status">{saved}</p>}
    {storageError === "" ? null : <p role="alert">{storageError}<button onClick={() => store.save()}>Retry saving shortcuts</button></p>}
    <section aria-label="Saved shortcuts"><h3>Saved shortcuts</h3>{bindings.map((item) => <div className="shortcut-row" key={bindingId(item)}><kbd>{item.key}</kbd><span>{item.scope === "global" ? "While typing" : "Outside controls"} · {targets.find((target) => target.id === item.target)?.label ?? `${item.target} · unavailable`}</span><button aria-label={`Edit ${bindingId(item)}`} onClick={() => { setBinding(item); setError(""); setSaved(""); }}>Edit</button><button aria-label={`Remove ${bindingId(item)}`} onClick={() => store.remove(item)}>Remove</button></div>)}</section>
    <button onClick={() => setResetting(true)}>Reset keyboard shortcuts</button>{resetting ? <div className="confirmation"><p>Replace custom shortcuts with the browser defaults?</p><button onClick={() => setResetting(false)}>Keep shortcuts</button><button onClick={() => { store.reset(); setResetting(false); }}>Confirm reset shortcuts</button></div> : null}
  </Modal>;
}
