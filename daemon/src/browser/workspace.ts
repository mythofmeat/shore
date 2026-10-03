import { accumulateMetadata } from "./metadata.ts";
import type { StreamMetadata } from "../protocol/StreamMetadata.ts";
import type { SendImage } from "../protocol/SendImage.ts";
import { retainLiveImages, reconcileImages, type LiveImage } from "./media.ts";
import { MAX_LIVE_TEXT, MAX_LIVE_BLOCKS, MAX_LIVE_BLOCK_CHARS, recentText, recentItems, inspectionPreview } from "./live_limits.ts";
import type { CharacterInfo } from "../protocol/CharacterInfo.ts";
import type { ContentBlock } from "../protocol/ContentBlock.ts";
import type { History } from "../protocol/History.ts";
import type { Message } from "../protocol/Message.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { ConversationPage } from "../protocol/ConversationPage.ts";
import type { SegmentSummary } from "../protocol/SegmentSummary.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ThreadView } from "../protocol/ThreadView.ts";
import { BrowserConnection, type ConnectionUpdate } from "./connection.ts";
import { OperationClient } from "./operations.ts";

export function inspectableRequest(request: Extract<ConnectionUpdate, { kind: "uncertain" }>["request"]): Extract<ConnectionUpdate, { kind: "uncertain" }>["request"] {
  if (request.type !== "command" || request.name !== "config" || typeof request.args !== "object" || request.args === null || Array.isArray(request.args)) return request;
  return { ...request, args: { ...request.args, ...(Object.hasOwn(request.args, "value") ? { value: "<redacted>" } : {}) } };
}

export interface LiveRound { reasoning: string; text: string; tools: string[] }
export interface LiveTurn { key: string; rid: string | null; subagent: string | null; text: string; reasoning: string; blocks: ContentBlock[]; tools: string[]; round: LiveRound; final: boolean; msgId: string | null; metadata: StreamMetadata | null; previewLimited?: boolean; replaces?: string[] }
export const liveTurn = (key: string, rid: string | null, subagent: string | null): LiveTurn => ({ key, rid, subagent, text: "", reasoning: "", blocks: [], tools: [], round: { reasoning: "", text: "", tools: [] }, final: false, msgId: null, metadata: null });
export interface Activity { id: number; type: string; data: unknown; previewLimited: boolean }
export interface SegmentView { segment: SegmentSummary; previous: SegmentSummary | null; next: SegmentSummary | null; messages: Message[]; before: number; hasEarlier: boolean; seenLive: string | null }
export const SEGMENT_PAGE_TURNS = 32;
export interface WorkspaceSnapshot {
  characters: CharacterInfo[]; threads: ThreadView[]; operations: OperationDescriptor[]; requests: OperationDescriptor[];
  messages: Message[]; metadata: Record<string, StreamMetadata>; streams: LiveTurn[]; media: LiveImage[]; mediaLimited: boolean; activity: Activity[];
  config: unknown; error: string; status: string; detail: string;
  character: string | null; thread: string | null; previousSegment: SegmentSummary | null; segmentView: SegmentView | null; uncertain: Extract<ConnectionUpdate, { kind: "uncertain" }>[];
}

export const EVENT_POLICIES = {
  hello: "navigation", history: "conversation", new_message: "conversation",
  stream_start: "stream", stream_chunk: "stream", stream_end: "stream",
  tool_call: "stream", tool_result: "stream", send_image: "media",
  phase: "activity", command_output: "result", error: "warning",
  cache_warning: "warning", provider_warning: "warning", provider_fallback_warning: "warning",
  usage_warning: "warning", plan_limit_warning: "warning", config_warning: "warning", request_accepted: "completion", request_finished: "completion",
  ping: "connection", shutdown: "connection",
} satisfies Record<ServerMessage["type"], string>;

