import type { BrowserConnection } from "../connection.ts";
import type { RequestFinished } from "../../protocol/RequestFinished.ts";
import { conversationRequest } from "../request_forms.ts";

export interface ConversationScope { character: string | null; thread: string | null }

interface Sent { scope: ConversationScope; regen: boolean; accepted: (() => void) | undefined; started: boolean }

export class ConversationRequests {
  #active: ReadonlySet<string> = new Set();
  readonly #sent = new Map<string, Sent>();
  readonly #listeners = new Set<() => void>();
  constructor(readonly connection: BrowserConnection) {
    connection.subscribe((update) => {
      if (update.kind !== "frame") return;
      const message = update.message;
      if (message.type === "request_accepted") {
        const sent = this.#sent.get(message.rid);
        sent?.accepted?.();
        if (sent !== undefined) sent.accepted = undefined;
      }
      if (message.type !== "stream_start" && message.type !== "stream_chunk" && message.type !== "stream_end") return;
      const sent = typeof message.rid === "string" ? this.#sent.get(message.rid) : undefined;
      if (sent === undefined || (message.subagent ?? null) !== null || sent.started) return;
      sent.started = true;
      this.#set(new Set(this.#active));
    });
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): ReadonlySet<string> => this.#active;
  #set(active: ReadonlySet<string>): void { this.#active = active; for (const listener of this.#listeners) listener(); }
  #within(rid: string, scope: ConversationScope | undefined): boolean {
    if (scope === undefined) return true;
    const sent = this.#sent.get(rid)?.scope;
    return sent !== undefined && sent.character === scope.character && sent.thread === scope.thread;
  }
  async submit(name: "message" | "regen", values: Record<string, unknown>, { rid: chosen, accepted }: { rid?: string; accepted?: () => void } = {}): Promise<RequestFinished> {
    const request = conversationRequest(name, values);
    const { character, thread } = this.connection.selection;
    const { rid, finished } = this.connection.submit(request, chosen);
    this.#sent.set(rid, { scope: { character, thread }, regen: name === "regen", accepted, started: false });
    this.#set(new Set([...this.#active, rid]));
    try { return await finished; } finally { this.#sent.delete(rid); this.#set(new Set([...this.#active].filter((item) => item !== rid))); }
  }
  activeIn(scope: ConversationScope): boolean { return [...this.#active].some((rid) => this.#within(rid, scope)); }
  awaitingStream(scope?: ConversationScope): string | undefined { return [...this.#active].find((rid) => this.#sent.get(rid)?.started === false && this.#within(rid, scope)); }
  regens(scope?: ConversationScope): readonly string[] { return [...this.#sent].filter(([rid, sent]) => sent.regen && this.#within(rid, scope)).map(([rid]) => rid); }
  pendingRegens(scope?: ConversationScope): readonly string[] { return this.regens(scope).filter((rid) => this.#sent.get(rid)?.started === false); }
  async regenerate(guidance?: string, stream = true): Promise<void> {
    const result = await this.submit("regen", { stream, ...(guidance === undefined || guidance.trim() === "" ? {} : { guidance: guidance.trim() }) });
    if (result.outcome !== "completed") throw new Error(result.error?.message ?? (result.outcome === "cancelled" ? "Regeneration stopped" : `Regeneration ${result.outcome}`));
  }
  cancel(): void { this.connection.cancel(); }
}
