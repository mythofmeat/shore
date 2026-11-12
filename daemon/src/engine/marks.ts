import type { Database } from "bun:sqlite";

import { withStorage } from "../storage/store.ts";
import { deriveContentFromBlocks } from "./message_store.ts";
import { mergeToolLoopMessages, toolLoopGroups } from "./merge.ts";
import type { Message, MessageAlternative } from "./types.ts";

export { locatePhrase } from "../util/phrase.ts";

export type MarkKind = "like" | "dislike";
export type AttemptAsked = "first" | "reroll" | "another_take" | "with_reason";

export interface Mark {
  kind: MarkKind;
  phrase: string | null;
  reason: string | null;
  tags: string[];
  at: string;
}

export interface MarkInput {
  kind: MarkKind;
  phrase?: string | undefined;
  reason?: string | undefined;
  tags?: readonly string[] | undefined;
}

export interface AttemptScope {
  data: string;
  character: string;
  thread: string;
}

export interface AttemptRecord {
  attempt: string;
  asked: AttemptAsked;
  replaces?: string | undefined;
  at: string;
}

export interface ReplyAttempt {
  index: number;
  shown: boolean;
  attempt: string | undefined;
  text: string;
}

export interface Reply {
  msgId: string;
  alternatives: boolean;
  attempts: ReplyAttempt[];
}

export function newAttemptId(): string {
  return `at_${crypto.randomUUID()}`;
}

export function replyIn(messages: readonly Message[], msgId: string): Reply | undefined {
  const group = toolLoopGroups(messages).find((members) => members.some((message) => message.msg_id === msgId));
  const reply = group === undefined ? undefined : mergeToolLoopMessages(group)[0];
  return reply?.role === "assistant" ? replyOf(reply) : undefined;
}

export function replyOf(message: Message): Reply {
  const alternatives = message.alternatives ?? [];
  if (alternatives.length === 0) {
    return { msgId: message.msg_id, alternatives: false, attempts: [{ index: 0, shown: true, attempt: message.attempt, text: attemptText(message) }] };
  }
  const shown = Math.min(message.alt_index ?? alternatives.length - 1, alternatives.length - 1);
  return {
    msgId: message.msg_id,
    alternatives: true,
    attempts: alternatives.map((alternative, index) => ({ index, shown: index === shown, attempt: alternative.attempt, text: attemptText(alternative) })),
  };
}

function attemptText(attempt: Pick<Message | MessageAlternative, "content_blocks" | "content">): string {
  return attempt.content_blocks.length === 0 ? attempt.content.trim() : deriveContentFromBlocks(attempt.content_blocks, false);
}

export function recordAttempt(scope: AttemptScope, record: AttemptRecord): void {
  withStorage(scope.data, (db) => db.query(
    `INSERT INTO reply_attempts(character, thread, attempt, asked, replaces, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
  ).run(scope.character, scope.thread, record.attempt, record.asked, record.replaces ?? null, record.at));
}

export function askedFor(scope: AttemptScope, attempts: readonly string[]): Map<string, AttemptAsked | null> {
  return withStorage(scope.data, (db) => new Map((db.query(
    `SELECT attempt, asked FROM reply_attempts
     WHERE character = ?1 AND thread = ?2 AND attempt IN (SELECT value FROM json_each(?3))`,
  ).all(scope.character, scope.thread, JSON.stringify(attempts)) as { attempt: string; asked: AttemptAsked | null }[])
    .map((row) => [row.attempt, row.asked])));
}

interface MarkRow {
  attempt: string;
  kind: MarkKind;
  phrase: string | null;
  reason: string | null;
  tags: string;
  updated_at: string;
}

export function marksOf(scope: AttemptScope, attempts: readonly string[]): Map<string, Mark[]> {
  const rows = withStorage(scope.data, (db) => db.query(
    `SELECT attempt, kind, phrase, reason, tags, updated_at FROM reply_marks
     WHERE character = ?1 AND thread = ?2 AND attempt IN (SELECT value FROM json_each(?3))
     ORDER BY phrase IS NOT NULL, id`,
  ).all(scope.character, scope.thread, JSON.stringify(attempts)) as MarkRow[]);
  const found = new Map<string, Mark[]>();
  for (const row of rows) {
    const marks = found.get(row.attempt) ?? [];
    marks.push({ kind: row.kind, phrase: row.phrase, reason: row.reason, tags: JSON.parse(row.tags) as string[], at: row.updated_at });
    found.set(row.attempt, marks);
  }
  return found;
}

export function setMark(scope: AttemptScope, attempt: string, mark: MarkInput, at: string): boolean {
  const phrase = mark.phrase ?? null;
  const reason = mark.reason ?? null;
  const tags = JSON.stringify(mark.tags ?? []);
  return withStorage(scope.data, (db) => db.transaction(() => {
    const held = heldMark(db, scope, attempt, phrase);
    if (held === null) {
      db.query(
        `INSERT INTO reply_marks(character, thread, attempt, kind, phrase, reason, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      ).run(scope.character, scope.thread, attempt, mark.kind, phrase, reason, tags, at);
      return true;
    }
    if (held.kind === mark.kind && held.reason === reason && held.tags === tags) return false;
    db.query("UPDATE reply_marks SET kind = ?2, reason = ?3, tags = ?4, updated_at = ?5 WHERE id = ?1")
      .run(held.id, mark.kind, reason, tags, at);
    return true;
  })());
}

