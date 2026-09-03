import { shoreLog } from "../log.ts";

import { join } from "node:path";

import { activeJsonlIn, characterDataDir } from "../config/dirs.ts";

import { HISTORY_DB_FILE } from "./history_store.ts";
import { mergeToolLoopMessages } from "./merge";
import { MessageStore, type AltSelection, type PendingAlt } from "./message_store";
import { SegmentReader } from "./segments";
import type { Message } from "./types";
import { embedMessagesImageData } from "./wire_images";


export interface History {
  rid?: string;
  messages: Message[];
  active_start?: number;
  config: unknown;
  selected_character?: string;
  revision: number;
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
  storage_native: boolean;
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
  readonly #characterDir: string;
  readonly #historyDbPath: string;
  #messages: MessageStore;
  #segments: SegmentReader;
  #revision = 0;
  #historyRewriteGeneration = 0;
  readonly #onHistory: HistoryListener | undefined;

  private constructor(
    characterName: string,
    characterDir: string,
    historyDbPath: string,
    messages: MessageStore,
    segments: SegmentReader,
    onHistory: HistoryListener | undefined,
  ) {
    this.#characterName = characterName;
    this.#characterDir = characterDir;
    this.#historyDbPath = historyDbPath;
    this.#messages = messages;
    this.#segments = segments;
    this.#onHistory = onHistory;
  }

  static async load(
    characterName: string,
    dataDir: string,
    onHistory?: HistoryListener,
  ): Promise<ConversationEngine> {
    const characterDir = characterDataDir(dataDir, characterName);
    const historyDbPath = join(dataDir, HISTORY_DB_FILE);
    const messages = await MessageStore.load(activeJsonlIn(characterDir));
    const segments = await SegmentReader.load(characterDir, {
      dbPath: historyDbPath,
      character: characterName,
    });
    return new ConversationEngine(
      characterName,
      characterDir,
      historyDbPath,
      messages,
      segments,
      onHistory,
    );
  }

  get characterName(): string {
    return this.#characterName;
  }

  get characterDir(): string {
    return this.#characterDir;
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
    if (!this.#segments.supportsDisplayPaging()) {
      const history = await this.displayHistory();
      const end = historyEnd(before, history.activeStart, history.messages.length);
      const start = historyPageStart(history.messages, end, limit);
      const messages = history.messages.slice(start, end);
      return {
        messages,
        activeStart: Math.max(Math.min(history.activeStart, end) - start, 0),
        cursor: start,
        globalActiveStart: history.activeStart,
        totalTurns: countUserTurns(history.messages),
        metrics: {
          segments_read: this.#segments.segmentCount(),
          rows_read: this.#segments.totalMessageCount(),
          decoded_body_bytes: 0,
          page_bytes: encodedMessageBytes(messages),
          storage_native: false,
        },
      };
    }

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
        storage_native: true,
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
    await this.#messages.append(msg);
    this.#advanceRevision();
    this.broadcastHistory();
  }

  async recoverInterruptedToolLoop(): Promise<number> {
    const recovered = await this.#messages.recoverInterruptedToolLoop(
      `m_${crypto.randomUUID()}`,
      new Date().toISOString(),
    );
    if (recovered > 0) {
      this.#advanceRevision();
      this.broadcastHistory();
    }
    return recovered;
  }

  async insertMessageByTimestamp(msg: Message): Promise<void> {
    await this.#messages.insertByTimestamp(msg);
    this.#advanceRevision();
    this.broadcastHistory();
  }

  async editMessage(msgId: string, newContent: string): Promise<void> {
    await this.#messages.edit(msgId, newContent);
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  async deleteMessage(msgId: string): Promise<void> {
    await this.deleteMessages([msgId]);
  }

  async deleteMessages(msgIds: readonly string[]): Promise<void> {
    await this.#messages.deleteAll(msgIds);
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  async truncateAfterLastUserTurn(): Promise<number> {
    const removed = await this.#messages.truncateAfterLastUserTurn();
    if (removed > 0) {
      this.#advanceRewrite();
      this.broadcastHistory();
    }
    return removed;
  }

  async replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    const removed = await this.#messages.replaceAfterLastUserTurn(newMessages);
    this.#advanceRewrite();
    this.broadcastHistory();
    return removed;
  }

  async setAlt(msgId: string, index: number, count: number): Promise<void> {
    await this.#messages.setAlt(msgId, index, count);
    this.#advanceRevision();
    this.broadcastHistory();
  }

  async addAltCandidate(msgId: string): Promise<number> {
    const count = await this.#messages.addAltCandidate(msgId);
    this.#advanceRevision();
    this.broadcastHistory();
    return count;
  }

  async selectAlt(msgId: string, index: number): Promise<AltSelection> {
    const selection = await this.#messages.selectAlt(msgId, index);
    this.#advanceRewrite();
    this.broadcastHistory();
    return selection;
  }

  async reset(): Promise<void> {
    await this.#messages.clear();
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  async reload(): Promise<void> {
    this.#messages = await MessageStore.load(activeJsonlIn(this.#characterDir));
    this.#segments.close();
    this.#segments = await SegmentReader.load(this.#characterDir, {
      dbPath: this.#historyDbPath,
      character: this.#characterName,
    });
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  historySnapshot(config: unknown): History {
    const messages = structuredClone(mergeToolLoopMessages([...this.#messages.messages()]));
    embedMessagesImageData(messages);
    const history: History = {
      messages,
      config,
      selected_character: this.#characterName,
      revision: this.#revision,
    };
    return history;
  }

  broadcastHistory(): void {
    this.#onHistory?.(this.historySnapshot({}));
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

function historyPageStart(
  messages: readonly Message[],
  end: number,
  limit: HistoryPageLimit,
): number {
  if (limit.kind === "count") return Math.max(0, end - limit.value);
  if (limit.value === 0) return end;
  let seen = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (requiredMessage(messages, index).role !== "user") continue;
    seen += 1;
    if (seen >= limit.value) return index;
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
