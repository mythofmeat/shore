import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { SessionMeta } from "../swp/session.ts";
import type { WebRequestInfo } from "../protocol/WebRequestInfo.ts";
import type { WebRequestList } from "../protocol/WebRequestList.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import { commandCatalogue } from "../commands/registry.ts";
import { changesState } from "../operations/policy.ts";
import { validWebRequestInfo } from "./contracts.ts";
import type { WebSession, WebSessions } from "./auth.ts";
import type { WebRecovery } from "./recovery.ts";

export const REQUEST_HISTORY_LIMITS = { perSession: 32, total: 256, resultBytes: 64 * 1024 } as const;
const catalogue = new Map<string, OperationDescriptor>(commandCatalogue().map((operation) => [operation.name, operation]));

export class RequestHistoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface SavedRequest { owner: string; info: WebRequestInfo }

export interface SettledRequest { readonly owner: string; readonly finished: Extract<ServerMessage, { type: "request_finished" }> }

export class RequestHistory {
  readonly #records = new Map<string, SavedRequest>();
  readonly #live = new Map<string, string>();
  #sessions: WebSessions | undefined;
  constructor(readonly recovery?: WebRecovery) {}

  restore(sessions: WebSessions): void {
    this.#sessions = sessions;
    for (const saved of this.recovery?.requests() ?? []) {
      if (sessions.get(saved.owner) === undefined || saved.info.expires_at <= Date.now()) { this.recovery?.removeRequest(saved.info.id); continue; }
      const info = saved.info.phase === "running" ? { ...saved.info, phase: "uncertain" as const } : saved.info;
      this.#save(saved.owner, info);
    }
    this.#prune();
  }

