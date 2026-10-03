import { registerConversation, withConversation } from "./lifecycle.ts";
import { threadFile } from "../storage/files.ts";

import { join, dirname } from "node:path";

import {
  archiveKey,
  MAIN_THREAD,
  threadDataDir,
} from "../config/dirs.ts";

import { HISTORY_DB_FILE } from "./history_store.ts";
import { toolLoopGroups, mergeToolLoopMessages } from "./merge";
import { MessageStore, type AltSelection, type PendingAlt } from "./message_store";
import { SegmentReader, presentSegment, type SegmentRecord } from "./segments";
import type { Message } from "./types";
import type { SegmentSummary } from "../protocol/SegmentSummary.ts";
import { imageDataForPath, embedMessagesImageData } from "./wire_images";


export interface History {
  rid?: string;
  messages: Message[];
  previous_segment?: SegmentSummary;
  config: unknown;
  selected_character?: string;
  selected_thread?: string;
  revision: number;
  delta?: { base_revision: number; after: string | null };
}

export type HistoryListener = (history: History) => void;

export type HistoryPageLimit =
  | { kind: "count"; value: number }
  | { kind: "turns"; value: number };

interface HistoryPageMetrics {
  segments_read: number;
  rows_read: number;
  decoded_body_bytes: number;
  page_bytes: number;
}

export type HistoryScope = "current" | number;

export interface DisplayHistoryPage {
  messages: Message[];
  cursor: number;
  hasMoreBefore: boolean;
  totalTurns: number;
  segment: SegmentRecord | undefined;
  previousSegment: SegmentRecord | undefined;
  nextSegment: SegmentRecord | undefined;
  metrics: HistoryPageMetrics;
}

const historyEncoder = new TextEncoder();

export class ConversationEngine {
  readonly #characterName: string;
  readonly #thread: string;
  readonly #conversationDir: string;
  readonly #historyDbPath: string;
  #messages: MessageStore;
  #segments: SegmentReader;
  #revision = 0;
  #tailStart = 0;
  #tailAnchor: string | null = null;
  readonly #deltaImages = new Map<string, string>();
  readonly #onHistory: HistoryListener | undefined;

  private constructor(
    characterName: string,
    thread: string,
    conversationDir: string,
    historyDbPath: string,
    messages: MessageStore,
    segments: SegmentReader,
    onHistory: HistoryListener | undefined,
  ) {
    this.#characterName = characterName;
    this.#thread = thread;
    this.#conversationDir = conversationDir;
    this.#historyDbPath = historyDbPath;
    this.#messages = messages;
    this.#segments = segments;
    this.#onHistory = onHistory;
    registerConversation(conversationDir, this);
    this.#resetTail();
  }

  static async load(
    characterName: string,
    dataDir: string,
    onHistory?: HistoryListener,
    thread: string = MAIN_THREAD,
  ): Promise<ConversationEngine> {
    const conversationDir = threadDataDir(dataDir, characterName, thread);
    const historyDbPath = join(dataDir, HISTORY_DB_FILE);
    const messages = await MessageStore.load(threadFile(dataDir, characterName, thread, "active.jsonl"));
    const segments = await SegmentReader.load({
      dir: conversationDir,
      dbPath: historyDbPath,
      archiveKey: archiveKey(characterName, thread),
      createHistoryDb: true,
    });
    return new ConversationEngine(
      characterName,
      thread,
      conversationDir,
      historyDbPath,
      messages,
      segments,
      onHistory,
    );
  }

  get characterName(): string {
    return this.#characterName;
  }

  get thread(): string {
    return this.#thread;
  }

  get conversationDir(): string {
    return this.#conversationDir;
  }

  messages(): readonly Message[] {
    return this.#messages.messages();
  }

  messageCount(): number {
    return this.#messages.messageCount();
  }

  turnCount(): number {
    return this.#messages.turnCount();
  }

  startedAt(): string | undefined {
    return this.#messages.startedAt();
  }

