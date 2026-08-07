/**
 * The per-character conversation engine.
 *
 * Ported from `ConversationEngine` in `crates/daemon/src/engine/mod.rs`, pinned
 * by `tests/engine_fixtures/engine_parity.json`. It is a coordinator, not a
 * store: `MessageStore` owns `active.jsonl`, `SegmentReader` owns the frozen
 * segments, and this holds the two together, keeps the counters clients use to
 * detect change, and pushes a snapshot after anything that mutates.
 *
 * # Two counters, and they are not the same question
 *
 * `revision` answers "did anything change" and advances on every mutation.
 * `historyRewriteGeneration` answers "did history I already sent you change
 * *underneath* you", and advances only when existing turns are rewritten —
 * edit, delete, truncate, replace, alternate selection, reset, reload. A plain
 * append leaves it alone, and that is load-bearing rather than an
 * optimisation: long-lived provider subprocesses stay warm across an
 * append-only conversation and must be rotated when the past changes, because
 * they still remember turns that no longer exist.
 *
 * A truncate that removed nothing advances *neither*, and does not broadcast.
 * "Regenerate when there is nothing to regenerate" is a no-op, not an event.
 *
 * # Where the merge happens is observable
 *
 * `displayHistory` merges the archived half and the active half *separately*
 * and concatenates, rather than merging the concatenation. The two are not the
 * same: a tool loop split across the compaction boundary would fold into one
 * assistant turn under the second reading and swallow the boundary with it, so
 * `activeStart` — the index the client uses to grey out scrollback — would
 * point into the middle of a merged message. Merging each half keeps the
 * boundary an index that exists.
 */

import { join } from "node:path";

import { mergeToolLoopMessages } from "./merge";
import { MessageStore, type AltSelection, type PendingAlt } from "./message_store";
import { SegmentReader } from "./segments";
import type { Message } from "./types";
import { embedMessagesImageData } from "./wire_images";

const ACTIVE_JSONL_FILE = "active.jsonl";

/**
 * A `History` frame, in the shape the Rust serialized.
 *
 * `rid`, `active_start` and `selected_character` are omitted rather than sent
 * null/zero — `skip_serializing_if` on the Rust struct — and clients read the
 * absence. Built by {@link ConversationEngine.historySnapshot}.
 */
export interface History {
  rid?: string;
  messages: Message[];
  active_start?: number;
  config: unknown;
  selected_character?: string;
  revision: number;
}

/** Told after every state change, with the snapshot to push. */
export type HistoryListener = (history: History) => void;

export class ConversationEngine {
  readonly #characterName: string;
  readonly #characterDir: string;
  #messages: MessageStore;
  #segments: SegmentReader;
  #revision = 0;
  #historyRewriteGeneration = 0;
  readonly #onHistory: HistoryListener | undefined;

  private constructor(
    characterName: string,
    characterDir: string,
    messages: MessageStore,
    segments: SegmentReader,
    onHistory: HistoryListener | undefined,
  ) {
    this.#characterName = characterName;
    this.#characterDir = characterDir;
    this.#messages = messages;
    this.#segments = segments;
    this.#onHistory = onHistory;
  }

  /**
   * Open a character's conversation. `dataDir` is the shore data root; the
   * per-character directory is derived from the name, as the Rust did.
   */
  static async load(
    characterName: string,
    dataDir: string,
    onHistory?: HistoryListener,
  ): Promise<ConversationEngine> {
    const characterDir = join(dataDir, characterName);
    const messages = await MessageStore.load(join(characterDir, ACTIVE_JSONL_FILE));
    const segments = await SegmentReader.load(characterDir);
    return new ConversationEngine(characterName, characterDir, messages, segments, onHistory);
  }

  get characterName(): string {
    return this.#characterName;
  }

  get characterDir(): string {
    return this.#characterDir;
  }

  // ── Message access ────────────────────────────────────────────────────────

  messages(): readonly Message[] {
    return this.#messages.messages();
  }

  messageCount(): number {
    return this.#messages.messageCount();
  }

  turnCount(): number {
    return this.#messages.turnCount();
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

  /**
   * Everything a client shows: archived scrollback first, then the active
   * tail, with the index where active context begins.
   *
   * A segment that fails to load is logged and skipped rather than failing the
   * call — the alternative is a client that can render nothing because one old
   * file went bad.
   */
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

  // ── Mutations ─────────────────────────────────────────────────────────────

  async appendMessage(msg: Message): Promise<void> {
    await this.#messages.append(msg);
    this.#advanceRevision();
    this.broadcastHistory();
  }

  /**
   * Place a message at its chronological position rather than at the end.
   *
   * For work that finished out of order — a heartbeat tick that completed
   * after a user message already landed.
   */
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
    await this.#messages.delete(msgId);
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  /** Drop everything after the last real user turn, for a regeneration. */
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

  /**
   * Alternate-response bookkeeping. Setting or adding a candidate is not a
   * rewrite — the stored turns do not change, only which one is marked
   * current — but *selecting* one is, because it swaps the body of a message
   * the client and any warm provider state already have.
   */
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

  /** Re-read both halves from disk, after compaction rewrote them. */
  async reload(): Promise<void> {
    this.#messages = await MessageStore.load(join(this.#characterDir, ACTIVE_JSONL_FILE));
    this.#segments = await SegmentReader.load(this.#characterDir);
    this.#advanceRewrite();
    this.broadcastHistory();
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  /**
   * The active context, merged and with image bytes inlined.
   *
   * Active-only and `active_start` therefore absent: this drives both the
   * push after every state change and the handshake/character-switch snapshot,
   * neither of which carries scrollback. `displayHistory` is the one that does.
   */
  historySnapshot(config: unknown): History {
    // Deep-copied before embedding, and that is not defensive tidiness.
    // `mergeToolLoopMessages` passes message objects straight through —
    // untouched turns by reference, merged ones reusing the closing message's
    // `images` array — where the Rust it was ported from returned owned
    // clones. Embedding in place would therefore write base64 back into the
    // live store, and `MessageStore` rewrites `active.jsonl` from exactly
    // those objects on the next mutation. That is bytes on disk, in a file
    // whose whole contract is that `data` is stripped from it.
    const messages = structuredClone(mergeToolLoopMessages([...this.#messages.messages()]));
    // Embedding is not optional here. This snapshot is what a remote client
    // rebuilds its whole view from on every change, so dropping the bytes
    // makes attachments vanish the moment anything else happens.
    embedMessagesImageData(messages);
    const history: History = {
      messages,
      config,
      selected_character: this.#characterName,
      revision: this.#revision,
    };
    return history;
  }

  /** Push the current snapshot. No listener means nobody is connected. */
  broadcastHistory(): void {
    this.#onHistory?.(this.historySnapshot({}));
  }

  #advanceRevision(): void {
    this.#revision += 1;
  }

  /** A rewrite advances both counters; every rewrite is also a change. */
  #advanceRewrite(): void {
    this.#historyRewriteGeneration += 1;
    this.#revision += 1;
  }
}
