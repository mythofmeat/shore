import { existsSync } from "node:fs";
import { join } from "node:path";

import { archiveKey } from "../config/dirs.ts";
import { asNaive, hostZone, naiveInZone, resolveInZone } from "../ledger/zoned.ts";
import { HistoryStore } from "../engine/history_store.ts";
import { MessageStore } from "../engine/message_store.ts";
import { readThreadsIndex, wakesThread } from "../engine/threads.ts";
import { threadFile } from "../storage/files.ts";
import {
  HISTORY_INDEX_FILE,
  HistoryIndex,
  refreshHistoryIndex,
  refreshLiveRows,
  shownText,
  withHistoryIndexLock,
  type LiveThread,
  type ChatLogFilter,
  type ChatLogHit,
  type ChatLogMatch,
  type ChatLogMessage,
  type ChatLogSort,
  type Speaker,
} from "../memory/history_index.ts";
import { required } from "../util/required.ts";
import { actionOf } from "./actions.ts";
import { InvalidArgs, ToolIoError } from "./errors";
import type { Texts } from "../texts/texts.ts";

const GAP_MS = 90 * 60_000;
const DAY_MS = 86_400_000;
const BUDGET_CHARS = 12_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 50;
const WINDOW_MONTHS = 6;
const FIRST_LINE_CHARS = 70;
const SUBSTRING_CONTEXT = 60;
const RANGE_BATCH = 100;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function optionalTrimmedString(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const trimmed = ((input[field] ?? "") as string).trim();
  return trimmed === "" ? undefined : trimmed;
}

interface TimeBound {
  ms: number;
  rfc3339: string;
}

