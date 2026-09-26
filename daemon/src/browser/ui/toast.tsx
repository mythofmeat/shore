import { useSyncExternalStore } from "react";
import { Icon } from "./icons.tsx";

export interface Toast { id: number; text: string; tone: "info" | "error" }

class ToastStore {
  #items: Toast[] = [];
  #next = 0;
  readonly #listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): Toast[] => this.#items;
  #emit(): void { for (const listener of this.#listeners) listener(); }
  show(text: string, tone: Toast["tone"] = "info"): void {
    const id = ++this.#next;
    this.#items = [...this.#items.filter((item) => item.text !== text), { id, text, tone }].slice(-4);
    this.#emit();
    setTimeout(() => { this.dismiss(id); }, tone === "error" ? 8000 : 3500);
  }
  dismiss(id: number): void {
    const next = this.#items.filter((item) => item.id !== id);
    if (next.length !== this.#items.length) { this.#items = next; this.#emit(); }
  }
}

export const toasts = new ToastStore();

export function Toasts() {
  const items = useSyncExternalStore(toasts.subscribe, toasts.getSnapshot);
  return <div className="toasts" aria-live="polite">
    {items.map((item) => <div key={item.id} className={`toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
      {item.tone === "error" ? <Icon name="alert" size={16} /> : <Icon name="check" size={16} />}
      <span>{item.text}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => toasts.dismiss(item.id)}><Icon name="close" size={14} /></button>
    </div>)}
  </div>;
}