  #save(owner: string, info: WebRequestInfo): void {
    if (!validWebRequestInfo(info)) throw new Error("Invalid browser request record");
    this.recovery?.saveRequest(owner, info);
    this.#records.set(info.id, { owner, info: structuredClone(info) });
  }

  #remove(id: string): void {
    this.recovery?.removeRequest(id);
    this.#records.delete(id);
    for (const [key, live] of this.#live) if (live === id) this.#live.delete(key);
  }

  #prune(): void {
    for (const [id, record] of this.#records) {
      if (record.info.expires_at <= Date.now() || this.#sessions?.get(record.owner) === undefined) this.#remove(id);
    }
  }

  #authorize(session: WebSession): void {
    if (session.signal.aborted || session.expiresAt <= Date.now() || this.#sessions?.get(session.id) !== session) throw new RequestHistoryError(401, "Sign in again");
  }

  list(session: WebSession): WebRequestList {
    this.#authorize(session);
    this.#prune();
    return { requests: [...this.#records.values()].filter((row) => row.owner === session.id).map((row) => structuredClone(row.info)).sort((a, b) => b.started_at - a.started_at), max_records: REQUEST_HISTORY_LIMITS.perSession, max_result_bytes: REQUEST_HISTORY_LIMITS.resultBytes };
  }

  acknowledge(session: WebSession, id: string): void {
    this.#authorize(session);
    this.#prune();
    const record = this.#records.get(id);
    if (record?.owner !== session.id) throw new RequestHistoryError(404, "Request outcome missing or expired");
    if (record.info.phase === "running") throw new RequestHistoryError(409, "Wait for this request to finish before dismissing it");
    this.#remove(id);
  }

  begin(session: WebSession, selected: SessionMeta, message: Exclude<ClientMessage, { type: "hello" | "cancel" }>): string | undefined {
    this.#authorize(session);
    this.#prune();
    let label: string;
    let operation: string;
    if (message.type === "command") {
      const descriptor = catalogue.get(message.name);
      if (descriptor === undefined) return undefined;
      const input = typeof message.args === "object" && message.args !== null && !Array.isArray(message.args) ? message.args as Record<string, unknown> : {};
      if (!changesState(descriptor, input)) return undefined;
      operation = message.name; label = descriptor.label;
    } else { operation = message.type; label = message.type === "message" ? "Send message" : "Regenerate response"; }
    if (typeof message.rid !== "string") throw new RequestHistoryError(400, "A request needs a correlation ID");
    const owned = [...this.#records.values()].filter((row) => row.owner === session.id);
    if (owned.some((row) => row.info.rid === message.rid)) throw new RequestHistoryError(409, "This request ID already has an outcome; inspect it before starting a new action");
    const terminal = [...this.#records.values()].filter((row) => row.info.phase !== "running" && row.info.phase !== "uncertain").sort((a, b) => a.info.started_at - b.info.started_at);
    let ownCount = owned.length;
    for (const row of terminal) {
      if (ownCount < REQUEST_HISTORY_LIMITS.perSession && this.#records.size < REQUEST_HISTORY_LIMITS.total) break;
      if (ownCount >= REQUEST_HISTORY_LIMITS.perSession && row.owner !== session.id) continue;
      this.#remove(row.info.id);
      if (row.owner === session.id) ownCount -= 1;
    }
    if (ownCount >= REQUEST_HISTORY_LIMITS.perSession || this.#records.size >= REQUEST_HISTORY_LIMITS.total) throw new RequestHistoryError(429, "Review and dismiss earlier uncertain requests before starting another action");
    const info: WebRequestInfo = { id: crypto.randomUUID(), rid: message.rid, operation, label,
      character: selected.selectedCharacter, thread: selected.selectedThread, started_at: Date.now(),
      expires_at: session.expiresAt, phase: "running", result_omitted: false };
    this.#save(session.id, info);
    this.#live.set(JSON.stringify([selected.sessionId, info.rid]), info.id);
    return info.id;
  }

  settle(sessionId: number, message: ServerMessage): SettledRequest | undefined {
    if ((message.type !== "command_output" && message.type !== "request_finished") || typeof message.rid !== "string") return undefined;
    const key = JSON.stringify([sessionId, message.rid]);
    const id = this.#live.get(key);
    const record = id === undefined ? undefined : this.#records.get(id);
    if (record === undefined) return undefined;
    if (message.type === "request_finished") this.#live.delete(key);
    if (this.#sessions?.get(record.owner) === undefined) return undefined;
    this.#apply(record, message);
    return message.type === "request_finished" ? { owner: record.owner, finished: message } : undefined;
  }

  #apply(record: SavedRequest, message: ServerMessage): void {
    if (record.info.expires_at <= Date.now()) return;
    const info = record.info;
    if (message.type === "command_output" && message.rid === info.rid) {
      const result = { name: message.name, data: message.data };
      const candidate = { ...info, result };
      if (info.result !== undefined || info.result_omitted || message.name !== info.operation || Buffer.byteLength(JSON.stringify(result)) > REQUEST_HISTORY_LIMITS.resultBytes || !validWebRequestInfo(candidate)) {
        const { result: _previous, ...withoutResult } = info;
        this.#store(record.owner, { ...withoutResult, result_omitted: true });
      } else this.#store(record.owner, candidate);
    }
    if (message.type === "request_finished" && message.rid === info.rid) {
      const error = message.error === undefined || message.error === null ? undefined : { ...message.error, message: message.error.message.slice(0, 4096) };
      this.#store(record.owner, { ...info, phase: message.outcome, ...(error === undefined ? {} : { error }) });
    }
  }

  #store(owner: string, info: WebRequestInfo): void {
    try { this.#save(owner, info); }
    catch { this.#records.set(info.id, { owner, info: structuredClone(info) }); }
  }

  interrupt(session: WebSession, id: string): void {
    const record = this.#records.get(id);
    if (record?.owner !== session.id || record.info.phase !== "running" || session.signal.aborted) return;
    this.#store(record.owner, { ...record.info, phase: "uncertain" });
  }
}