function heldMark(db: Database, scope: AttemptScope, attempt: string, phrase: string | null): { id: number; kind: MarkKind; reason: string | null; tags: string } | null {
  return db.query(
    `SELECT id, kind, reason, tags FROM reply_marks
     WHERE character = ?1 AND thread = ?2 AND attempt = ?3 AND coalesce(phrase, '') = coalesce(?4, '')`,
  ).get(scope.character, scope.thread, attempt, phrase) as { id: number; kind: MarkKind; reason: string | null; tags: string } | null;
}

export function removeMark(scope: AttemptScope, attempt: string, phrase: string | undefined): boolean {
  return withStorage(scope.data, (db) => db.query(
    `DELETE FROM reply_marks
     WHERE character = ?1 AND thread = ?2 AND attempt = ?3 AND coalesce(phrase, '') = coalesce(?4, '')`,
  ).run(scope.character, scope.thread, attempt, phrase ?? null).changes > 0);
}

export function attemptsIn(messages: readonly Message[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    if (message.attempt !== undefined) found.add(message.attempt);
    for (const alternative of message.alternatives ?? []) if (alternative.attempt !== undefined) found.add(alternative.attempt);
  }
  return [...found];
}

export function forgetAttempts(scope: AttemptScope, attempts: readonly string[]): void {
  if (attempts.length === 0) return;
  withStorage(scope.data, (db) => db.transaction(() => {
    for (const table of ["reply_marks", "reply_attempts"]) {
      db.query(`DELETE FROM ${table} WHERE character = ?1 AND thread = ?2 AND attempt IN (SELECT value FROM json_each(?3))`)
        .run(scope.character, scope.thread, JSON.stringify(attempts));
    }
  })());
}

export function forgetThreadAttempts(data: string, character: string, thread: string): void {
  withStorage(data, (db) => db.transaction(() => {
    for (const table of ["reply_marks", "reply_attempts"]) {
      db.query(`DELETE FROM ${table} WHERE character = ?1 AND thread = ?2`).run(character, thread);
    }
  })());
}

export function copyAttempts(data: string, character: string, source: string, child: string, attempts: readonly string[]): void {
  if (attempts.length === 0) return;
  withStorage(data, (db) => db.transaction(() => {
    db.query(
      `INSERT INTO reply_attempts(character, thread, attempt, asked, replaces, created_at)
       SELECT character, ?3, attempt, asked, replaces, created_at FROM reply_attempts
       WHERE character = ?1 AND thread = ?2 AND attempt IN (SELECT value FROM json_each(?4))
       ON CONFLICT DO NOTHING`,
    ).run(character, source, child, JSON.stringify(attempts));
    db.query(
      `INSERT OR IGNORE INTO reply_marks(character, thread, attempt, kind, phrase, reason, tags, created_at, updated_at)
       SELECT character, ?3, attempt, kind, phrase, reason, tags, created_at, updated_at FROM reply_marks
       WHERE character = ?1 AND thread = ?2 AND attempt IN (SELECT value FROM json_each(?4))
       ORDER BY id`,
    ).run(character, source, child, JSON.stringify(attempts));
  })());
}