export function mergeHistory(previous: readonly Message[], history: History): Message[] | undefined {
  if (history.delta === undefined || history.delta === null) return history.messages;
  const index = history.delta.after === null ? -1 : previous.findLastIndex((message) => message.msg_id === history.delta?.after);
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

function neighbours(page: ConversationPage, segment: SegmentSummary): Pick<SegmentView, "segment" | "previous" | "next"> {
  return { segment, previous: page.previous_segment, next: page.next_segment };
}

export type FrameScheduler = (callback: () => void) => void;

export class Workspace {
  readonly actions: OperationClient;
  #listeners = new Set<() => void>();
  #frame: FrameScheduler;
  #framePending = false;
  #navigation = 0;
  #eventId = 0;
  #segmentEpoch = 0;
  #loadingEarlier = false;
  #state: WorkspaceSnapshot = { characters: [], threads: [], operations: [], requests: [], messages: [], metadata: {}, streams: [], media: [], mediaLimited: false, activity: [], config: {}, error: "", status: "idle", detail: "", character: null, thread: null, previousSegment: null, segmentView: null, uncertain: [] };
  constructor(readonly connection: BrowserConnection, frame: FrameScheduler = (callback) => { callback(); }) {
    this.#frame = frame;
    this.actions = new OperationClient(connection);
    connection.subscribe((update) => this.#receive(update));
  }
  getSnapshot = (): WorkspaceSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #patch(patch: Partial<WorkspaceSnapshot>, untilFrame = false): void {
    this.#state = { ...this.#state, ...patch };
    if (!untilFrame) { this.#notify(); return; }
    if (this.#framePending) return;
    this.#framePending = true;
    this.#frame(() => { if (this.#framePending) this.#notify(); });
  }
  #notify(): void {
    this.#framePending = false;
    for (const listener of this.#listeners) listener();
  }
  report(error: unknown): void { this.#patch({ error: error instanceof Error ? error.message : String(error) }); }
  dismissError(): void { this.#patch({ error: "" }); }
  acknowledge(rid: string): void { this.#patch({ uncertain: this.#state.uncertain.filter((item) => item.rid !== rid) }); }
  async openSegment(index: number): Promise<void> {
    const epoch = ++this.#segmentEpoch;
    const page = await this.actions.run("history_page", { segment: index, turns: SEGMENT_PAGE_TURNS });
    if (epoch !== this.#segmentEpoch || page.segment === null) return;
    this.#patch({ segmentView: { ...neighbours(page, page.segment), messages: page.messages, before: page.next_before, hasEarlier: page.has_more_before, seenLive: this.#state.messages.at(-1)?.msg_id ?? null } });
  }
  async openOlder(): Promise<void> {
    const view = this.#state.segmentView;
    const previous = view === null ? this.#state.previousSegment : view.previous;
    if (previous !== null) await this.openSegment(previous.index);
  }
  async openNewer(): Promise<void> {
    const next = this.#state.segmentView?.next ?? null;
    if (next === null) this.closeSegment();
    else await this.openSegment(next.index);
  }
  closeSegment(): void {
    this.#segmentEpoch += 1;
    if (this.#state.segmentView !== null) this.#patch({ segmentView: null });
  }
  async loadEarlierInSegment(): Promise<void> {
    const view = this.#state.segmentView;
    if (view === null || this.#loadingEarlier || !view.hasEarlier) return;
    this.#loadingEarlier = true;
    const epoch = this.#segmentEpoch;
    try {
      const page = await this.actions.run("history_page", { segment: view.segment.index, before: view.before, turns: SEGMENT_PAGE_TURNS });
      const current = this.#state.segmentView;
      if (epoch !== this.#segmentEpoch || current === null) return;
      const ids = new Set(current.messages.map((message) => message.msg_id));
      this.#patch({ segmentView: { ...current, messages: [...page.messages.filter((message) => !ids.has(message.msg_id)), ...current.messages], before: page.next_before, hasEarlier: page.has_more_before } });
    } finally { this.#loadingEarlier = false; }
  }
  async #refreshSegmentNeighbours(): Promise<void> {
    const view = this.#state.segmentView;
    if (view === null) return;
    const epoch = this.#segmentEpoch;
    try {
      const page = await this.actions.run("history_page", { segment: view.segment.index, count: 0 });
      const current = this.#state.segmentView;
      if (epoch === this.#segmentEpoch && current !== null && page.segment !== null) this.#patch({ segmentView: { ...current, ...neighbours(page, page.segment) } });
    } catch (error) { this.report(error); }
  }
  #activity(type: string, data: unknown): void {
    const preview = inspectionPreview(data);
    this.#patch({ activity: [...this.#state.activity.slice(-99), { id: ++this.#eventId, type, data: preview, previewLimited: preview !== data }] });
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
    const manual = this.actions.pendingOperation(message.rid) === "run_tool";
    const key = JSON.stringify([message.rid ?? null, message.subagent ?? null, message.task_id ?? null]);
    const current: LiveTurn = this.#state.streams.find((stream) => stream.key === key) ?? liveTurn(key, message.rid ?? null, message.subagent ?? null);
    const next = { ...current };
    let media = this.#state.media;
    let mediaLimited = this.#state.mediaLimited;
    switch (message.type) {
      case "stream_start":
        next.final = false;
        if (message.regen) next.replaces = message.replaces ?? [];
        break;
      case "stream_chunk": {
        if (message.content_type === "thinking") next.reasoning += message.text;
        else next.text += message.text;
        const round = next.round.tools.length > 0 ? { reasoning: "", text: "", tools: [] } : next.round;
        next.round = message.content_type === "thinking" ? { ...round, reasoning: round.reasoning + message.text } : { ...round, text: round.text + message.text };
        break;
      }
      case "stream_end":
        next.text = message.content;
        next.final = message.is_final;
        next.msgId = message.msg_id ?? null;
        next.metadata = accumulateMetadata(next.metadata, message.metadata);
        next.blocks = message.terminal_content_blocks ?? next.blocks;
        break;
      case "tool_call":
        next.blocks = [...next.blocks, { type: "tool_use", id: message.tool_id, name: message.tool_name, input: message.input }];
        next.tools = [...next.tools, message.tool_id];
        next.round = { ...next.round, tools: [...next.round.tools, message.tool_id] };
        break;
      case "tool_result":
        next.blocks = [...next.blocks, { type: "tool_result", tool_use_id: message.tool_id, content: message.output, is_error: message.is_error }];
        for (const image of message.images ?? []) {
          const original = media.find((item) => item.path === image.path);
          const sameRequest = (original?.rid ?? null) === (message.rid ?? null);
          const retained = retainLiveImages([...media.filter((item) => item.path !== image.path), { ...image, ...(manual ? { manual: true } : {}), rid: message.rid ?? null, subagent: message.subagent ?? null, task_id: message.task_id ?? null, toolId: message.tool_id, previewData: image.data, ...(sameRequest && original?.toolId === message.tool_id && original.messageId !== undefined ? { messageId: original.messageId } : {}), data: sameRequest ? original?.data ?? image.data ?? null : image.data ?? null }]);
          media = retained.items;
          mediaLimited ||= retained.limited;
        }
        break;
    }
    const text = recentText(next.text, MAX_LIVE_TEXT);
    const reasoning = recentText(next.reasoning, MAX_LIVE_TEXT);
    next.previewLimited ||= text !== next.text || reasoning !== next.reasoning;
    next.text = text;
    next.reasoning = reasoning;
    next.round = { ...next.round, text: recentText(next.round.text, MAX_LIVE_TEXT), reasoning: recentText(next.round.reasoning, MAX_LIVE_TEXT) };
    if (next.blocks !== current.blocks) {
      const retained = recentItems(next.blocks, MAX_LIVE_BLOCKS, MAX_LIVE_BLOCK_CHARS, (block) => JSON.stringify(block).length);
      next.blocks = retained.items;
      next.previewLimited ||= retained.limited;
    }
    const metadata = message.type === "stream_end" && message.is_final && next.subagent === null && next.msgId !== null && next.metadata !== null
      ? Object.fromEntries([...Object.entries(this.#state.metadata).filter(([id]) => id !== next.msgId), [next.msgId, next.metadata] as const].slice(-256)) : this.#state.metadata;
    this.#patch({ metadata, media, mediaLimited, streams: manual && next.subagent === null ? this.#state.streams : [...this.#state.streams.filter((stream) => stream.key !== key), next].slice(-32) }, message.type === "stream_chunk");
  }
  #receive(update: ConnectionUpdate): void {
    if (update.kind === "status") {
      if (update.status !== "ready") this.#navigation += 1;
      if (update.status === "signed_out") this.#segmentEpoch += 1;
      this.#patch({ status: update.status, detail: update.detail, streams: update.status === "ready" ? this.#state.streams : [], ...(update.status === "signed_out" ? { error: "", messages: [], metadata: {}, config: {}, media: [], mediaLimited: false, activity: [], operations: [], requests: [], threads: [], characters: [], uncertain: [], previousSegment: null, segmentView: null } : {}) });
      if (update.status === "ready") void this.refreshNavigation();
      return;
    }
    if (update.kind === "future") { this.#activity(`Future event: ${update.message.type}`, update.message); return; }
    if (update.kind === "uncertain") {
      this.#patch({ uncertain: [...this.#state.uncertain, { ...update, request: inspectableRequest(update.request) }], media: this.#state.media.filter((image) => image.rid !== update.rid || image.manual === true) });
      return;
    }
    const message = update.message;
    switch (message.type) {
      case "hello": this.#patch({ characters: message.characters }); return;
      case "history": {
        const messages = mergeHistory(this.#state.messages, message);
        if (messages === undefined) { this.connection.reconnect(); return; }
        const character = message.selected_character ?? null;
        const thread = message.selected_thread ?? null;
        const changed = character !== this.#state.character || thread !== this.#state.thread;
        const historyOnly = message.config !== null && typeof message.config === "object" && !Array.isArray(message.config) && Object.keys(message.config).length === 0;
        const full = message.delta === undefined || message.delta === null;
        const previousSegment = full ? message.previous_segment ?? null : this.#state.previousSegment;
        const moved = previousSegment?.index !== this.#state.previousSegment?.index;
        if (changed) this.#segmentEpoch += 1;
        this.#patch({ messages: changed ? messages : retainImages(messages, this.#state.messages, this.#state.media), media: changed ? [] : reconcileImages(this.#state.media, messages, this.#state.messages), previousSegment, segmentView: changed ? null : this.#state.segmentView,
          character, thread, mediaLimited: changed ? false : this.#state.mediaLimited, metadata: changed ? {} : Object.fromEntries(Object.entries(this.#state.metadata).filter(([id]) => messages.some((item) => item.msg_id === id))), config: !changed && historyOnly ? this.#state.config : message.config, streams: changed ? [] : this.#state.streams.filter((stream) => !stream.final || !messages.some((item) => item.msg_id === stream.msgId)) });
        if (changed && this.connection.status === "ready") void this.refreshNavigation();
        if (!changed && moved) void this.#refreshSegmentNeighbours();
        return;
      }
      case "new_message": {
        const exists = this.#state.messages.some((item) => item.msg_id === message.msg_id);
        if (exists) return;
        const messages = [...this.#state.messages, message];
        this.#patch({ messages: retainImages(messages, this.#state.messages, this.#state.media), media: reconcileImages(this.#state.media, messages, this.#state.messages) }); return;
      }
      case "stream_start": case "stream_chunk": case "stream_end": case "tool_call": case "tool_result":
        this.#stream(message);
        if (message.type !== "stream_chunk") this.#activity(message.type, message);
        return;
      case "error": this.report(message.message); this.#activity(message.type, message); return;
      case "request_finished":
        if (message.outcome !== "completed" || this.actions.pendingOperation(message.rid) === "run_tool") this.#patch({ streams: this.#state.streams.filter((stream) => stream.rid !== message.rid) });
        if (this.#state.uncertain.some((item) => item.rid === message.rid)) {
          this.acknowledge(message.rid);
          if (message.outcome === "failed") this.report(message.error?.message ?? "A request that was in flight when the connection dropped failed.");
        }
        this.#activity(message.type, message); return;
      case "send_image": {
        const previous = this.#state.media.find((image) => image.path === message.path);
        const sameRequest = (previous?.rid ?? null) === (message.rid ?? null);
        const retained = retainLiveImages([...this.#state.media.filter((image) => image.path !== message.path), { ...(sameRequest ? previous : {}), ...message, ...(this.actions.pendingOperation(message.rid) === "run_tool" ? { manual: true } : {}), data: message.data ?? (sameRequest ? previous?.data : null) ?? null }]);
        this.#patch({ media: retained.items, mediaLimited: this.#state.mediaLimited || retained.limited });
        this.#activity(message.type, message); return;
      }
      case "command_output": case "phase": case "cache_warning": case "provider_warning": case "request_accepted":
      case "provider_fallback_warning": case "usage_warning": case "plan_limit_warning": case "config_warning": case "shutdown":
        this.#activity(message.type, message); break;
      case "ping": break;
    }
  }
}
