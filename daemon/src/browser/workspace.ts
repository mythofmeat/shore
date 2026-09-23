import { accumulateMetadata } from "./metadata.ts";
import type { StreamMetadata } from "../protocol/StreamMetadata.ts";
import type { SendImage } from "../protocol/SendImage.ts";
import { MAX_LIVE_IMAGES, reconcileImages, type LiveImage } from "./media.ts";
import type { CharacterInfo } from "../protocol/CharacterInfo.ts";
import type { ContentBlock } from "../protocol/ContentBlock.ts";
import type { History } from "../protocol/History.ts";
import type { Message } from "../protocol/Message.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ThreadView } from "../protocol/ThreadView.ts";
import { BrowserConnection, type ConnectionUpdate } from "./connection.ts";
import { OperationClient } from "./operations.ts";

export function inspectableRequest(request: Extract<ConnectionUpdate, { kind: "uncertain" }>["request"]): Extract<ConnectionUpdate, { kind: "uncertain" }>["request"] {
  if (request.type !== "command" || request.name !== "config" || typeof request.args !== "object" || request.args === null || Array.isArray(request.args)) return request;
  return { ...request, args: { ...request.args, ...(Object.hasOwn(request.args, "value") ? { value: "<redacted>" } : {}) } };
}

export interface LiveTurn { key: string; rid: string | null; subagent: string | null; text: string; reasoning: string; blocks: ContentBlock[]; final: boolean; msgId: string | null; metadata: StreamMetadata | null }
export interface Activity { id: number; type: string; data: unknown }
export interface WorkspaceSnapshot {
  characters: CharacterInfo[]; threads: ThreadView[]; operations: OperationDescriptor[]; requests: OperationDescriptor[];
  messages: Message[]; metadata: Record<string, StreamMetadata>; activeStart: number; streams: LiveTurn[]; media: LiveImage[]; activity: Activity[];
  config: unknown; error: string; status: string; detail: string;
  character: string | null; thread: string | null; hasEarlier: boolean; uncertain: Extract<ConnectionUpdate, { kind: "uncertain" }>[];
}

export const EVENT_POLICIES = {
  hello: "navigation", history: "conversation", new_message: "conversation",
  stream_start: "stream", stream_chunk: "stream", stream_end: "stream",
  tool_call: "stream", tool_result: "stream", send_image: "media",
  phase: "activity", command_output: "result", error: "warning",
  cache_warning: "warning", provider_warning: "warning", provider_fallback_warning: "warning",
  usage_warning: "warning", config_warning: "warning", request_finished: "completion",
  ping: "connection", shutdown: "connection",
} satisfies Record<ServerMessage["type"], string>;

export function mergeHistory(previous: readonly Message[], activeStart: number, history: History): Message[] | undefined {
  if (history.delta === undefined || history.delta === null) return history.messages;
  const index = history.delta.after === null ? activeStart - 1 : previous.findLastIndex((message) => message.msg_id === history.delta?.after);
  if (history.delta.after !== null && index < 0) return undefined;
  return [...previous.slice(0, index + 1), ...retainImages(history.messages, previous)];
}

function retainImages(messages: readonly Message[], previous: readonly Message[], live: readonly SendImage[] = []): Message[] {
  const images = new Map([...previous.flatMap((message) => message.images), ...live].filter((image) => image.data !== undefined && image.data !== null).map((image) => [image.path, image.data]));
  return messages.map((message) => ({ ...message, images: message.images.map((image) => {
    const data = image.data ?? images.get(image.path);
    return data === undefined || data === null ? image : { ...image, data };
  }) }));
}

