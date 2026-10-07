import { join } from "node:path";

import { asNaive, hostZone, naiveInZone, resolveInZone } from "../ledger/zoned.ts";
import {
  HISTORY_INDEX_FILE,
  HistoryIndex,
  refreshHistoryIndex,
  withHistoryIndexLock,
  type ChatLogFilter,
  type ChatLogHit,
  type ChatLogMatch,
  type ChatLogMessage,
  type ChatLogSort,
  type Speaker,
} from "../memory/history_index.ts";
import { required } from "../util/required.ts";
import { InvalidArgs, ToolIoError } from "./errors";

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
  if (!(field in input)) return undefined;
  const value = input[field];
  if (typeof value !== "string") throw new InvalidArgs(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

interface TimeBound {
  ms: number;
  rfc3339: string;
}

export function parseTimeBound(
  input: Record<string, unknown>,
  field: string,
): TimeBound | undefined {
  const raw = optionalTrimmedString(input, field);
  if (raw === undefined) return undefined;
  const parsed = parseRfc3339Full(raw);
  if (parsed === undefined) {
    throw new InvalidArgs(`${field} must be an RFC3339 timestamp: premature end of input`);
  }
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
  character: string;
  dbPath: string;
  indexPath?: string;
  userName?: string;
  timeZone?: string;
  now?: () => number;
}

interface View {
  zone: string;
  user: string;
  character: string;
  width: number;
}

function viewOf(options: ChatLogOptions): View {
  const user = options.userName ?? "user";
  return {
    zone: options.timeZone ?? hostZone(),
    user,
    character: options.character,
    width: Math.max(user.length, options.character.length),
  };
}

function checkConfigured(conversationDir: string): void {
  if (conversationDir === "") throw new InvalidArgs("conversation history is not configured");
}

async function withIndex<T>(conversationDir: string, options: ChatLogOptions, run: (index: HistoryIndex) => T): Promise<T> {
  const path = options.indexPath ?? join(conversationDir, HISTORY_INDEX_FILE);
  const ref = { mainConversationDir: conversationDir, dbPath: options.dbPath, character: options.character };
  const refreshed = async (force: boolean): Promise<HistoryIndex> => {
    await withHistoryIndexLock(path, async () => { await refreshHistoryIndex(ref, path, force); });
    return HistoryIndex.open(path);
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

function boundFrom(input: Record<string, unknown>, field: string, zone: string, end: boolean): number | undefined {
  const raw = optionalTrimmedString(input, field);
  if (raw === undefined) return undefined;
  const invalid = new InvalidArgs(`${field} must be a date like 2026-03-01, a local time like 2026-03-01T21:30, or an RFC3339 timestamp`);
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

function orList(values: readonly string[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values[values.length - 1] ?? ""}`;
}

function enumArg<T extends string>(input: Record<string, unknown>, field: string, allowed: readonly T[], fallback: T): T {
  const value = input[field];
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new InvalidArgs(`${field} must be ${orList(allowed)}`);
}

function countArg(input: Record<string, unknown>, field: string, fallback: number, max: number): number {
  const value = input[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgs(`${field} must be a whole number, 0 or more`);
  }
  return Math.min(value, max);
}

function speakerFrom(input: Record<string, unknown>, view: View): Speaker | undefined {
  const raw = optionalTrimmedString(input, "speaker");
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (value === "user" || value === view.user.toLowerCase()) return "user";
  if (value === "character" || value === view.character.toLowerCase()) return "character";
  throw new InvalidArgs(`speaker must be ${orList(["user", "character", view.user, view.character])}`);
}

function labelOf(speaker: Speaker, view: View): string {
  return speaker === "user" ? view.user : speaker === "character" ? view.character : "system";
}

function checkThread(index: HistoryIndex, thread: string | undefined): void {
  if (thread === undefined) return;
  const threads = index.threads();
  if (!threads.includes(thread)) {
    throw new InvalidArgs(`no archived thread is named ${JSON.stringify(thread)}; archived threads: ${threads.join(", ") || "none"}`);
  }
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

function emptyArchiveNote(index: HistoryIndex, zone: string): string {
  const span = archiveSpan(index, zone);
  return span === undefined
    ? "The archive is empty; messages still in your context aren't archived yet."
    : `The archive runs ${span.text}; newer messages are still in your context.`;
}

function quoteWords(query: string): string {
  return query.split(/\s+/).filter((word) => word !== "").map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
}

function scopeText(view: View, filter: ChatLogFilter, rawStart: string | undefined, rawEnd: string | undefined): string {
  const parts: string[] = [];
  if (filter.speaker !== undefined) parts.push(`from ${labelOf(filter.speaker, view)}`);
  if (filter.thread !== undefined) parts.push(`in thread ${filter.thread}`);
  if (rawStart !== undefined && rawEnd !== undefined) parts.push(`between ${rawStart} and ${rawEnd}`);
  else if (rawStart !== undefined) parts.push(`since ${rawStart}`);
  else if (rawEnd !== undefined) parts.push(`until ${rawEnd}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function sortText(sort: ChatLogSort, match: ChatLogMatch): string {
  if (sort === "oldest") return "oldest first";
  return sort === "best" && match === "words" ? "best match first" : "newest first";
}

function hitLine(hit: ChatLogHit, view: View, query: string): string {
  const thread = hit.thread === "main" ? "" : `[${hit.thread}] `;
  const heartbeat = hit.heartbeat === 1 ? "(heartbeat) " : "";
  const snippet = oneLine(hit.snippet ?? substringSnippet(hit.text, query));
  const copies = alsoIn(hit);
  const also = copies.length === 0 ? "" : ` · also in ${copies.join(", ")}`;
  return `${stamp(hit.ts, view.zone)}  ${labelOf(hit.speaker, view).padEnd(view.width)}  ${thread}${heartbeat}${snippet}  ${hit.msg_id}${also}`;
}

export async function handleSearchChatLogs(
  input: Record<string, unknown>,
  conversationDir: string,
  options: ChatLogOptions,
): Promise<string> {
  checkConfigured(conversationDir);
  const query = optionalTrimmedString(input, "query");
  if (query === undefined) throw new InvalidArgs("query is required");
  const view = viewOf(options);
  const match = enumArg(input, "match", ["words", "substring"] as const, "words");
  const sort = enumArg(input, "sort", ["best", "oldest", "newest"] as const, "best");
  const speaker = speakerFrom(input, view);
  const thread = optionalTrimmedString(input, "thread");
  const start = boundFrom(input, "start", view.zone, false);
  const end = boundFrom(input, "end", view.zone, true);
  if (start !== undefined && end !== undefined && start > end) throw new InvalidArgs("start must not be after end");
  const limit = Math.max(1, countArg(input, "limit", DEFAULT_LIMIT, MAX_LIMIT));
  const offset = countArg(input, "offset", 0, Number.MAX_SAFE_INTEGER);
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
    checkThread(index, thread);
    const lines: string[] = [];
    let expression = query;
    let total: number;
    try {
      total = index.count(match, expression, scoped);
    } catch (error) {
      if (match !== "words") throw new ToolIoError(describe(error));
      expression = quoteWords(query);
      lines.push(`Not valid FTS5 syntax (${describe(error)}), so each word was searched as written: ${expression}`);
      try {
        total = index.count(match, expression, scoped);
      } catch {
        throw new InvalidArgs(`query ${JSON.stringify(query)} has no words to search for; match="substring" searches for it as text`);
      }
    }
    const older = windowStart === undefined ? 0 : index.count(match, expression, { ...filter, end: windowStart - 1 });
    const label = match === "substring" ? `${query} (substring)` : query;
    const scope = scopeText(view, filter, optionalTrimmedString(input, "start"), optionalTrimmedString(input, "end"));
    const windowed = older > 0 ? ` in the last ${String(WINDOW_MONTHS)} months (${count(older)} older)` : "";
    if (total === 0) {
      lines.push(`${label}: 0 matches${scope}${windowed}.`);
      if (older === 0) {
        const span = archiveSpan(index, view.zone);
        lines.push(span === undefined
          ? "The archive is empty; messages still in your context aren't archived yet."
          : `Searched ${count(span.messages)} archived messages, ${span.text}. Newer messages are still in your context and aren't searched.`);
        if (match === "words") lines.push(`For partial words, typos or CJK, try match="substring".`);
      }
      return lines.join("\n");
    }
    const hits = index.search(match, expression, scoped, sort, limit, offset);
    const shown = hits.length === 0 ? "none on this page" : `showing ${count(offset + 1)}–${count(offset + hits.length)}`;
    lines.push(`${label}: ${count(total)} ${total === 1 ? "match" : "matches"}${scope}${windowed}, ${shown}, ${sortText(sort, match)}`, "");
    for (const hit of hits) lines.push(hitLine(hit, view, query));
    if (offset + hits.length < total) lines.push("", `Next page: offset=${String(offset + hits.length)}`);
    return lines.join("\n");
  });
}

function entryHead(row: ChatLogMessage, view: View, marked: boolean): string {
  const heartbeat = row.heartbeat === 1 ? "  (heartbeat)" : "";
  return `${marked ? "▶ " : ""}${stamp(row.ts, view.zone)}  ${labelOf(row.speaker, view)}${heartbeat}  ${row.msg_id}`;
}

function entrySize(row: ChatLogMessage, view: View): number {
  return entryHead(row, view, false).length + row.text.length + 3;
}

function gapText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 2 * 24 * 60) return `${String(Math.round(minutes / (24 * 60)))} days`;
  if (minutes < 60) return `${String(minutes)} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${String(Math.floor(minutes / 60))} h` : `${String(Math.floor(minutes / 60))} h ${String(rest)} min`;
}

function transcript(rows: readonly ChatLogMessage[], view: View, markId?: number): string[] {
  const lines: string[] = [];
  let previous: ChatLogMessage | undefined;
  for (const row of rows) {
    if (previous !== undefined && row.ts - previous.ts >= GAP_MS) lines.push(`· · · ${gapText(row.ts - previous.ts)} later · · ·`, "");
    lines.push(entryHead(row, view, row.id === markId), row.text, "");
    previous = row;
  }
  return lines;
}

function leftOut(earlier: number, later: number): string {
  const parts = [
    ...(earlier > 0 ? [`${String(earlier)} earlier`] : []),
    ...(later > 0 ? [`${String(later)} later`] : []),
  ];
  return `${parts.join(" and ")} ${earlier + later === 1 ? "message" : "messages"}`;
}

function readAround(index: HistoryIndex, view: View, msgId: string, thread: string | undefined, before: number, after: number): string {
  checkThread(index, thread);
  const target = index.find(msgId, thread);
  if (target === undefined) {
    return `No archived message has id ${msgId}${thread === undefined ? "" : ` in thread ${thread}`}. Messages still in your context aren't archived yet.`;
  }
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
    `${msgId} in ${target.thread}: ${String(keptEarlier.length)} before, ${String(keptLater.length)} after (${view.zone})`,
    ...(copies.length === 0 ? [] : [`Also in thread ${copies.join(", ")}.`]),
    "",
    ...transcript([...keptEarlier.reverse(), target, ...keptLater], view, target.id),
  ];
  const missing = { earlier: earlier.length - keptEarlier.length, later: later.length - keptLater.length };
  if (missing.earlier + missing.later > 0) {
    lines.push(`Stopped at about ${count(BUDGET_CHARS)} characters; ${leftOut(missing.earlier, missing.later)} not shown.`);
  }
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
  const rangeText = bounds.rawStart !== undefined && bounds.rawEnd !== undefined
    ? `${bounds.rawStart} → ${bounds.rawEnd}`
    : bounds.rawStart !== undefined ? `from ${bounds.rawStart}` : `until ${bounds.rawEnd ?? ""}`;
  const total = index.countRange(thread, low, high);
  if (total === 0) return `${thread}, ${rangeText}: no archived messages. ${emptyArchiveNote(index, view.zone)}`;
  if (offset >= total) return `${thread}, ${rangeText}: ${count(total)} messages, so offset ${String(offset)} is past the end.`;
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
    `${thread}, ${rangeText}: messages ${count(offset + 1)}–${count(offset + rows.length)} of ${count(total)} (${view.zone})`,
    "",
    ...transcript(rows, view),
  ];
  if (offset + rows.length < total) lines.push(`Next page: offset=${String(offset + rows.length)}`);
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
  if (parts === undefined || dayStart === undefined) throw new InvalidArgs("overview must be a date like 2026-03-01");
  const [year = 0, month = 1, day = 1] = parts;
  const dayEnd = nextMidnight(year, month, day, view.zone) - 1;
  const inDay = (row: ChatLogMessage) => row.ts >= dayStart && row.ts <= dayEnd;
  const conversations = conversationsOf(index.between(dayStart - DAY_MS, dayEnd + DAY_MS)).filter((c) => c.some(inDay));
  if (conversations.length === 0) return `${date}: no archived messages on this day. ${emptyArchiveNote(index, view.zone)}`;
  const onDay = conversations.reduce((sum, c) => sum + c.filter(inDay).length, 0);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  const rows = conversations.map((c) => {
    const first = required(c[0]);
    const last = required(c[c.length - 1]);
    const at = (row: ChatLogMessage) => dayOf(row.ts, view.zone) === date ? clockOf(row.ts, view.zone) : `${weekdayOf(row.ts, view.zone)} ${clockOf(row.ts, view.zone)}`;
    const opener = c.find((row) => row.speaker === "user");
    const heartbeats = c.filter((row) => row.heartbeat === 1).length;
    const rest = opener !== undefined
      ? `first: ${truncate(oneLine(opener.text), FIRST_LINE_CHARS)}`
      : heartbeats === c.length
        ? `${heartbeats === 1 ? "a heartbeat" : `${String(heartbeats)} heartbeats`} from ${view.character}, no reply from ${view.user}`
        : `${String(c.length)} from ${view.character}, none from ${view.user}`;
    return {
      range: `${at(first)} → ${at(last)}`,
      size: c.length === 1 ? "1 msg " : `${String(c.length)} msgs`,
      rest: `${first.thread === "main" ? "" : `[${first.thread}] `}${rest}`,
    };
  });
  const rangeWidth = Math.max(...rows.map((row) => row.range.length));
  const sizeWidth = Math.max(...rows.map((row) => row.size.length));
  return [
    `${date} ${weekday}: ${String(conversations.length)} ${conversations.length === 1 ? "conversation" : "conversations"}, ${count(onDay)} messages that day (split at gaps of 90+ min, ${view.zone})`,
    "",
    ...rows.map((row) => `${row.range.padEnd(rangeWidth)}  ${row.size.padStart(sizeWidth)}  ${row.rest}`),
  ].join("\n");
}

