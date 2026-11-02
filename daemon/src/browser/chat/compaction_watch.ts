import type { CompactionWatchResult } from "../../protocol/CompactionWatchResult.ts";
import type { ContentBlock } from "../../protocol/ContentBlock.ts";
import type { RunningCompaction } from "../../protocol/RunningCompaction.ts";
import type { ServerMessage } from "../../protocol/ServerMessage.ts";
import { recentItems, recentText } from "../live_limits.ts";
import { compactionWatchSummary } from "./transcript.ts";

export const MAX_PASS_CHARS = 1024 * 1024;
export const MAX_PASS_BLOCKS = 2000;

export interface PassRecord {
  character: string;
  thread: string | null;
  trigger: RunningCompaction["trigger"] | null;
  startedAt: string | null;
  endedAt: string | null;
  turns: number | null;
  firstAt: string | null;
  lastAt: string | null;
  blocks: ContentBlock[];
  limited: boolean;
  phase: string | null;
  running: boolean;
  stopping: boolean;
  interrupted: boolean;
  result: string | null;
  failed: boolean;
}

export interface WatchActions {
  watch(observe: (message: ServerMessage) => void): Promise<CompactionWatchResult>;
  stop(): Promise<CompactionWatchResult>;
}

function blockSize(block: ContentBlock): number {
  switch (block.type) {
    case "text": return block.text.length;
    case "thinking": return block.thinking.length;
    case "tool_use": return JSON.stringify(block.input).length + block.name.length;
    case "tool_result": return typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
    default: return 0;
  }
}

export function trimmedBlocks(blocks: readonly ContentBlock[], maxChars = MAX_PASS_CHARS, maxBlocks = MAX_PASS_BLOCKS): { blocks: ContentBlock[]; limited: boolean } {
  const kept = recentItems(blocks, maxBlocks, maxChars, blockSize);
  const newest = blocks.at(-1);
  if (kept.items.at(-1) === newest || newest === undefined) return { blocks: kept.items, limited: kept.limited };
  if (newest.type === "text") return { blocks: [{ type: "text", text: recentText(newest.text, maxChars) }], limited: true };
  if (newest.type === "thinking") return { blocks: [{ type: "thinking", thinking: recentText(newest.thinking, maxChars) }], limited: true };
  return { blocks: [], limited: true };
}

export class CompactionWatch {
  readonly #actions: WatchActions;
  readonly #schedule: (callback: () => void) => void;
  readonly #listeners = new Set<() => void>();
  #record: PassRecord | null = null;
  #attempt = 0;
  #size = 0;
  #scheduled = false;
  #streamed = false;