export class Workspace {
  readonly actions: OperationClient;
  #listeners = new Set<() => void>();
  #navigation = 0;
  #eventId = 0;
  #historyEpoch = 0;
  #before: number | "active" = "active";
  #loadingEarlier = false;
  #state: WorkspaceSnapshot = { characters: [], threads: [], operations: [], requests: [], messages: [], metadata: {}, activeStart: 0, streams: [], media: [], activity: [], config: {}, error: "", status: "idle", detail: "", character: null, thread: null, hasEarlier: true, uncertain: [] };
  constructor(readonly connection: BrowserConnection) {
    this.actions = new OperationClient(connection);
    connection.subscribe((update) => this.#receive(update));
  }
  getSnapshot = (): WorkspaceSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #patch(patch: Partial<WorkspaceSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  report(error: unknown): void { this.#patch({ error: error instanceof Error ? error.message : String(error) }); }
  dismissError(): void { this.#patch({ error: "" }); }
  acknowledge(rid: string): void { this.#patch({ uncertain: this.#state.uncertain.filter((item) => item.rid !== rid) }); }
  addEarlier(messages: Message[]): void {
    const ids = new Set(this.#state.messages.map((message) => message.msg_id));
    const earlier = messages.filter((message) => !ids.has(message.msg_id));
    this.#patch({ messages: [...earlier, ...this.#state.messages], activeStart: this.#state.activeStart + earlier.length });
  }
  async loadEarlier(): Promise<void> {
    if (this.#loadingEarlier || !this.#state.hasEarlier) return;
    this.#loadingEarlier = true;
    const epoch = this.#historyEpoch;
    try {
      const page = await this.actions.run("history_page", { before: this.#before, turns: 32 });
      if (epoch !== this.#historyEpoch) return;
      this.#before = page.next_before;
      this.addEarlier(page.messages);
      this.#patch({ hasEarlier: page.has_more_before });
    } finally { this.#loadingEarlier = false; }
  }
  #activity(type: string, data: unknown): void {
    this.#patch({ activity: [...this.#state.activity.slice(-99), { id: ++this.#eventId, type, data }] });
  }
  async refreshNavigation(): Promise<void> {
    const generation = ++this.#navigation;
    try {
      const catalogue = await this.actions.run("discover_operations", {});
      const characters = await this.actions.run("list_characters", {});
      const threads = catalogue.operations.find((operation) => operation.name === "list_threads")?.available === true ? (await this.actions.run("list_threads", {})).threads : [];
      if (generation === this.#navigation) this.#patch({ operations: catalogue.operations, requests: catalogue.requests, characters: characters.characters, threads });
    } catch (error) { if (generation === this.#navigation && this.connection.status === "ready") this.report(error); }
  }
  #stream(message: Extract<ServerMessage, { type: "stream_start" | "stream_chunk" | "stream_end" | "tool_call" | "tool_result" }>): void {
    const key = JSON.stringify([message.rid ?? null, message.subagent ?? null, message.task_id ?? null]);
    const current = this.#state.streams.find((stream) => stream.key === key) ?? { key, rid: message.rid ?? null, subagent: message.subagent ?? null, text: "", reasoning: "", blocks: [], final: false, msgId: null, metadata: null };
    const next = { ...current };
    let media = this.#state.media;
    switch (message.type) {
      case "stream_start": next.final = false; break;
      case "stream_chunk":
        if (message.content_type === "thinking") next.reasoning += message.text;
        else next.text += message.text;
        break;
      case "stream_end":
        next.text = message.content;
        next.final = message.is_final;
        next.msgId = message.msg_id ?? null;
        next.metadata = accumulateMetadata(next.metadata, message.metadata);
        next.blocks = message.terminal_content_blocks ?? next.blocks;
        break;
      case "tool_call": next.blocks = [...next.blocks, { type: "tool_use", id: message.tool_id, name: message.tool_name, input: message.input }]; break;
      case "tool_result":
        next.blocks = [...next.blocks, { type: "tool_result", tool_use_id: message.tool_id, content: message.output, is_error: message.is_error }];
        for (const image of message.images ?? []) {
          const original = media.find((item) => item.path === image.path);
          const sameRequest = (original?.rid ?? null) === (message.rid ?? null);
          media = [...media.filter((item) => item.path !== image.path), { ...image, rid: message.rid ?? null, subagent: message.subagent ?? null, task_id: message.task_id ?? null, toolId: message.tool_id, previewData: image.data, ...(sameRequest && original?.toolId === message.tool_id && original.messageId !== undefined ? { messageId: original.messageId } : {}), data: sameRequest ? original?.data ?? image.data ?? null : image.data ?? null }].slice(-MAX_LIVE_IMAGES);
        }
        break;
    }
    const metadata = message.type === "stream_end" && message.is_final && next.subagent === null && next.msgId !== null && next.metadata !== null
      ? Object.fromEntries([...Object.entries(this.#state.metadata).filter(([id]) => id !== next.msgId), [next.msgId, next.metadata] as const].slice(-256)) : this.#state.metadata;
    this.#patch({ metadata, media, streams: [...this.#state.streams.filter((stream) => stream.key !== key), next].slice(-32) });
  }
  #receive(update: ConnectionUpdate): void {
    if (update.kind === "status") {
      if (update.status !== "ready") this.#navigation += 1;
      this.#patch({ status: update.status, detail: update.detail, ...(update.status === "signed_out" ? { messages: [], metadata: {}, config: {}, streams: [], media: [], activity: [], operations: [], requests: [], threads: [], characters: [], uncertain: [] } : {}) });
      if (update.status === "ready") void this.refreshNavigation();
      return;
    }
    if (update.kind === "future") { this.#activity(`Future event: ${update.message.type}`, update.message); return; }
    if (update.kind === "uncertain") { this.#patch({ uncertain: [...this.#state.uncertain, { ...update, request: inspectableRequest(update.request) }] }); return; }
    const message = update.message;
    switch (message.type) {
      case "hello": this.#patch({ characters: message.characters }); return;
      case "history": {
        const messages = mergeHistory(this.#state.messages, this.#state.activeStart, message);
        if (messages === undefined) { this.connection.reconnect(); return; }
        const character = message.selected_character ?? null;
        const thread = message.selected_thread ?? null;
        const changed = character !== this.#state.character || thread !== this.#state.thread;
        if (message.delta === undefined || message.delta === null) { this.#historyEpoch += 1; this.#before = "active"; }
        this.#patch({ messages: changed ? messages : retainImages(messages, this.#state.messages, this.#state.media), media: changed ? [] : reconcileImages(this.#state.media, messages, this.#state.messages), activeStart: message.delta === undefined || message.delta === null ? message.active_start ?? 0 : this.#state.activeStart,
          character, thread, metadata: changed ? {} : Object.fromEntries(Object.entries(this.#state.metadata).filter(([id]) => messages.some((item) => item.msg_id === id))), config: message.config, hasEarlier: message.delta === undefined || message.delta === null ? true : this.#state.hasEarlier, streams: changed ? [] : this.#state.streams.filter((stream) => !stream.final || !messages.some((item) => item.msg_id === stream.msgId)) });
        if (changed && this.connection.status === "ready") void this.refreshNavigation();
        return;
      }
      case "new_message": {
        const exists = this.#state.messages.some((item) => item.msg_id === message.msg_id);
        const messages = exists ? this.#state.messages.map((item) => item.msg_id === message.msg_id ? message : item) : [...this.#state.messages, message];
        this.#patch({ messages: retainImages(messages, this.#state.messages, this.#state.media), media: reconcileImages(this.#state.media, messages, this.#state.messages) }); return;
      }
      case "stream_start": case "stream_chunk": case "stream_end": case "tool_call": case "tool_result":
        this.#stream(message);
        if (message.type !== "stream_chunk") this.#activity(message.type, message);
        return;
      case "error": this.report(message.message); this.#activity(message.type, message); return;
      case "request_finished":
        if (message.outcome !== "completed") this.#patch({ streams: this.#state.streams.filter((stream) => stream.rid !== message.rid) });
        this.#activity(message.type, message); return;
      case "send_image": {
        const previous = this.#state.media.find((image) => image.path === message.path);
        const sameRequest = (previous?.rid ?? null) === (message.rid ?? null);
        this.#patch({ media: [...this.#state.media.filter((image) => image.path !== message.path), { ...(sameRequest ? previous : {}), ...message, data: message.data ?? (sameRequest ? previous?.data : null) ?? null }].slice(-MAX_LIVE_IMAGES) });
        this.#activity(message.type, message); return;
      }
      case "command_output": case "phase": case "cache_warning": case "provider_warning":
      case "provider_fallback_warning": case "usage_warning": case "config_warning": case "shutdown":
        this.#activity(message.type, message); break;
      case "ping": break;
    }
  }
}