export async function handleReadChatLogs(
  input: Record<string, unknown>,
  conversationDir: string,
  options: ChatLogOptions,
): Promise<string> {
  checkConfigured(conversationDir);
  const view = viewOf(options);
  const around = optionalTrimmedString(input, "around");
  const overview = optionalTrimmedString(input, "overview");
  const start = boundFrom(input, "start", view.zone, false);
  const end = boundFrom(input, "end", view.zone, true);
  const modes = Number(around !== undefined) + Number(overview !== undefined) + Number(start !== undefined || end !== undefined);
  if (modes !== 1) throw new InvalidArgs("give exactly one of around, overview, or start and end");
  const thread = optionalTrimmedString(input, "thread");
  if (around !== undefined) {
    const before = countArg(input, "before", DEFAULT_CONTEXT, MAX_CONTEXT);
    const after = countArg(input, "after", DEFAULT_CONTEXT, MAX_CONTEXT);
    return await withIndex(conversationDir, options, (index) => readAround(index, view, around, thread, before, after));
  }
  if (overview !== undefined) return await withIndex(conversationDir, options, (index) => dayOverview(index, view, overview));
  if (start !== undefined && end !== undefined && start > end) throw new InvalidArgs("start must not be after end");
  const offset = countArg(input, "offset", 0, Number.MAX_SAFE_INTEGER);
  const bounds = { start, end, rawStart: optionalTrimmedString(input, "start"), rawEnd: optionalTrimmedString(input, "end") };
  return await withIndex(conversationDir, options, (index) => {
    checkThread(index, thread);
    return readRange(index, view, thread ?? "main", bounds, offset);
  });
}