  segments(): SegmentReader {
    return this.#segments;
  }

  currentRevision(): number {
    return this.#revision;
  }

  messagesThroughLastUserTurn(): Message[] {
    return this.#messages.messagesThroughLastUserTurn();
  }

  messagesAfterLastUserTurn(): Message[] {
    return this.#messages.messagesAfterLastUserTurn();
  }

  pendingRegenAlt(): PendingAlt | undefined {
    return this.#messages.pendingRegenAlt();
  }

  displayHistoryPage(
    scope: HistoryScope,
    before: number | undefined,
    limit: HistoryPageLimit,
  ): DisplayHistoryPage | undefined {
    return scope === "current" ? this.#currentPage(before, limit) : this.#segmentPage(scope, before, limit);
  }

  #currentPage(before: number | undefined, limit: HistoryPageLimit): DisplayHistoryPage {
    const active = mergeToolLoopMessages([...this.#messages.messages()]);
    const end = Math.min(before ?? active.length, active.length);
    const start =
      limit.kind === "count"
        ? Math.max(0, end - limit.value)
        : activeStartForTurns(active, end, limit.value);
    const messages = active.slice(start, end);
    return {
      messages,
      cursor: start,
      hasMoreBefore: start > 0,
      totalTurns: countUserTurns(active),
      segment: undefined,
      previousSegment: this.#segments.latestEntry(),
      nextSegment: undefined,
      metrics: {
        segments_read: 0,
        rows_read: 0,
        decoded_body_bytes: 0,
        page_bytes: encodedMessageBytes(messages),
      },
    };
  }

  #segmentPage(
    index: number,
    before: number | undefined,
    limit: HistoryPageLimit,
  ): DisplayHistoryPage | undefined {
    const segment = this.#segments.entry(index);
    if (segment === undefined) return undefined;
    const bounds = this.#segments.displayBounds(index) ?? { start: 0, end: 0 };
    const end = Math.min(Math.max(before ?? bounds.end, bounds.start), bounds.end);
    const start = Math.max(
      bounds.start,
      limit.kind === "count" ? end - limit.value : this.#segments.startForTurns(index, end, limit.value),
    );
    const slice = this.#segments.readDisplayRange(index, start, end);
    const messages = mergeToolLoopMessages(slice.messages);
    return {
      messages,
      cursor: start,
      hasMoreBefore: start > bounds.start,
      totalTurns: this.#segments.turnCount(index),
      segment,
      previousSegment: this.#segments.entryBefore(index),
      nextSegment: this.#segments.entryAfter(index),
      metrics: {
        ...slice.metrics,
        page_bytes: encodedMessageBytes(messages),
      },
    };
  }

