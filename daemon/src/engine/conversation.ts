import { join } from "node:path";

import { HISTORY_DB_FILE } from "./history_store.ts";
import { mergeToolLoopMessages } from "./merge";
import { MessageStore, type AltSelection, type PendingAlt } from "./message_store";
import { SegmentReader } from "./segments";
import type { Message } from "./types";
import { embedMessagesImageData } from "./wire_images";

const ACTIVE_JSONL_FILE = "active.jsonl";

export interface History {
  rid?: string;
  messages: Message[];
  active_start?: number;
  config: unknown;
  selected_character?: string;
  revision: number;
}

export type HistoryListener = (history: History) => void;

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
    const characterDir = join(dataDir, characterName);
    const historyDbPath = join(dataDir, HISTORY_DB_FILE);
    const messages = await MessageStore.load(join(characterDir, ACTIVE_JSONL_FILE));
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
        console.warn(
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

  async appendMessage(msg: Message): Promise<void> {
    await this.#messages.append(msg);
    this.#advanceRevision();
    this.broadcastHistory();
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
    this.#messages = await MessageStore.load(join(this.#characterDir, ACTIVE_JSONL_FILE));
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
