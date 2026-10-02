import { VIEW_PREFERENCES } from "./preferences.generated.ts";
import { VIEW_CONTROLS, viewValue, type ViewKey } from "./preferences.ts";
import { isOperationName, validOperationInput } from "./operation_validators.generated.js";
import { conversationRequest } from "./request_forms.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";

export const LOCAL_SHORTCUTS = {
  images: "Conversation images", palette: "All actions", keyboard: "Keyboard shortcuts", display: "Display preferences", activity: "Activity panel",
  settings: "Settings", models: "Models & roles", providers: "Providers", diagnostics: "Diagnostics",
  memory: "Memory & segments", tools: "Tool workbench", usage: "Usage & budgets", archives: "Character archives",
  help: "Workspace help", quick: "Conversation shortcuts", transcript: "Focus transcript", focus_home: "Start of input line", focus_end: "End of input line", sign_out: "Disconnect", attach: "Choose image attachments", clear_images: "Clear image attachments",
  edit_cancel: "Cancel message edit", output: "Last action output", editor: "Expand draft editor", undo: "Undo draft text", redo: "Redo draft text", focus: "Focus composer", send: "Send current draft", follow: "Toggle following responses",
  top: "Scroll to first message", bottom: "Scroll to latest message", up: "Scroll up", down: "Scroll down",
} as const;
export function scrollAmount(args: Record<string, unknown>): number {
  const amount = args["amount"] ?? 1;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 65535) throw new Error("Scroll amount must be a whole number from 0 to 65535");
  return amount;
}
export interface Binding { key: string; scope: "normal" | "global"; target: string; args: Record<string, unknown>; mode: "open" | "run" }
export const KEYBOARD_STORAGE = "shore.keyboard.v1.";
export const MAX_BINDINGS = 128;
const MAX_BINDING_BYTES = 32 * 1024;
const modifiers = ["ctrl", "alt", "shift", "meta"];
const aliases: Record<string, string> = { control: "ctrl", cmd: "meta", command: "meta", option: "alt", esc: "escape", return: "enter", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", " ": "space", "+": "plus", "-": "minus" };
const named = new Set(["escape", "tab", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown", "backspace", "delete", "insert", "space", "plus", "minus"]);

export function normalizeKey(value: string): string {
  const written = value.trim().split("+");
  const raw = written.pop()?.trim() ?? "";
  const parts = written.map((part) => { const token = part.trim().toLowerCase(); return aliases[token] ?? token; });
  const key = aliases[raw] ?? (Array.from(raw).length === 1 ? raw.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : aliases[raw.toLowerCase()] ?? raw.toLowerCase());
  if (/^[A-Z]$/.test(raw) && !parts.includes("shift")) parts.push("shift");
  if ((Array.from(key).length === 1 && !/^[a-z]$/.test(key)) || ["plus", "minus"].includes(key)) { const shift = parts.indexOf("shift"); if (shift >= 0) parts.splice(shift, 1); }
  if (parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length || !(Array.from(key).length === 1 || named.has(key) || /^f(?:[1-9]|1\d|2[0-4])$/.test(key))) throw new Error("Use a key such as alt+k, ctrl+shift+u, or j");
  return [...modifiers.filter((modifier) => parts.includes(modifier)), key].join("+");
}
export function reservedKey(key: string): boolean {
  const parts = key.split("+");
  const base = parts.at(-1);
  return base === "escape" || base === "tab" || ((parts.includes("ctrl") || parts.includes("meta")) && ["a", "c", "v", "x", "z", "y", "l", "r", "t", "w", "n", "q", "p", "f"].includes(base ?? ""));
}
export function keyFromEvent(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | undefined {
  const key = aliases[event.key] ?? (Array.from(event.key).length === 1 ? event.key.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : event.key.toLowerCase());
  try { return normalizeKey([event.ctrlKey ? "ctrl" : "", event.altKey ? "alt" : "", event.shiftKey ? "shift" : "", event.metaKey ? "meta" : "", key].filter(Boolean).join("+")); } catch { return undefined; }
}
export const bindingId = (binding: Pick<Binding, "scope" | "key">): string => `${binding.scope}:${binding.key}`;
export function defaultBindings(): Binding[] {
  return [["ctrl+k", "palette"], ["meta+k", "palette"], ["ctrl+enter", "send"], ["meta+enter", "send"], ["alt+m", "focus"]].map(([key, target]) => ({ key: key ?? "", scope: "global", target: `local:${target ?? ""}`, args: {}, mode: "run" }));
}
export function bindingValue(value: unknown): Binding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid shortcut record");
  const record = value as Record<string, unknown>;
  if (typeof record["key"] !== "string" || (record["scope"] !== "normal" && record["scope"] !== "global") || typeof record["target"] !== "string" || !/^(local|operation|request|view):[a-z][a-z0-9_]*$/.test(record["target"]) || (record["mode"] !== "open" && record["mode"] !== "run") || typeof record["args"] !== "object" || record["args"] === null || Array.isArray(record["args"])) throw new Error("Invalid shortcut record");
  const key = normalizeKey(record["key"]);
  if (reservedKey(key)) throw new Error("That key is reserved for the browser or text editing");
  if (record["scope"] === "global" && !key.split("+").some((part) => ["ctrl", "alt", "meta"].includes(part))) throw new Error("Shortcuts active while typing need Ctrl, Alt or Command");
  const result: Binding = { key, scope: record["scope"], target: record["target"], args: record["args"] as Record<string, unknown>, mode: record["mode"] };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BINDING_BYTES) throw new Error("A shortcut can store at most 32 KiB of arguments");
  return result;
}
export function validateBinding(binding: Binding, operations: readonly OperationDescriptor[], requests: readonly OperationDescriptor[]): void {
  const [kind, name = ""] = binding.target.split(":");
  switch (kind) {
    case "local":
      if (!Object.hasOwn(LOCAL_SHORTCUTS, name)) throw new Error("This browser action is unavailable");
      if (name === "up" || name === "down") scrollAmount(binding.args);
      break;
    case "view": if (!Object.hasOwn(VIEW_PREFERENCES, name) || typeof binding.args["value"] !== "string" || (binding.args["value"] !== "toggle" && !viewValue(name as ViewKey, binding.args["value"]))) throw new Error("Choose a valid display preference value"); break;
    case "operation": {
      const operation = operations.find((item) => item.name === name);
      if (operation === undefined) throw new Error("This operation is unavailable");
      if (binding.mode === "run" && (!isOperationName(name) || !validOperationInput(name, binding.args))) throw new Error("Complete the operation arguments before saving a run shortcut");
      break;
    }
    case "request": {
      if (!requests.some((item) => item.name === name)) throw new Error("This conversation action is unavailable");
      if (binding.mode === "run") {
        if (name === "message" || name === "regen") conversationRequest(name, binding.args);
        else if (name !== "cancel") throw new Error("Unsupported conversation action");
      }
      break;
    }
    default: throw new Error("Unsupported shortcut target");
  }
}
export function validateSavedConfig(binding: Binding, schema: readonly Pick<ConfigSchemaEntry, "key" | "secret">[] | undefined): void {
  if (binding.target !== "operation:config" || !Object.hasOwn(binding.args, "value") || binding.args["value"] === null) return;
  if (schema === undefined) throw new Error("Wait for the configuration schema before saving arguments");
  const entry = schema.find((item) => item.key === binding.args["key"]);
  if (entry === undefined || entry.secret) throw new Error("Secret or unrecognized configuration values cannot be saved in shortcuts. Omit Value and enter it when the form opens.");
}
export function shortcutTargets(operations: readonly OperationDescriptor[], requests: readonly OperationDescriptor[]) {
  return [
    ...Object.entries(LOCAL_SHORTCUTS).map(([id, label]) => ({ id: `local:${id}`, label })),
    ...Object.entries(VIEW_CONTROLS).map(([id, control]) => ({ id: `view:${id}`, label: `Display · ${control.label}` })),
    ...requests.map((item) => ({ id: `request:${item.name}`, label: `Conversation · ${item.label}` })),
    ...operations.map((item) => ({ id: `operation:${item.name}`, label: `Operation · ${item.label}` })),
  ];
}
export function matchingBinding(bindings: readonly Binding[], key: string, editing: boolean, modal: boolean): Binding | undefined {
  const candidates = bindings.filter((item) => item.key === key && (item.scope === "global" || !editing));
  const binding = candidates.find((item) => item.scope === "global") ?? candidates[0];
  return modal && binding?.target !== "request:cancel" && binding?.target !== "local:edit_cancel" ? undefined : binding;
}

type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export class KeyboardBindings {
  #state: { bindings: Binding[]; error: string } = { bindings: defaultBindings(), error: "" };
  #dirty = new Map<string, Binding | null>();
  #listeners = new Set<() => void>();
  constructor(readonly storage: StorageAccess) { this.reload(); }
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #emit() { for (const listener of this.#listeners) listener(); }
  #read(): Map<string, Binding> {
    const values = new Map(defaultBindings().map((binding) => [bindingId(binding), binding]));
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (key === null || !key.startsWith(KEYBOARD_STORAGE)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      if (raw.length > MAX_BINDING_BYTES) throw new Error("Saved shortcut is too large");
      const value: unknown = JSON.parse(raw);
      const id = key.slice(KEYBOARD_STORAGE.length);
      if (value === null) values.delete(id);
      else { const binding = bindingValue(value); if (bindingId(binding) !== id) throw new Error("Saved shortcut key does not match its record"); values.set(id, binding); }
    }
    if (values.size > MAX_BINDINGS) throw new Error("At most 128 shortcuts can be saved");
    return values;
  }
  reload(): void {
    try {
      const values = this.#read();
      for (const [id, binding] of this.#dirty) { if (binding === null) values.delete(id); else values.set(id, binding); }
      this.#state = { bindings: [...values.values()], error: this.#dirty.size === 0 ? "" : this.#state.error };
    } catch (error) { this.#state = { ...this.#state, error: `Could not read saved shortcuts: ${error instanceof Error ? error.message : String(error)}. Current bindings are retained.` }; }
    this.#emit();
  }
  put(value: Binding): void {
    const binding = bindingValue(value);
    const id = bindingId(binding);
    const bindings = this.#state.bindings.filter((item) => bindingId(item) !== id);
    if (bindings.length >= MAX_BINDINGS) throw new Error("At most 128 shortcuts can be saved");
    bindings.push(binding); this.#dirty.set(id, binding); this.#state = { ...this.#state, bindings }; this.save();
  }
  remove(binding: Binding): void { const id = bindingId(binding); this.#dirty.set(id, null); this.#state = { ...this.#state, bindings: this.#state.bindings.filter((item) => bindingId(item) !== id) }; this.save(); }
  save(): void {
    try { for (const [id, binding] of this.#dirty) { if (binding === null && !defaultBindings().some((item) => bindingId(item) === id)) this.storage.removeItem(KEYBOARD_STORAGE + id);
      else this.storage.setItem(KEYBOARD_STORAGE + id, JSON.stringify(binding)); this.#dirty.delete(id); } this.reload(); }
    catch { this.#state = { ...this.#state, error: "Shortcuts are not saved. Keep this tab open and retry saving." }; this.#emit(); }
  }
  reset(): void {
    try { for (let index = 0; index < this.storage.length; index++) { const key = this.storage.key(index); if (key?.startsWith(KEYBOARD_STORAGE)) this.#dirty.set(key.slice(KEYBOARD_STORAGE.length), null); } }
    catch { this.#state = { ...this.#state, error: "Could not read shortcuts to reset them. Current bindings are retained." }; this.#emit(); return; }
    for (const item of this.#state.bindings) this.#dirty.set(bindingId(item), null);
    const bindings = defaultBindings(); for (const item of bindings) this.#dirty.set(bindingId(item), item);
    this.#state = { bindings, error: "" }; this.save();
  }
}
