import type { BrowserConnection } from "../connection.ts";
import type { RequestFinished } from "../../protocol/RequestFinished.ts";
import { conversationRequest } from "../request_forms.ts";

export interface ConversationScope { character: string | null; thread: string | null }

export class ConversationRequests {
  #active: ReadonlySet<string> = new Set();
  readonly #regens = new Set<string>();
  readonly #started = new Set<string>();
  readonly #scopes = new Map<string, ConversationScope>();
  readonly #accepted = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  constructor(readonly connection: BrowserConnection) {
    connection.subscribe((update) => {
      if (update.kind !== "frame") return;
      if (update.message.type === "request_accepted") {
        const { rid } = update.message;
        this.#accepted.get(rid)?.();
        this.#accepted.delete(rid);
        return;
      }
      if (update.message.type !== "stream_start" && update.message.type !== "stream_chunk" && update.message.type !== "stream_end") return;
      const { rid, subagent } = update.message;
      if (typeof rid !== "string" || (subagent ?? null) !== null || !this.#active.has(rid) || this.#started.has(rid)) return;
      this.#started.add(rid);
      this.#set(new Set(this.#active));
    });
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): ReadonlySet<string> => this.#active;
  #set(active: ReadonlySet<string>): void { this.#active = active; for (const listener of this.#listeners) listener(); }
  #within(rid: string, scope: ConversationScope | undefined): boolean {
    if (scope === undefined) return true;
    const sent = this.#scopes.get(rid);
    return sent !== undefined && sent.character === scope.character && sent.thread === scope.thread;
  }
  async submit(name: "message" | "regen", values: Record<string, unknown>, { rid: chosen, accepted }: { rid?: string; accepted?: () => void } = {}): Promise<RequestFinished> {
    const request = conversationRequest(name, values);
    const { character, thread } = this.connection.selection;
    const { rid, finished } = this.connection.submit(request, chosen);
    this.#scopes.set(rid, { character, thread });
    if (name === "regen") this.#regens.add(rid);
    if (accepted !== undefined) this.#accepted.set(rid, accepted);
    this.#set(new Set([...this.#active, rid]));
    try { return await finished; } finally { this.#regens.delete(rid); this.#started.delete(rid); this.#scopes.delete(rid); this.#accepted.delete(rid); this.#set(new Set([...this.#active].filter((item) => item !== rid))); }
  }
  awaitingStream(scope?: ConversationScope): string | undefined { return [...this.#active].find((rid) => !this.#started.has(rid) && this.#within(rid, scope)); }
  regens(scope?: ConversationScope): readonly string[] { return [...this.#regens].filter((rid) => this.#within(rid, scope)); }
  pendingRegens(scope?: ConversationScope): readonly string[] { return this.regens(scope).filter((rid) => !this.#started.has(rid)); }
  async regenerate(guidance?: string, stream = true): Promise<void> {
    const result = await this.submit("regen", { stream, ...(guidance === undefined || guidance.trim() === "" ? {} : { guidance: guidance.trim() }) });
    if (result.outcome !== "completed") throw new Error(result.error?.message ?? (result.outcome === "cancelled" ? "Regeneration stopped" : `Regeneration ${result.outcome}`));
  }
  cancel(): void { this.connection.cancel(); }
}