  async appendMessage(msg: Message): Promise<void> {
    return await withConversation(this.#conversationDir, "update", async () => {
      await this.#messages.append(msg);
      this.#advanceRevision();
      this.#broadcastDelta();
    });
  }

  async recoverInterruptedToolLoop(): Promise<number> {
    return await withConversation(this.#conversationDir, "update", async () => {
      const recovered = await this.#messages.recoverInterruptedToolLoop(
        `m_${crypto.randomUUID()}`,
        new Date().toISOString(),
      );
      if (recovered > 0) {
        this.#advanceRevision();
        this.broadcastHistory();
      }
      return recovered;
    });
  }

  async editMessage(msgId: string, newContent: string): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.edit(msgId, newContent);
      this.#advanceRevision();
      this.broadcastHistory();
    });
  }

  async deleteMessages(msgIds: readonly string[]): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.deleteAll(msgIds);
      this.#advanceRevision();
      this.broadcastHistory();
    });
  }

  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const messages = this.#messages.messages();
      this.#tailStart = messages.length - this.#messages.messagesAfterLastUserTurn().length;
      this.#tailAnchor = messages[this.#tailStart - 1]?.msg_id ?? null;
      const removed = await this.#messages.replaceAfterLastUserTurn(newMessages);
      this.#advanceRevision();
      this.#broadcastDelta();
      return removed;
    });
  }

  async selectAlt(msgId: string, index: number): Promise<AltSelection> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const selection = await this.#messages.selectAlt(msgId, index);
      this.#advanceRevision();
      this.broadcastHistory();
      return selection;
    });
  }

  async reload(): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      this.#messages = await MessageStore.load(threadFile(dirname(this.#historyDbPath), this.#characterName, this.#thread, "active.jsonl"));
      this.#segments.close();
      this.#segments = await SegmentReader.load({
        dir: this.#conversationDir,
        dbPath: this.#historyDbPath,
        archiveKey: archiveKey(this.#characterName, this.#thread),
        createHistoryDb: true,
      });
      this.#advanceRevision();
      this.broadcastHistory();
    });
  }

  historySnapshot(config: unknown): History {
    const messages = structuredClone(mergeToolLoopMessages([...this.#messages.messages()]));
    embedMessagesImageData(messages);
    const previous = this.#segments.latestEntry();
    const history: History = {
      messages,
      ...(previous === undefined ? {} : { previous_segment: presentSegment(previous) }),
      config,
      selected_character: this.#characterName,
      selected_thread: this.#thread,
      revision: this.#revision,
    };
    return history;
  }

  broadcastHistory(): void {
    this.#resetTail();
    this.#onHistory?.(this.historySnapshot({}));
  }

  #resetTail(): void {
    this.#deltaImages.clear();
    const messages = this.#messages.messages();
    const groups = toolLoopGroups(messages);
    const tail = groups.at(-1)?.[0];
    this.#tailStart = tail === undefined ? 0 : messages.lastIndexOf(tail);
    const previous = groups.at(-2);
    this.#tailAnchor = previous === undefined ? null : mergeToolLoopMessages(previous)[0]?.msg_id ?? null;
  }

  #broadcastDelta(): void {
    const messages = this.#messages.messages();
    const suffix = messages.slice(this.#tailStart);
    const groups = toolLoopGroups(suffix);
    const merged = mergeToolLoopMessages(suffix);
    if (this.#onHistory !== undefined) {
      const outgoing = structuredClone(merged);
      const paths = new Set<string>();
      for (const message of outgoing) {
        for (const image of [...message.images, ...(message.alternatives ?? []).flatMap(alt => alt.images)]) {
          paths.add(image.path);
          const data = image.data ?? this.#deltaImages.get(image.path) ?? imageDataForPath(image.path);
          if (data !== undefined) { image.data = data; this.#deltaImages.set(image.path, data); }
        }
      }
      for (const path of this.#deltaImages.keys()) if (!paths.has(path)) this.#deltaImages.delete(path);
      this.#onHistory({
        messages: outgoing, config: {}, selected_character: this.#characterName,
        selected_thread: this.#thread, revision: this.#revision,
        delta: { base_revision: this.#revision - 1, after: this.#tailAnchor },
      });
    }
    const tail = groups.at(-1)?.[0];
    if (tail !== undefined) this.#tailStart = messages.lastIndexOf(tail);
    if (merged.length > 1) this.#tailAnchor = merged.at(-2)?.msg_id ?? this.#tailAnchor;
  }

  #advanceRevision(): void {
    this.#revision += 1;
  }

}

function activeStartForTurns(active: readonly Message[], end: number, turns: number): number {
  if (turns === 0) return end;
  let remaining = turns;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (requiredMessage(active, index).role !== "user") continue;
    remaining -= 1;
    if (remaining === 0) return index;
  }
  return 0;
}

function countUserTurns(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function encodedMessageBytes(messages: readonly Message[]): number {
  return historyEncoder.encode(JSON.stringify(messages)).byteLength;
}

function requiredMessage(messages: readonly Message[], index: number): Message {
  const message = messages[index];
  if (message === undefined) throw new Error(`missing history message at index ${String(index)}`);
  return message;
}
