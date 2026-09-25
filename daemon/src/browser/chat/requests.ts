import type { BrowserConnection } from "../connection.ts";
import type { RequestFinished } from "../../protocol/RequestFinished.ts";
import { conversationRequest } from "../request_forms.ts";

export class ConversationRequests {
  #active: ReadonlySet<string> = new Set();
  readonly #listeners = new Set<() => void>();
  constructor(readonly connection: BrowserConnection) {}
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): ReadonlySet<string> => this.#active;
  #set(active: ReadonlySet<string>): void { this.#active = active; for (const listener of this.#listeners) listener(); }
  async submit(name: "message" | "regen", values: Record<string, unknown>): Promise<RequestFinished> {
    const request = conversationRequest(name, values);
    const { rid, finished } = this.connection.submit(request);
    this.#set(new Set([...this.#active, rid]));
    try { return await finished; } finally { this.#set(new Set([...this.#active].filter((item) => item !== rid))); }
  }
  async regenerate(guidance?: string): Promise<void> {
    const result = await this.submit("regen", { stream: true, ...(guidance === undefined || guidance.trim() === "" ? {} : { guidance: guidance.trim() }) });
    if (result.outcome !== "completed") throw new Error(result.error?.message ?? (result.outcome === "cancelled" ? "Regeneration stopped" : `Regeneration ${result.outcome}`));
  }
  cancel(): void { this.connection.cancel(); }
}
