import type { OperationInput, OperationResult } from "../../operations/types.ts";
import type { AttemptMarks } from "../../protocol/AttemptMarks.ts";
import type { MarkKind } from "../../protocol/MarkKind.ts";
import type { MarkView } from "../../protocol/MarkView.ts";
import type { Message } from "../../protocol/Message.ts";

type MarkOperation = "marks" | "mark" | "unmark";
export type MarkRun = <N extends MarkOperation>(name: N, input: OperationInput<N>) => Promise<OperationResult<N>>;

export interface Editing { ref: string; position: number; phrase: string | null; place: "row" | "dialog" }
export interface MarkChoice { kind: MarkKind; phrase?: string; reason?: string; tags?: readonly string[] }
export type ReplyKey = Pick<Message, "msg_id" | "alt_index" | "alt_count">;

const BATCH = 64;

export function replyKey(message: ReplyKey): string {
  return `${message.msg_id}#${String(message.alt_index ?? 0)}/${String(message.alt_count ?? 1)}`;
}

export function shownAttempt(attempts: readonly AttemptMarks[] | undefined): AttemptMarks | undefined {
  return attempts?.find((attempt) => attempt.shown);
}

export function wholeMark(attempt: AttemptMarks | undefined): MarkView | undefined {
  return attempt?.marks.find((mark) => mark.phrase === null);
}

export class ReplyMarkStore {
  #scope = "";
  #replies = new Map<string, readonly AttemptMarks[]>();
  #asked = new Set<string>();
  #queue = new Map<string, string>();
  #tags: readonly string[] | undefined;
  #editing: Editing | null = null;
  #version = 0;
  #scheduled = false;
  readonly #listeners = new Set<() => void>();

  constructor(readonly run: MarkRun, readonly later: (work: () => void) => void = (work) => { queueMicrotask(work); }) {}

  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): number => this.#version;

  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  attempts(message: ReplyKey): readonly AttemptMarks[] | undefined { return this.#replies.get(replyKey(message)); }
  tags(): readonly string[] { return this.#tags ?? []; }
  editing(): Editing | null { return this.#editing; }

  edit(editing: Editing | null): void {
    this.#editing = editing;
    this.#changed();
  }

  #enter(scope: string): void {
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#replies = new Map();
    this.#asked = new Set();
    this.#queue = new Map();
    this.#editing = null;
  }

  want(scope: string, messages: readonly ReplyKey[]): void {
    this.#enter(scope);
    for (const message of messages) {
      const key = replyKey(message);
      if (!this.#asked.has(key)) this.#queue.set(key, message.msg_id);
    }
    if (this.#queue.size === 0 || this.#scheduled) return;
    this.#scheduled = true;
    this.later(() => {
      this.#scheduled = false;
      void this.#flush(this.#scope);
    });
  }

  async #flush(scope: string): Promise<void> {
    while (this.#queue.size > 0 && scope === this.#scope) {
      const batch = [...this.#queue].slice(0, BATCH);
      for (const [key] of batch) { this.#queue.delete(key); this.#asked.add(key); }
      const listing = await this.run("marks", { refs: batch.map(([, ref]) => ref) }).catch(() => undefined);
      if (listing === undefined || scope !== this.#scope) continue;
      this.#tags = listing.tags;
      const found = new Map(listing.replies.map((reply) => [reply.ref, reply.attempts]));
      for (const [key, ref] of batch) this.#replies.set(key, found.get(ref) ?? []);
      this.#changed();
    }
  }

  async loadTags(): Promise<readonly string[]> {
    if (this.#tags !== undefined) return this.#tags;
    this.#tags = (await this.run("marks", {})).tags;
    this.#changed();
    return this.#tags;
  }

  #store(scope: string, key: string, changed: OperationResult<"mark">): void {
    if (scope !== this.#scope) return;
    const attempts = this.#replies.get(key) ?? [{ position: changed.position, shown: true, attempt: changed.attempt, asked: null, marks: [] }];
    this.#replies.set(key, attempts.map((attempt) => attempt.position === changed.position ? { ...attempt, attempt: changed.attempt, marks: changed.marks } : attempt));
    this.#changed();
  }

  async mark(scope: string, message: ReplyKey, position: number, choice: MarkChoice): Promise<OperationResult<"mark">> {
    const changed = await this.run("mark", {
      ref: message.msg_id, position, kind: choice.kind,
      ...(choice.phrase === undefined ? {} : { phrase: choice.phrase }),
      ...(choice.reason === undefined ? {} : { reason: choice.reason }),
      ...(choice.tags === undefined ? {} : { tags: [...choice.tags] }),
    });
    this.#store(scope, replyKey(message), changed);
    return changed;
  }

  async unmark(scope: string, message: ReplyKey, position: number, phrase: string | null): Promise<OperationResult<"unmark">> {
    const changed = await this.run("unmark", { ref: message.msg_id, position, ...(phrase === null ? {} : { phrase }) });
    this.#store(scope, replyKey(message), changed);
    if (this.#editing?.ref === message.msg_id && this.#editing.position === position && this.#editing.phrase === phrase) this.edit(null);
    return changed;
  }
}