  constructor(actions: WatchActions, schedule: (callback: () => void) => void = (callback) => { callback(); }) {
    this.#actions = actions;
    this.#schedule = schedule;
  }

  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): PassRecord | null => this.#record;

  #notify(): void { for (const listener of this.#listeners) listener(); }

  #notifySoon(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => { this.#scheduled = false; this.#notify(); });
  }

  #patch(patch: Partial<PassRecord>): void {
    if (this.#record === null) return;
    this.#record = { ...this.#record, ...patch };
    this.#notify();
  }

  open(character: string, running: RunningCompaction | null): void {
    const known = this.#record;
    if (known !== null && known.character === character) {
      if (running !== null && !known.running) this.#begin(character, running);
      else if (running !== null) this.describe(running);
      return;
    }
    this.#begin(character, running);
  }

  #begin(character: string, running: RunningCompaction | null): void {
    this.#record = { character, thread: running?.thread ?? null, trigger: running?.trigger ?? null, startedAt: running?.started_at ?? null, endedAt: null, turns: running?.turns ?? null, firstAt: running?.first_at ?? null, lastAt: running?.last_at ?? null, blocks: [], limited: false, phase: null, running: true, stopping: false, interrupted: false, result: null, failed: false };
    this.#size = 0;
    this.#streamed = false;
    this.#notify();
    void this.#watch();
  }

  describe(running: RunningCompaction): void {
    const known = this.#record;
    if (known === null || !known.running) return;
    if (known.turns === (running.turns ?? null) && known.thread === running.thread && known.startedAt === running.started_at) return;
    this.#patch({ thread: running.thread, trigger: running.trigger, startedAt: running.started_at, turns: running.turns ?? null, firstAt: running.first_at ?? null, lastAt: running.last_at ?? null });
  }

  async #watch(): Promise<void> {
    const attempt = ++this.#attempt;
    try {
      const result = await this.#actions.watch((message) => { if (attempt === this.#attempt) this.#frame(message); });
      if (attempt === this.#attempt) this.#finished(result);
    } catch (failure) {
      if (attempt !== this.#attempt) return;
      this.#patch({ interrupted: true, phase: failure instanceof Error ? failure.message : String(failure) });
    }
  }

  reconnected(): void {
    const known = this.#record;
    if (known === null || !known.interrupted) return;
    this.#size = 0;
    this.#streamed = false;
    this.#record = { ...known, blocks: [], limited: false, interrupted: false, phase: null };
    this.#notify();
    void this.#watch();
  }

  #finished(result: CompactionWatchResult): void {
    const pass = result.pass;
    this.#patch({
      running: false, stopping: false, interrupted: false, phase: null,
      result: compactionWatchSummary(result),
      failed: pass?.error !== null && pass?.error !== undefined,
      ...(pass === null ? {} : { thread: pass.thread, trigger: pass.trigger, startedAt: pass.started_at, endedAt: pass.ended_at }),
    });
  }

  #frame(message: ServerMessage): void {
    const known = this.#record;
    if (known === null) return;
    switch (message.type) {
      case "phase": known.phase = message.phase; break;
      case "stream_start": this.#streamed = false; break;
      case "stream_chunk":
        this.#streamed = true;
        this.#append(message.content_type === "thinking" ? { type: "thinking", thinking: message.text } : { type: "text", text: message.text });
        break;
      case "stream_end":
        if (!this.#streamed && message.content !== "") this.#append({ type: "text", text: message.content });
        this.#streamed = false;
        break;
      case "tool_call": this.#add({ type: "tool_use", id: message.tool_id, name: message.tool_name, input: message.input }); break;
      case "tool_result": this.#add({ type: "tool_result", tool_use_id: message.tool_id, content: message.output, is_error: message.is_error }); break;
      default: return;
    }
    this.#record = { ...known };
    this.#notifySoon();
  }

  #append(block: Extract<ContentBlock, { type: "text" | "thinking" }>): void {
    const known = this.#record;
    if (known === null) return;
    const last = known.blocks.at(-1);
    if (last?.type === "text" && block.type === "text") this.#replaceLast({ type: "text", text: last.text + block.text }, block.text.length);
    else if (last?.type === "thinking" && block.type === "thinking") this.#replaceLast({ type: "thinking", thinking: last.thinking + block.thinking }, block.thinking.length);
    else this.#add(block);
  }

  #replaceLast(block: ContentBlock, grew: number): void {
    const known = this.#record;
    if (known === null) return;
    known.blocks = [...known.blocks.slice(0, -1), block];
    this.#grew(grew);
  }

  #add(block: ContentBlock): void {
    const known = this.#record;
    if (known === null) return;
    known.blocks = [...known.blocks, block];
    this.#grew(blockSize(block));
  }

  #grew(by: number): void {
    const known = this.#record;
    if (known === null) return;
    this.#size += by;
    if (this.#size <= MAX_PASS_CHARS && known.blocks.length <= MAX_PASS_BLOCKS) return;
    const trimmed = trimmedBlocks(known.blocks, Math.floor(MAX_PASS_CHARS * 0.75));
    known.blocks = trimmed.blocks;
    known.limited ||= trimmed.limited;
    this.#size = trimmed.blocks.reduce((total, block) => total + blockSize(block), 0);
  }

  async stop(): Promise<string> {
    this.#patch({ stopping: true });
    try {
      const result = await this.#actions.stop();
      const summary = compactionWatchSummary(result);
      if (this.#record?.running === true && result.state === "idle") this.#finished(result);
      return summary;
    } catch (failure) {
      this.#patch({ stopping: false });
      throw failure;
    }
  }

  dismiss(): void {
    this.#attempt += 1;
    this.#record = null;
    this.#notify();
  }
}