export function parseTimeBound(
  texts: Texts,
  input: Record<string, unknown>,
  field: string,
): TimeBound | undefined {
  const raw = optionalTrimmedString(input, field);
  if (raw === undefined) return undefined;
  const parsed = parseRfc3339Full(raw);
  if (parsed === undefined) throw new InvalidArgs(texts.always("logs_time_form", { field }));
  return parsed;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseRfc3339Full(value: string): TimeBound | undefined {
  const m = RFC3339.exec(value);
  if (m === null) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;

  const [, date, time, fraction, offset] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  return {
    ms,
    rfc3339: `${date}T${time}${echoFraction(fraction)}${/^[Zz]$/.test(offset) ? "+00:00" : offset}`,
  };
}

function echoFraction(fraction: string | undefined): string {
  if (fraction === undefined) return "";
  const digits = fraction.slice(1).replace(/0+$/, "");
  if (digits === "") return "";
  const width = digits.length <= 3 ? 3 : digits.length <= 6 ? 6 : 9;
  return `.${digits.padEnd(width, "0")}`;
}

export interface ChatLogOptions {
  texts: Texts;
  character: string;
  dbPath: string;
  dataDir?: string | undefined;
  thread?: string | undefined;
  fresh?: boolean | undefined;
  indexPath?: string | undefined;
  userName?: string | undefined;
  timeZone?: string | undefined;
  now?: (() => number) | undefined;
}

interface View {
  texts: Texts;
  zone: string;
  user: string;
  character: string;
  width: number;
}

function viewOf(options: ChatLogOptions): View {
  const user = options.userName ?? "user";
  return {
    texts: options.texts,
    zone: options.timeZone ?? hostZone(),
    user,
    character: options.character,
    width: Math.max(user.length, options.character.length),
  };
}

function checkConfigured(texts: Texts, conversationDir: string): void {
  if (conversationDir === "") throw new InvalidArgs(texts.always("logs_not_configured"));
}

async function unseenThreads(options: ChatLogOptions): Promise<LiveThread[]> {
  if (options.dataDir === undefined) return [];
  const dataDir = options.dataDir;
  const index = await readThreadsIndex(dataDir, options.character);
  const live: LiveThread[] = [];
  for (const record of index?.threads ?? []) {
    if (record.id === (options.thread ?? "main") && options.fresh !== true) continue;
    try {
      const { store, raw } = await MessageStore.loadWithRaw(threadFile(dataDir, options.character, record.id, "active.jsonl"));
      live.push({ thread: record.id, raw, messages: store.messages() });
    } catch {
      continue;
    }
  }
  return live;
}

async function wakesThreadOf(options: ChatLogOptions): Promise<string | undefined> {
  return options.dataDir === undefined ? undefined : wakesThread(await readThreadsIndex(options.dataDir, options.character));
}

async function withIndex<T>(conversationDir: string, options: ChatLogOptions, run: (index: HistoryIndex) => T): Promise<T> {
  const path = options.indexPath ?? join(conversationDir, HISTORY_INDEX_FILE);
  const ref = { mainConversationDir: conversationDir, dbPath: options.dbPath, character: options.character };
  const refreshed = async (force: boolean): Promise<HistoryIndex> => {
    await withHistoryIndexLock(path, async () => {
      await refreshHistoryIndex(ref, path, force);
      refreshLiveRows(path, options.thread ?? "main", await unseenThreads(options), options.texts);
    });
    return HistoryIndex.open(path).keptApart(await wakesThreadOf(options));
  };
  let index: HistoryIndex;
  try {
    index = await refreshed(false);
  } catch {
    try {
      index = await refreshed(true);
    } catch (error) {
      throw new ToolIoError(describe(error));
    }
  }
  try {
    return run(index);
  } finally {
    index.close();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const count = (value: number): string => value.toLocaleString("en-US");

function wall(ms: number, zone: string): Date {
  return new Date(naiveInZone(ms, zone));
}

function dayOf(ms: number, zone: string): string {
  const d = wall(ms, zone);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function clockOf(ms: number, zone: string): string {
  const d = wall(ms, zone);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function weekdayOf(ms: number, zone: string): string {
  return WEEKDAYS[wall(ms, zone).getUTCDay()] ?? "";
}

function stamp(ms: number, zone: string): string {
  return `${dayOf(ms, zone)} ${weekdayOf(ms, zone)} ${clockOf(ms, zone)}`;
}

function localInstant(parts: number[], zone: string): number | undefined {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(naive);
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return resolveInZone(asNaive(naive), zone);
}

function nextMidnight(year: number, month: number, day: number, zone: string): number {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return localInstant([next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()], zone) ?? Date.UTC(year, month - 1, day + 1);
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function boundFrom(texts: Texts, input: Record<string, unknown>, field: string, zone: string, end: boolean): number | undefined {
  const raw = optionalTrimmedString(input, field);
  if (raw === undefined) return undefined;
  const invalid = new InvalidArgs(texts.always("logs_bound_form", { field }));
  const date = LOCAL_DATE.exec(raw);
  if (date !== null) {
    const parts = date.slice(1).map(Number);
    const start = localInstant(parts, zone);
    if (start === undefined) throw invalid;
    const [year = 0, month = 1, day = 1] = parts;
    return end ? nextMidnight(year, month, day, zone) - 1 : start;
  }
  const time = LOCAL_TIME.exec(raw);
  if (time !== null) {
    const parts = time.slice(1, 7).map((part) => Number(part ?? 0));
    const instant = localInstant(parts, zone);
    if (instant === undefined) throw invalid;
    return end ? instant + (time[6] === undefined ? 59_999 : 999) : instant;
  }
  const rfc = parseRfc3339Full(raw);
  if (rfc === undefined) throw invalid;
  return rfc.ms;
}

function monthsBefore(now: number, months: number, zone: string): number {
  const d = wall(now, zone);
  const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()));
  return resolveInZone(asNaive(back.getTime()), zone);
}

function chosen<T extends string>(input: Record<string, unknown>, field: string, fallback: T): T {
  return (input[field] ?? fallback) as T;
}

function countArg(texts: Texts, input: Record<string, unknown>, field: string, fallback: number, max: number): number {
  const value = (input[field] ?? fallback) as number;
  if (value < 0) throw new InvalidArgs(texts.always("logs_count_form", { field }));
  return Math.min(value, max);
}

function speakerFrom(input: Record<string, unknown>, view: View): Speaker | undefined {
  const raw = optionalTrimmedString(input, "speaker");
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (value === "user" || value === view.user.toLowerCase()) return "user";
  if (value === "character" || value === view.character.toLowerCase()) return "character";
  const choices = view.texts.always("logs_or", { list: ["user", "character", view.user].join(", "), last: view.character });
  throw new InvalidArgs(view.texts.always("logs_speaker_form", { choices }));
}

function labelOf(speaker: Speaker, view: View): string {
  return speaker === "user" ? view.user : speaker === "character" ? view.character : view.texts.render("logs_system") ?? "";
}

function checkThread(texts: Texts, index: HistoryIndex, thread: string | undefined): void {
  if (thread === undefined) return;
  const threads = index.threads();
  if (!threads.includes(thread)) throw new InvalidArgs(texts.always("logs_no_thread", { thread: JSON.stringify(thread), threads: threads.join(", ") }));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function cutAt(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function substringSnippet(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return truncate(text, SUBSTRING_CONTEXT * 2);
  const end = at + needle.length;
  const from = cutAt(text, Math.max(0, at - SUBSTRING_CONTEXT));
  const to = cutAt(text, Math.min(text.length, end + SUBSTRING_CONTEXT));
  return `${from > 0 ? "…" : ""}${text.slice(from, at)}[${text.slice(at, end)}]${text.slice(end, to)}${to < text.length ? "…" : ""}`;
}

function alsoIn(row: ChatLogMessage): string[] {
  return row.also_in === null ? [] : (JSON.parse(row.also_in) as string[]);
}

function archiveSpan(index: HistoryIndex, zone: string): { text: string; messages: number } | undefined {
  const span = index.span();
  return span === undefined ? undefined : { text: `${dayOf(span.oldest, zone)} → ${stamp(span.newest, zone)}`, messages: span.messages };
}

function emptyArchiveNote(texts: Texts, index: HistoryIndex, zone: string): string {
  return texts.render("logs_empty_archive", { span: archiveSpan(index, zone)?.text }) ?? "";
}

function quoteWords(query: string): string {
  return query.split(/\s+/).filter((word) => word !== "").map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
}

function scopeText(view: View, filter: ChatLogFilter, rawStart: string | undefined, rawEnd: string | undefined): string | undefined {
  const parts = [
    filter.speaker === undefined ? undefined : view.texts.render("logs_scope_speaker", { speaker: labelOf(filter.speaker, view) }),
    filter.thread === undefined ? undefined : view.texts.render("logs_scope_thread", { thread: filter.thread }),
    rawStart === undefined && rawEnd === undefined ? undefined : view.texts.render("logs_scope_time", { start: rawStart, end: rawEnd }),
  ].filter((part) => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" ");
}

function sortText(view: View, sort: ChatLogSort, match: ChatLogMatch): string | undefined {
  return view.texts.render("logs_sort", { oldest: sort === "oldest" ? "yes" : undefined, best: sort === "best" && match === "words" ? "yes" : undefined });
}

function hitLine(hit: ChatLogHit, view: View, query: string): string {
  const copies = alsoIn(hit);
  return view.texts.render("logs_hit", {
    at: stamp(hit.ts, view.zone),
    speaker: labelOf(hit.speaker, view).padEnd(view.width),
    thread: hit.thread === "main" ? undefined : hit.thread,
    wake: hit.wake === 1 ? "yes" : undefined,
    snippet: oneLine(hit.snippet ?? substringSnippet(hit.text, query)),
    id: hit.msg_id,
    also: copies.length === 0 ? undefined : copies.join(", "),
  }) ?? "";
}

const CHAT_LOG_TAKES = {
  search: ["query", "match", "sort", "speaker", "thread", "start", "end", "all_time", "limit", "offset"],
  read: ["around", "before", "after", "start", "end", "offset", "thread", "overview"],
  list: ["thread", "limit", "offset"],
} as const;

export async function handleChatLogs(
  input: Record<string, unknown>,
  conversationDir: string,
  options: ChatLogOptions,
): Promise<string> {
  const action = actionOf(options.texts, input, CHAT_LOG_TAKES);
  if (action === "list") return await handleListChatLogs(input, options);
  return action === "search"
    ? await handleSearchChatLogs(input, conversationDir, options)
    : await handleReadChatLogs(input, conversationDir, options);
}

interface ArchivedConversation {
  thread: string;
  from: number;
  to: number;
  turns: number;
  label: string | undefined;
}

async function archivedConversations(options: ChatLogOptions, only: string | undefined): Promise<ArchivedConversation[]> {
  if (!existsSync(options.dbPath)) return [];
  const index = options.dataDir === undefined ? undefined : await readThreadsIndex(options.dataDir, options.character);
  const apart = wakesThread(index);
  const threads = only === undefined ? (index?.threads.filter((record) => record.archived === undefined).map((record) => record.id) ?? ["main"]).filter((id) => id !== apart) : [only];
  const store = HistoryStore.open(options.dbPath);
  try {
    return threads.flatMap((thread) => store.entries(archiveKey(options.character, thread))
      .filter((entry) => entry.excluded !== true && entry.turn_count > 0)
      .map((entry) => ({
        thread,
        from: instantOr(entry.first_message_at, entry.compacted_at),
        to: instantOr(entry.last_message_at, entry.compacted_at),
        turns: entry.turn_count,
        label: entry.label,
      }))).sort((a, b) => b.to - a.to);
  } finally {
    store.close();
  }
}

function instantOr(timestamp: string | null, otherwise: string): number {
  const instant = Date.parse(timestamp ?? "");
  return Number.isNaN(instant) ? Date.parse(otherwise) : instant;
}

function archivedSpan(conversation: ArchivedConversation, zone: string): string {
  const day = dayOf(conversation.from, zone);
  const lastDay = dayOf(conversation.to, zone);
  return `${day} ${clockOf(conversation.from, zone)} → ${lastDay === day ? "" : `${lastDay} `}${clockOf(conversation.to, zone)}`;
}

function nextPage(texts: Texts, offset: number): string[] {
  const line = texts.render("logs_next_page", { offset: String(offset) });
  return line === undefined ? [] : [line];
}

export async function handleListChatLogs(input: Record<string, unknown>, options: ChatLogOptions): Promise<string> {
  const view = viewOf(options);
  const texts = view.texts;
  const thread = optionalTrimmedString(input, "thread");
  const limit = Math.max(1, countArg(texts, input, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = countArg(texts, input, "offset", 0, Number.MAX_SAFE_INTEGER);
  const all = await archivedConversations(options, thread);
  if (all.length === 0) return texts.render("logs_list_none", { thread }) ?? "";
  if (offset >= all.length) return texts.render("logs_list_past_end", { count: count(all.length), one: all.length === 1 ? "yes" : undefined, thread, offset: String(offset) }) ?? "";
  const page = all.slice(offset, offset + limit);
  const lines = [
    texts.render("logs_list_header", { thread, from: count(offset + 1), to: count(offset + page.length), count: count(all.length), zone: view.zone }) ?? "",
    "",
    ...page.map((conversation) => texts.render("logs_list_entry", {
      span: archivedSpan(conversation, view.zone),
      turns: String(conversation.turns),
      one: conversation.turns === 1 ? "yes" : undefined,
      thread: conversation.thread === "main" ? undefined : conversation.thread,
      label: conversation.label,
      unlabeled: conversation.label === undefined ? "yes" : undefined,
    }) ?? ""),
  ];
  if (offset + page.length < all.length) lines.push("", ...nextPage(texts, offset + page.length));
  return lines.join("\n");
}

function countMatches(texts: Texts, index: HistoryIndex, match: ChatLogMatch, query: string, filter: ChatLogFilter): { expression: string; total: number; note?: string | undefined } {
  try {
    return { expression: query, total: index.count(match, query, filter) };
  } catch (error) {
    const expression = quoteWords(query);
    return {
      expression,
      total: index.count(match, expression, filter),
      note: texts.render("logs_fts_fallback", { error: describe(error), expression }),
    };
  }
}

export async function handleSearchChatLogs(
  input: Record<string, unknown>,
  conversationDir: string,
  options: ChatLogOptions,
): Promise<string> {
  const texts = options.texts;
  checkConfigured(texts, conversationDir);
  const query = optionalTrimmedString(input, "query");
  if (query === undefined) throw new InvalidArgs(texts.always("logs_query_required"));
  const view = viewOf(options);
  const match = chosen<ChatLogMatch>(input, "match", "words");
  const sort = chosen<ChatLogSort>(input, "sort", "best");
  const speaker = speakerFrom(input, view);
  const thread = optionalTrimmedString(input, "thread");
  const start = boundFrom(texts, input, "start", view.zone, false);
  const end = boundFrom(texts, input, "end", view.zone, true);
  if (start !== undefined && end !== undefined && start > end) throw new InvalidArgs(texts.always("logs_start_after_end"));
  const limit = Math.max(1, countArg(texts, input, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = countArg(texts, input, "offset", 0, Number.MAX_SAFE_INTEGER);
  const windowStart = input["all_time"] === true || start !== undefined || end !== undefined
    ? undefined
    : monthsBefore((options.now ?? Date.now)(), WINDOW_MONTHS, view.zone);
  const filter: ChatLogFilter = {
    ...(speaker === undefined ? {} : { speaker }),
    ...(thread === undefined ? {} : { thread }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
  const scoped = windowStart === undefined ? filter : { ...filter, start: windowStart };

  return await withIndex(conversationDir, options, (index) => {
    checkThread(texts, index, thread);
    const { expression, total, note } = countMatches(texts, index, match, query, scoped);
    const lines = note === undefined ? [] : [note];
    const older = windowStart === undefined ? 0 : index.count(match, expression, { ...filter, end: windowStart - 1 });
    const heading = {
      query,
      substring: match === "substring" ? "yes" : undefined,
      scope: scopeText(view, filter, optionalTrimmedString(input, "start"), optionalTrimmedString(input, "end")),
      older: older > 0 ? count(older) : undefined,
      months: String(WINDOW_MONTHS),
    };
    if (total === 0) {
      const apart = thread === undefined ? index.apartThread() : undefined;
      const span = archiveSpan(index, view.zone);
      lines.push(...[
        texts.render("logs_search_none", heading),
        older === 0 ? texts.render("logs_nothing_searched", { span: span?.text, messages: span === undefined ? undefined : count(span.messages) }) : undefined,
        older === 0 && apart !== undefined ? texts.render("logs_try_wakes", { thread: JSON.stringify(apart) }) : undefined,
        older === 0 && match === "words" ? texts.render("logs_try_substring") : undefined,
      ].filter((line) => line !== undefined));
      return lines.join("\n");
    }
    const hits = index.search(match, expression, scoped, sort, limit, offset);
    lines.push(texts.render("logs_search_header", {
      ...heading,
      count: count(total),
      one: total === 1 ? "yes" : undefined,
      shown: texts.render("logs_shown", { from: hits.length === 0 ? undefined : count(offset + 1), to: count(offset + hits.length) }),
      sort: sortText(view, sort, match),
    }) ?? "", "");
    for (const hit of hits) lines.push(hitLine(hit, view, query));
    if (offset + hits.length < total) lines.push("", ...nextPage(texts, offset + hits.length));
    return lines.join("\n");
  });
}

function entryHead(row: ChatLogMessage, view: View, marked: boolean): string {
  return view.texts.render("logs_entry_head", { marked: marked ? "yes" : undefined, at: stamp(row.ts, view.zone), speaker: labelOf(row.speaker, view), wake: row.wake === 1 ? "yes" : undefined, id: row.msg_id }) ?? "";
}

function entrySize(row: ChatLogMessage, view: View): number {
  return entryHead(row, view, false).length + shownText(row, view.texts).length + 3;
}

function gapText(texts: Texts, ms: number): string | undefined {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 2 * 24 * 60) return texts.render("logs_gap_length", { days: String(Math.round(minutes / (24 * 60))) });
  if (minutes < 60) return texts.render("logs_gap_length", { minutes: String(minutes) });
  const rest = minutes % 60;
  return texts.render("logs_gap_length", { hours: String(Math.floor(minutes / 60)), minutes: rest === 0 ? undefined : String(rest) });
}

function transcript(rows: readonly ChatLogMessage[], view: View, markId?: number): string[] {
  const lines: string[] = [];
  let previous: ChatLogMessage | undefined;
  for (const row of rows) {
    const gap = previous !== undefined && row.ts - previous.ts >= GAP_MS ? view.texts.render("logs_gap", { gap: gapText(view.texts, row.ts - previous.ts) }) : undefined;
    if (gap !== undefined) lines.push(gap, "");
    lines.push(entryHead(row, view, row.id === markId), shownText(row, view.texts), "");
    previous = row;
  }
  return lines;
}

function readAround(index: HistoryIndex, view: View, msgId: string, thread: string | undefined, before: number, after: number): string {
  const texts = view.texts;
  checkThread(texts, index, thread);
  const target = index.find(msgId, thread);
  if (target === undefined) return texts.render("logs_not_found", { id: msgId, thread }) ?? "";
  const earlier = index.neighbors(target, -1, before);
  const later = index.neighbors(target, 1, after);
  const keptEarlier: ChatLogMessage[] = [];
  const keptLater: ChatLogMessage[] = [];
  let used = entrySize(target, view);
  let full = false;
  for (let distance = 0; distance < Math.max(earlier.length, later.length) && !full; distance += 1) {
    for (const [side, kept] of [[earlier, keptEarlier], [later, keptLater]] as const) {
      const row = side[distance];
      if (row === undefined || full) continue;
      const size = entrySize(row, view);
      if (used + size > BUDGET_CHARS) {
        full = true;
        continue;
      }
      used += size;
      kept.push(row);
    }
  }
  const copies = alsoIn(target);
  const lines = [
    texts.render("logs_around_header", { id: msgId, thread: target.thread, before: String(keptEarlier.length), after: String(keptLater.length), zone: view.zone }),
    copies.length === 0 ? undefined : texts.render("logs_also_in", { threads: copies.join(", ") }),
    "",
    ...transcript([...keptEarlier.reverse(), target, ...keptLater], view, target.id),
  ].filter((line) => line !== undefined);
  const missing = { earlier: earlier.length - keptEarlier.length, later: later.length - keptLater.length };
  const stopped = missing.earlier + missing.later > 0
    ? texts.render("logs_stopped", { chars: count(BUDGET_CHARS), earlier: missing.earlier > 0 ? String(missing.earlier) : undefined, later: missing.later > 0 ? String(missing.later) : undefined, one: missing.earlier + missing.later === 1 ? "yes" : undefined })
    : undefined;
  if (stopped !== undefined) lines.push(stopped);
  return lines.join("\n").trimEnd();
}

function readRange(
  index: HistoryIndex,
  view: View,
  thread: string,
  bounds: { start: number | undefined; end: number | undefined; rawStart: string | undefined; rawEnd: string | undefined },
  offset: number,
): string {
  const low = bounds.start ?? Number.MIN_SAFE_INTEGER;
  const high = bounds.end ?? Number.MAX_SAFE_INTEGER;
  const texts = view.texts;
  const range = texts.render("logs_range", { start: bounds.rawStart, end: bounds.rawEnd }) ?? "";
  const total = index.countRange(thread, low, high);
  if (total === 0) return texts.render("logs_range_none", { thread, range, note: emptyArchiveNote(texts, index, view.zone) }) ?? "";
  if (offset >= total) return texts.render("logs_range_past_end", { thread, range, count: count(total), offset: String(offset) }) ?? "";
  const rows: ChatLogMessage[] = [];
  let used = 0;
  let full = false;
  for (let page = offset; !full && page < total; page += RANGE_BATCH) {
    const batch = index.range(thread, low, high, page, RANGE_BATCH);
    if (batch.length === 0) break;
    for (const row of batch) {
      const size = entrySize(row, view);
      if (rows.length > 0 && used + size > BUDGET_CHARS) {
        full = true;
        break;
      }
      used += size;
      rows.push(row);
    }
  }
  const lines = [
    texts.render("logs_range_header", { thread, range, from: count(offset + 1), to: count(offset + rows.length), count: count(total), zone: view.zone }) ?? "",
    "",
    ...transcript(rows, view),
  ];
  if (offset + rows.length < total) lines.push(...nextPage(texts, offset + rows.length));
  return lines.join("\n").trimEnd();
}

function conversationsOf(rows: readonly ChatLogMessage[]): ChatLogMessage[][] {
  const conversations: ChatLogMessage[][] = [];
  for (const row of rows) {
    const current = conversations.at(-1);
    const last = current?.at(-1);
    if (current === undefined || last === undefined || last.thread !== row.thread || row.ts - last.ts >= GAP_MS) conversations.push([row]);
    else current.push(row);
  }
  return conversations;
}

function dayOverview(index: HistoryIndex, view: View, date: string): string {
  const parts = LOCAL_DATE.exec(date)?.slice(1).map(Number);
  const dayStart = parts === undefined ? undefined : localInstant(parts, view.zone);
  const texts = view.texts;
  if (parts === undefined || dayStart === undefined) throw new InvalidArgs(texts.always("logs_overview_form"));
  const [year = 0, month = 1, day = 1] = parts;
  const dayEnd = nextMidnight(year, month, day, view.zone) - 1;
  const inDay = (row: ChatLogMessage) => row.ts >= dayStart && row.ts <= dayEnd;
  const conversations = conversationsOf(index.between(dayStart - DAY_MS, dayEnd + DAY_MS)).filter((c) => c.some(inDay));
  if (conversations.length === 0) return texts.render("logs_day_none", { date, note: emptyArchiveNote(texts, index, view.zone) }) ?? "";
  const onDay = conversations.reduce((sum, c) => sum + c.filter(inDay).length, 0);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  const rows = conversations.map((c) => {
    const first = required(c[0]);
    const last = required(c[c.length - 1]);
    const at = (row: ChatLogMessage) => dayOf(row.ts, view.zone) === date ? clockOf(row.ts, view.zone) : `${weekdayOf(row.ts, view.zone)} ${clockOf(row.ts, view.zone)}`;
    const opener = c.find((row) => row.speaker === "user");
    const fromWakes = c.filter((row) => row.wake === 1).length;
    const rest = (opener !== undefined
      ? texts.render("logs_day_first", { text: truncate(oneLine(opener.text), FIRST_LINE_CHARS) })
      : fromWakes === c.length
        ? texts.render("logs_day_wakes", { count: String(fromWakes), one: fromWakes === 1 ? "yes" : undefined, char: view.character, user: view.user })
        : texts.render("logs_day_no_reply", { count: String(c.length), char: view.character, user: view.user })) ?? "";
    return {
      range: `${at(first)} → ${at(last)}`,
      size: texts.render("logs_day_size", { count: String(c.length), one: c.length === 1 ? "yes" : undefined }) ?? "",
      rest: `${first.thread === "main" ? "" : `[${first.thread}] `}${rest}`,
    };
  });
  const rangeWidth = Math.max(...rows.map((row) => row.range.length));
  const sizeWidth = Math.max(...rows.map((row) => row.size.length));
  return [
    texts.render("logs_day_header", { date, weekday, count: String(conversations.length), one: conversations.length === 1 ? "yes" : undefined, messages: count(onDay), zone: view.zone }) ?? "",
    "",
    ...rows.map((row) => `${row.range.padEnd(rangeWidth)}  ${row.size.padStart(sizeWidth)}  ${row.rest}`),
  ].join("\n");
}

export async function handleReadChatLogs(
  input: Record<string, unknown>,
  conversationDir: string,
  options: ChatLogOptions,
): Promise<string> {
  const texts = options.texts;
  checkConfigured(texts, conversationDir);
  const view = viewOf(options);
  const around = optionalTrimmedString(input, "around");
  const overview = optionalTrimmedString(input, "overview");
  const start = boundFrom(texts, input, "start", view.zone, false);
  const end = boundFrom(texts, input, "end", view.zone, true);
  const modes = Number(around !== undefined) + Number(overview !== undefined) + Number(start !== undefined || end !== undefined);
  if (modes !== 1) throw new InvalidArgs(texts.always("logs_one_mode"));
  const thread = optionalTrimmedString(input, "thread");
  if (around !== undefined) {
    const before = countArg(texts, input, "before", DEFAULT_CONTEXT, MAX_CONTEXT);
    const after = countArg(texts, input, "after", DEFAULT_CONTEXT, MAX_CONTEXT);
    return await withIndex(conversationDir, options, (index) => readAround(index, view, around, thread, before, after));
  }
  if (overview !== undefined) return await withIndex(conversationDir, options, (index) => dayOverview(index, view, overview));
  if (start !== undefined && end !== undefined && start > end) throw new InvalidArgs(texts.always("logs_start_after_end"));
  const offset = countArg(texts, input, "offset", 0, Number.MAX_SAFE_INTEGER);
  const bounds = { start, end, rawStart: optionalTrimmedString(input, "start"), rawEnd: optionalTrimmedString(input, "end") };
  return await withIndex(conversationDir, options, (index) => {
    checkThread(texts, index, thread);
    return readRange(index, view, thread ?? "main", bounds, offset);
  });
}
