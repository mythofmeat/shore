import type { ConversationEngine } from "../engine/conversation.ts";
import { askedFor, locatePhrase, marksOf, removeMark, setMark, type AttemptScope, type Mark, type Reply } from "../engine/marks.ts";
import { mergeToolLoopMessages } from "../engine/merge.ts";
import { checkTags, UnknownTagError } from "../handler/attempts.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { MarkView } from "../protocol/MarkView.ts";
import { engineError, invalidRequest, notFound } from "./errors.ts";
import { resolveRef } from "./conversation.ts";

export const MAX_MARK_REASON_CHARS = 4000;

export interface MarkContext {
  engine: ConversationEngine;
  data: string;
  tags: readonly string[];
  now: () => string;
}

interface Target {
  reply: Reply;
  index: number;
}

function scopeOf(context: MarkContext): AttemptScope {
  return { data: context.data, character: context.engine.characterName, thread: context.engine.thread };
}

function replyAt(engine: ConversationEngine, reference: string | null | undefined): Reply {
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const latest = reference === undefined || reference === null || reference === "last" || reference === "latest";
  const msgId = latest ? merged.findLast((message) => message.role === "assistant")?.msg_id : resolveRef(merged, reference);
  const found = msgId === undefined ? undefined : engine.reply(msgId);
  if (found === undefined) throw notFound(latest ? "No reply here yet to mark" : `No reply ${reference} here; only the character's replies can be marked`);
  return found.reply;
}

function targetOf(engine: ConversationEngine, reference: string | null | undefined, position: number | null | undefined): Target {
  const reply = replyAt(engine, reference);
  if (position === undefined || position === null) return { reply, index: reply.attempts.findIndex((attempt) => attempt.shown) };
  if (position < 1 || position > reply.attempts.length) {
    throw invalidRequest(`Attempt ${String(position)} is out of range; this reply has ${String(reply.attempts.length)} attempt${reply.attempts.length === 1 ? "" : "s"}`);
  }
  return { reply, index: position - 1 };
}

async function attemptOf(engine: ConversationEngine, target: Target): Promise<string> {
  try {
    return await engine.attemptOf(target.reply.msgId, target.index);
  } catch (e) {
    throw engineError(e);
  }
}

function view(held: Mark): MarkView {
  return { kind: held.kind, phrase: held.phrase, reason: held.reason, tags: held.tags, at: held.at };
}

function phraseIn(target: Target, phrase: string | null | undefined): string | undefined {
  if (phrase === undefined || phrase === null) return undefined;
  const text = target.reply.attempts[target.index]?.text ?? "";
  const found = locatePhrase(text, phrase);
  if (found === undefined) throw invalidRequest(`${JSON.stringify(phrase.trim())} isn't in the text of attempt ${String(target.index + 1)}`);
  return found;
}

function reasonOf(reason: string | null | undefined): string | undefined {
  const written = reason?.trim() ?? "";
  if (Array.from(written).length > MAX_MARK_REASON_CHARS) throw invalidRequest(`A reason is at most ${String(MAX_MARK_REASON_CHARS)} characters`);
  return written === "" ? undefined : written;
}

function tagsOf(tags: readonly string[] | null | undefined, configured: readonly string[]): string[] {
  try {
    return checkTags(tags ?? [], configured);
  } catch (e) {
    if (e instanceof UnknownTagError) throw invalidRequest(e.message);
    throw e;
  }
}

export async function mark(context: MarkContext, args: OperationInput<"mark">): Promise<OperationResult<"mark">> {
  const target = targetOf(context.engine, args.ref, args.position);
  const phrase = phraseIn(target, args.phrase);
  const reason = reasonOf(args.reason);
  const tags = tagsOf(args.tags, context.tags);
  const attempt = await attemptOf(context.engine, target);
  const scope = scopeOf(context);
  const changed = setMark(scope, attempt, { kind: args.kind, phrase, reason, tags }, context.now());
  return changedResult(scope, target, attempt, phrase, changed);
}

export async function unmark(context: MarkContext, args: OperationInput<"unmark">): Promise<OperationResult<"unmark">> {
  const target = targetOf(context.engine, args.ref, args.position);
  const phrase = args.phrase === undefined || args.phrase === null ? undefined : phraseIn(target, args.phrase);
  const held = target.reply.attempts[target.index]?.attempt;
  const scope = scopeOf(context);
  if (held === undefined) throw notFound(`Attempt ${String(target.index + 1)} has no marks`);
  const changed = removeMark(scope, held, phrase);
  if (!changed) throw notFound(phrase === undefined ? `Attempt ${String(target.index + 1)} has no mark on the whole reply` : `Attempt ${String(target.index + 1)} has no mark on ${JSON.stringify(phrase)}`);
  return changedResult(scope, target, held, phrase, changed);
}

function changedResult(scope: AttemptScope, target: Target, attempt: string, phrase: string | undefined, changed: boolean): OperationResult<"mark"> {
  return {
    ref: target.reply.msgId,
    position: target.index + 1,
    attempt,
    phrase: phrase ?? null,
    changed,
    marks: (marksOf(scope, [attempt]).get(attempt) ?? []).map(view),
  };
}

export function listMarks(context: MarkContext, args: OperationInput<"marks">): OperationResult<"marks"> {
  const refs = args.refs === undefined || args.refs === null ? [undefined] : typeof args.refs === "string" ? [args.refs] : args.refs;
  const scope = scopeOf(context);
  const replies = refs.flatMap((reference) => {
    try {
      return [replyAt(context.engine, reference)];
    } catch (e) {
      if (refs.length === 1) throw e;
      return [];
    }
  });
  const ids = replies.flatMap((reply) => reply.attempts.flatMap((attempt) => attempt.attempt ?? []));
  const marks = marksOf(scope, ids);
  const asked = askedFor(scope, ids);
  return {
    tags: [...context.tags],
    replies: replies.map((reply) => ({
      ref: reply.msgId,
      attempts: reply.attempts.map((attempt) => ({
        position: attempt.index + 1,
        shown: attempt.shown,
        attempt: attempt.attempt ?? null,
        asked: attempt.attempt === undefined ? null : asked.get(attempt.attempt) ?? null,
        marks: (attempt.attempt === undefined ? [] : marks.get(attempt.attempt) ?? []).map(view),
      })),
    })),
  };
}
