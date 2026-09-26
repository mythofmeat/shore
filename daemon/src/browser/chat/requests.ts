import type { BrowserConnection } from "../connection.ts";
import type { RequestFinished } from "../../protocol/RequestFinished.ts";
import { conversationRequest } from "../request_forms.ts";

export class ConversationRequests {
  #active: ReadonlySet<string> = new Set();
  readonly #regens = new Set<string>();
  readonly #started = new Set<string>();
  readonly #accepted = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  constructor(readonly connection: BrowserConnection) {
    connection.subscribe((update) => {
      if (update.kind !== "frame") return;
      if (update.message.type === "new_message") {
        const { rid, role } = update.message;
        if (role !== "user" || typeof rid !== "string") return;
        this.#accepted.get(rid)?.();
        this.#accepted.delete(rid);
        return;
      }
      if (update.message.type !== "stream_start" && update.message.type !== "stream_end") return;
      const { rid, subagent } = update.message;
      if (typeof rid !== "string" || (subagent ?? null) !== null || !this.#active.has(rid) || this.#started.has(rid)) return;
      this.#started.add(rid);
      this.#set(new Set(this.#active));
    });
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): ReadonlySet<string> => this.#active;
  #set(active: ReadonlySet<string>): void { this.#active = active; for (const listener of this.#listeners) listener(); }
  async submit(name: "message" | "regen", values: Record<string, unknown>, accepted?: () => void): Promise<RequestFinished> {
    const request = conversationRequest(name, values);
    const { rid, finished } = this.connection.submit(request);
    if (name === "regen") this.#regens.add(rid);
    if (accepted !== undefined) this.#accepted.set(rid, accepted);
    this.#set(new Set([...this.#active, rid]));
    try { return await finished; } finally { this.#regens.delete(rid); this.#started.delete(rid); this.#accepted.delete(rid); this.#set(new Set([...this.#active].filter((item) => item !== rid))); }
  }
  awaitingStream(): string | undefined { return [...this.#active].find((rid) => !this.#started.has(rid)); }
  pendingRegens(): readonly string[] { return [...this.#regens].filter((rid) => !this.#started.has(rid)); }
  async regenerate(guidance?: string, stream = true): Promise<void> {
    const result = await this.submit("regen", { stream, ...(guidance === undefined || guidance.trim() === "" ? {} : { guidance: guidance.trim() }) });
    if (result.outcome !== "completed") throw new Error(result.error?.message ?? (result.outcome === "cancelled" ? "Regeneration stopped" : `Regeneration ${result.outcome}`));
  }
  cancel(): void { this.connection.cancel(); }
}
