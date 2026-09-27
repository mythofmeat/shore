import { registerConversation, withConversation } from "./lifecycle.ts";
import { threadFile } from "../storage/files.ts";
import { shoreLog } from "../log.ts";

import { join, dirname } from "node:path";

import {
  archiveKey,
  characterDataDir,
  MAIN_THREAD,
  threadDataDir,
} from "../config/dirs.ts";

import { HISTORY_DB_FILE } from "./history_store.ts";
import { toolLoopGroups, mergeToolLoopMessages } from "./merge";
import { MessageStore, type AltSelection, type PendingAlt } from "./message_store";
import { SegmentReader } from "./segments";
import type { Message } from "./types";
import { imageDataForPath, embedMessagesImageData } from "./wire_images";


export interface History {
  rid?: string;
  messages: Message[];
  active_start?: number;
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

export interface HistoryPageMetrics {
  segments_read: number;
  rows_read: number;
  decoded_body_bytes: number;
  page_bytes: number;
}

export interface DisplayHistoryPage {
  messages: Message[];
  activeStart: number;
  cursor: number;
  globalActiveStart: number;
  totalTurns: number;
  metrics: HistoryPageMetrics;
}

const historyEncoder = new TextEncoder();

export class ConversationEngine {
  readonly #characterName: string;
  readonly #thread: string;
  readonly #characterDir: string;
  readonly #conversationDir: string;
  readonly #historyDbPath: string;
  #messages: MessageStore;
  #segments: SegmentReader;
  #revision = 0;
  #tailStart = 0;
  #tailAnchor: string | null = null;
  readonly #deltaImages = new Map<string, string>();
  #historyRewriteGeneration = 0;
  readonly #onHistory: HistoryListener | undefined;

  private constructor(
    characterName: string,
    thread: string,
    characterDir: string,
    conversationDir: string,
    historyDbPath: string,
    messages: MessageStore,
    segments: SegmentReader,
    onHistory: HistoryListener | undefined,
  ) {
    this.#characterName = characterName;
    this.#thread = thread;
    this.#characterDir = characterDir;
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
    const characterDir = characterDataDir(dataDir, characterName);
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
      characterDir,
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

  get characterDir(): string {
    return this.#characterDir;
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

  historyRewriteGeneration(): number {
    return this.#historyRewriteGeneration;
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

  async displayHistory(): Promise<{ messages: Message[]; activeStart: number }> {
    const archivedRaw: Message[] = [];
    for (let index = 0; index < this.#segments.segmentCount(); index += 1) {
      try {
        archivedRaw.push(...(await this.#segments.readSegment(index)));
      } catch (e) {
        shoreLog.warn(
          `shore: failed to load archived conversation segment ${index} for ` +
            `${this.#characterName} for display: ${String(e)}`,
        );
      }
    }

    const archived = mergeToolLoopMessages(archivedRaw);
    const activeStart = archived.length;
    const active = mergeToolLoopMessages([...this.#messages.messages()]);
    return { messages: [...archived, ...active], activeStart };
  }

  async displayHistoryPage(
    before: number | "active" | undefined,
    limit: HistoryPageLimit,
  ): Promise<DisplayHistoryPage> {
    const globalActiveStart = this.#segments.displayMessageCount();
    const active = mergeToolLoopMessages([...this.#messages.messages()]);
    const totalMessages = globalActiveStart + active.length;
    const end = historyEnd(before, globalActiveStart, totalMessages);
    const activeEnd = Math.max(end - globalActiveStart, 0);
    const start =
      limit.kind === "count"
        ? Math.max(0, end - limit.value)
        : this.#pageStartByTurns(active, globalActiveStart, activeEnd, end, limit.value);
    const archiveStart = Math.min(start, globalActiveStart);
    const archiveEnd = Math.min(end, globalActiveStart);
    const archivedSlice = this.#segments.readDisplayRange(archiveStart, archiveEnd);
    const archived = mergeToolLoopMessages(archivedSlice.messages);
    const activeStart = Math.max(start - globalActiveStart, 0);
    const activePage = active.slice(activeStart, activeEnd);
    const messages = [...archived, ...activePage];

    return {
      messages,
      activeStart: archived.length,
      cursor: start,
      globalActiveStart,
      totalTurns: this.#segments.displayTurnCount() + countUserTurns(active),
      metrics: {
        ...archivedSlice.metrics,
        page_bytes: encodedMessageBytes(messages),
      },
    };
  }

  #pageStartByTurns(
    active: readonly Message[],
    globalActiveStart: number,
    activeEnd: number,
    end: number,
    turns: number,
  ): number {
    if (turns === 0) return end;
    let remaining = turns;
    for (let index = activeEnd - 1; index >= 0; index -= 1) {
      if (requiredMessage(active, index).role !== "user") continue;
      remaining -= 1;
      if (remaining === 0) return globalActiveStart + index;
    }
    return this.#segments.displayStartForTurns(Math.min(end, globalActiveStart), remaining);
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

  async insertMessageByTimestamp(msg: Message): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.insertByTimestamp(msg);
      this.#advanceRevision();
      this.broadcastHistory();
    });
  }

  async editMessage(msgId: string, newContent: string): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.edit(msgId, newContent);
      this.#advanceRewrite();
      this.broadcastHistory();
    });
  }

  async deleteMessage(msgId: string): Promise<void> {
    await this.deleteMessages([msgId]);
  }

  async deleteMessages(msgIds: readonly string[]): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.deleteAll(msgIds);
      this.#advanceRewrite();
      this.broadcastHistory();
    });
  }

  async truncateAfterLastUserTurn(): Promise<number> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const removed = await this.#messages.truncateAfterLastUserTurn();
      if (removed > 0) {
        this.#advanceRewrite();
        this.broadcastHistory();
      }
      return removed;
    });
  }

  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const messages = this.#messages.messages();
      this.#tailStart = messages.length - this.#messages.messagesAfterLastUserTurn().length;
      this.#tailAnchor = messages[this.#tailStart - 1]?.msg_id ?? null;
      const removed = await this.#messages.replaceAfterLastUserTurn(newMessages);
      this.#advanceRewrite();
      this.#broadcastDelta();
      return removed;
    });
  }

  async setAlt(msgId: string, index: number, count: number): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.setAlt(msgId, index, count);
      this.#advanceRevision();
      this.broadcastHistory();
    });
  }

  async addAltCandidate(msgId: string): Promise<number> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const count = await this.#messages.addAltCandidate(msgId);
      this.#advanceRevision();
      this.broadcastHistory();
      return count;
    });
  }

  async selectAlt(msgId: string, index: number): Promise<AltSelection> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      const selection = await this.#messages.selectAlt(msgId, index);
      this.#advanceRewrite();
      this.broadcastHistory();
      return selection;
    });
  }

  async reset(): Promise<void> {
    return await withConversation(this.#conversationDir, "rewrite", async () => {
      await this.#messages.clear();
      this.#advanceRewrite();
      this.broadcastHistory();
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
      this.#advanceRewrite();
      this.broadcastHistory();
    });
  }

  historySnapshot(config: unknown): History {
    const messages = structuredClone(mergeToolLoopMessages([...this.#messages.messages()]));
    embedMessagesImageData(messages);
    const history: History = {
      messages,
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

  #advanceRewrite(): void {
    this.#historyRewriteGeneration += 1;
    this.#revision += 1;
  }
}

function historyEnd(
  before: number | "active" | undefined,
  activeStart: number,
  total: number,
): number {
  if (before === "active") return activeStart;
  return Math.min(before ?? total, total);
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
