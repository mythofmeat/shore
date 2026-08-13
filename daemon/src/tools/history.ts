import { join } from "node:path";

import { deriveContentFromBlocks, MessageStore } from "../engine/message_store";
import { SegmentReader } from "../engine/segments";
import type { ContentBlock, Message, MessageAlternative } from "../engine/types";
import { InvalidArgs, ToolIoError } from "./errors";

const ACTIVE_JSONL_FILE = "active.jsonl";

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 50;
const EXCERPT_CHARS = 240;
const MIN_EXCERPT_CHARS = 80;
const MAX_EXCERPT_CHARS = 2000;

const TERM_HIT = 10;
const FULL_COVERAGE_BONUS = 15;
const PHRASE_BONUS = 25;
const RECENCY_WEIGHT = 15.0;

export { InvalidArgs, ToolIoError };

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

function parseRfc3339(value: string): number | undefined {
  return parseRfc3339Full(value)?.ms;
}

export interface TimeRange {
  start?: TimeBound;
  end?: TimeBound;
}

export function rangeIsEmpty(range: TimeRange): boolean {
  return range.start === undefined && range.end === undefined;
}

function rangeContains(range: TimeRange, timestamp: number): boolean {
  if (range.start !== undefined && timestamp < range.start.ms) return false;
  if (range.end !== undefined && timestamp > range.end.ms) return false;
  return true;
}

export function filtersFrom(input: Record<string, unknown>): {
  query: string | undefined;
  range: TimeRange;
} {
  const query = optionalTrimmedString(input, "query");
  const start = parseTimeBound(input, "start_time");
  const end = parseTimeBound(input, "end_time");

  if (start !== undefined && end !== undefined && start.ms > end.ms) {
    throw new InvalidArgs("start_time must be before or equal to end_time");
  }

  return {
    query,
    range: {
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    },
  };
}

function unsignedArg(
  input: Record<string, unknown>,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = input[field];
  const n =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  return Math.min(Math.max(n, min), max);
}

export function maxResultsFrom(input: Record<string, unknown>): number {
  return unsignedArg(input, "max_results", DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
}

export function excerptCharsFrom(input: Record<string, unknown>): number {
  return unsignedArg(input, "excerpt_chars", EXCERPT_CHARS, MIN_EXCERPT_CHARS, MAX_EXCERPT_CHARS);
}

export function normalizeModel(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

export function modelMatches(
  model: string | undefined,
  filter: string | undefined,
): boolean {
  if (filter === undefined) return true;
  if (model === undefined) return false;
  return normalizeModel(model).includes(filter);
}

function modelFilterFrom(input: Record<string, unknown>): string | undefined {
  const raw = optionalTrimmedString(input, "model");
  return raw === undefined ? undefined : normalizeModel(raw);
}

export class QueryMatcher {
  readonly rawLower: string;
  readonly terms: string[];

  constructor(query: string) {
    this.rawLower = query.toLowerCase();
    this.terms = tokenize(this.rawLower);
  }

  score(content: string): number | undefined {
    const contentLower = content.toLowerCase();

    if (this.terms.length === 0) {
      return contentLower.includes(this.rawLower) ? PHRASE_BONUS : undefined;
    }

    const hits = this.terms.filter((t) => contentLower.includes(t)).length;
    if (hits === 0) return undefined;

    let score = hits * TERM_HIT;
    if (hits === this.terms.length) score += FULL_COVERAGE_BONUS;
    if (this.terms.length > 1 && contentLower.includes(this.rawLower)) score += PHRASE_BONUS;
    return score;
  }

  coverage(content: string): number {
    const contentLower = content.toLowerCase();
    if (this.terms.length === 0) return contentLower.includes(this.rawLower) ? 1 : 0;
    return new Set(this.terms.filter((term) => contentLower.includes(term))).size;
  }

  earliestIndex(contentLower: string): number | undefined {
    let best = indexOrUndefined(contentLower, this.rawLower);
    for (const term of this.terms) {
      const idx = contentLower.indexOf(term);
      if (idx !== -1) best = best === undefined ? idx : Math.min(best, idx);
    }
    return best;
  }
}

function indexOrUndefined(haystack: string, needle: string): number | undefined {
  const i = haystack.indexOf(needle);
  return i === -1 ? undefined : i;
}

function tokenize(rawLower: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of rawLower) {
    if (isTermChar(ch)) {
      current += ch;
    } else {
      if (Buffer.byteLength(current, "utf8") >= 2) out.push(current);
      current = "";
    }
  }
  if (Buffer.byteLength(current, "utf8") >= 2) out.push(current);
  return out;
}

const TERM_CHAR = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}\p{Mn}\p{Mc}_-]/u;

function isTermChar(ch: string): boolean {
  return TERM_CHAR.test(ch);
}

export function excerptFor(
  content: string,
  matcher: QueryMatcher | undefined,
  excerptChars: number,
): string {
  const chars = [...content];

  if (matcher === undefined) {
    const excerpt = chars.slice(0, excerptChars).join("");
    return chars.length > excerptChars ? `${excerpt}...` : excerpt;
  }

  const contentLower = content.toLowerCase();
  const idx = matcher.earliestIndex(contentLower);
  if (idx === undefined) {
    return chars.slice(0, excerptChars).join("");
  }

  const leading = Math.min(Math.floor(excerptChars / 4), 80);
  const startChar = Math.max([...contentLower.slice(0, idx)].length - leading, 0);

  let excerpt = chars.slice(startChar, startChar + excerptChars).join("");
  if (startChar > 0) excerpt = `...${excerpt}`;
  if (chars.length > startChar + excerptChars) excerpt += "...";
  return excerpt;
}

function cleanExcerptFor(
  content: string,
  matcher: QueryMatcher | undefined,
  excerptChars: number,
): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  let excerpt = excerptFor(normalized, matcher, excerptChars);
  const leading = excerpt.startsWith("...");
  const trailing = excerpt.endsWith("...");
  if (leading) excerpt = excerpt.slice(3);
  if (trailing) excerpt = excerpt.slice(0, -3);
  if (leading) {
    const boundary = excerpt.indexOf(" ");
    if (boundary >= 0) excerpt = excerpt.slice(boundary + 1);
  }
  if (trailing) {
    const boundary = excerpt.lastIndexOf(" ");
    if (boundary >= 0) excerpt = excerpt.slice(0, boundary);
  }
  return `${leading ? "… " : ""}${excerpt.trim()}${trailing ? " …" : ""}`;
}

function chatText(blocks: ContentBlock[]): string {
  return deriveContentFromBlocks(blocks, false);
}

interface SearchFilters {
  matcher: QueryMatcher | undefined;
  range: TimeRange;
  modelFilter: string | undefined;
  excerptChars: number;
  includeAlternatives: boolean;
}

interface ScoredCandidate {
  value: Record<string, unknown>;
  relevance: number;
  coverage: number;
  normalizedText: string;
  parsedTs: number | undefined;
}

function relevanceFor(
  matcher: QueryMatcher | undefined,
  content: string,
): number | undefined {
  return matcher === undefined ? 0 : matcher.score(content);
}

export function matchesTimeRange(
  timestamp: string,
  range: TimeRange,
  stats: { skipped: number },
): boolean {
  if (rangeIsEmpty(range)) return true;
  const parsed = parseRfc3339(timestamp);
  if (parsed === undefined) {
    stats.skipped += 1;
    return false;
  }
  return rangeContains(range, parsed);
}

function candidate(
  relevance: number,
  coverage: number,
  text: string,
  timestamp: string,
  value: Record<string, unknown>,
): ScoredCandidate {
  return {
    relevance,
    coverage,
    normalizedText: text.toLowerCase().replace(/\s+/gu, " ").trim(),
    parsedTs: parseRfc3339(timestamp),
    value,
  };
}

function roleLabel(role: Message["role"]): string {
  return role;
}

function collectMatches(
  candidates: ScoredCandidate[],
  messages: readonly Message[],
  filters: SearchFilters,
  stats: { skipped: number },
): void {
  const { matcher, range, modelFilter, excerptChars, includeAlternatives } = filters;

  for (const message of messages) {
    const text = chatText(message.content_blocks);
    if (text !== "" && modelMatches(message.model, modelFilter)) {
      const relevance = relevanceFor(matcher, text);
      if (relevance !== undefined && matchesTimeRange(message.timestamp, range, stats)) {
        candidates.push(
          candidate(relevance, matcher?.coverage(text) ?? 0, text, message.timestamp, {
            msg_id: message.msg_id,
            role: roleLabel(message.role),
            timestamp: message.timestamp,
            model: message.model ?? null,
            text: cleanExcerptFor(text, matcher, excerptChars),
          }),
        );
      }
    }

    if (!includeAlternatives) continue;
    const alternatives: MessageAlternative[] = message.alternatives ?? [];
    for (const [index, alternative] of alternatives.entries()) {
      if (alternative.content === message.content) continue;
      const altText = chatText(alternative.content_blocks);
      if (altText === "") continue;

      const altModel = alternative.model ?? message.model;
      if (!modelMatches(altModel, modelFilter)) continue;

      const relevance = relevanceFor(matcher, altText);
      if (relevance === undefined) continue;

      const timestamp = alternative.timestamp === "" ? message.timestamp : alternative.timestamp;
      if (!matchesTimeRange(timestamp, range, stats)) continue;

      candidates.push(
        candidate(relevance, matcher?.coverage(altText) ?? 0, altText, timestamp, {
          msg_id: message.msg_id,
          role: roleLabel(message.role),
          timestamp,
          alternative_index: index,
          alternative_count: alternatives.length,
          model: altModel ?? null,
          text: cleanExcerptFor(altText, matcher, excerptChars),
        }),
      );
    }
  }
}

function combinedScore(
  c: ScoredCandidate,
  minTs: number | undefined,
  spanSecs: number,
): number {
  let recency = 0;
  if (c.parsedTs !== undefined && minTs !== undefined && spanSecs > 0) {
    const elapsed = Math.trunc((c.parsedTs - minTs) / 1000);
    recency = (elapsed / spanSecs) * RECENCY_WEIGHT;
  }
  return c.relevance + recency;
}

function rankCandidates(candidates: ScoredCandidate[]): void {
  let minTs: number | undefined;
  let maxTs: number | undefined;
  for (const c of candidates) {
    if (c.parsedTs === undefined) continue;
    minTs = minTs === undefined ? c.parsedTs : Math.min(minTs, c.parsedTs);
    maxTs = maxTs === undefined ? c.parsedTs : Math.max(maxTs, c.parsedTs);
  }
  const spanSecs =
    minTs !== undefined && maxTs !== undefined
      ? Math.max(Math.trunc((maxTs - minTs) / 1000), 0)
      : 0;

  candidates.sort((a, b) => {
    const diff = combinedScore(b, minTs, spanSecs) - combinedScore(a, minTs, spanSecs);
    if (diff !== 0) return diff < 0 ? -1 : 1;
    return compareOptionalTs(b.parsedTs, a.parsedTs);
  });
}

function bestResults(
  candidates: ScoredCandidate[],
  matcher: QueryMatcher | undefined,
  maxResults: number,
): Record<string, unknown>[] {
  let eligible = candidates;
  if (matcher !== undefined && matcher.terms.length > 1 && candidates.length > 0) {
    const bestCoverage = Math.max(...candidates.map((candidate) => candidate.coverage));
    eligible = candidates.filter((candidate) => candidate.coverage === bestCoverage);
  }
  const seen = new Set<string>();
  const results: Record<string, unknown>[] = [];
  for (const candidate of eligible) {
    if (seen.has(candidate.normalizedText)) continue;
    seen.add(candidate.normalizedText);
    results.push(candidate.value);
    if (results.length === maxResults) break;
  }
  return results;
}

function compareOptionalTs(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export interface SearchHistoryResult {
  query: string | null;
  time_range: { start_time: string | null; end_time: string | null; inclusive: true };
  model_filter: string | null;
  results: Record<string, unknown>[];
  count: number;
  searched_messages: number;
  skipped_invalid_timestamps: number;
}

export async function handleSearchHistory(
  input: Record<string, unknown>,
  characterDataDir: string,
): Promise<SearchHistoryResult> {
  if (characterDataDir === "") {
    throw new InvalidArgs("conversation history is not configured");
  }

  const { query, range } = filtersFrom(input);
  const modelFilter = modelFilterFrom(input);
  if (query === undefined && rangeIsEmpty(range) && modelFilter === undefined) {
    throw new InvalidArgs("provide query, start_time, end_time, model, or a combination");
  }

  const matcher = query === undefined ? undefined : new QueryMatcher(query);
  const maxResults = maxResultsFrom(input);
  const filters: SearchFilters = {
    matcher,
    range,
    modelFilter,
    excerptChars: excerptCharsFrom(input),
    includeAlternatives: input["include_alternatives"] === true,
  };

  const candidates: ScoredCandidate[] = [];
  const stats = { skipped: 0 };
  let searchedMessages = 0;

  const segments = await ioGuard(() => SegmentReader.load(characterDataDir));
  try {
    for (let index = 0; index < segments.segmentCount(); index += 1) {
      const messages = await ioGuard(() => segments.readSegment(index));
      searchedMessages += messages.length;
      collectMatches(candidates, messages, filters, stats);
    }
  } finally {
    segments.close();
  }

  const active = await ioGuard(() =>
    MessageStore.load(join(characterDataDir, ACTIVE_JSONL_FILE)),
  );
  searchedMessages += active.messageCount();
  collectMatches(candidates, active.messages(), filters, stats);

  if (matcher !== undefined) {
    rankCandidates(candidates);
  } else {
    candidates.sort((a, b) => compareOptionalTs(a.parsedTs, b.parsedTs));
  }

  const results = bestResults(candidates, matcher, maxResults);

  return {
    query: query ?? null,
    time_range: {
      start_time: range.start?.rfc3339 ?? null,
      end_time: range.end?.rfc3339 ?? null,
      inclusive: true,
    },
    model_filter: modelFilter ?? null,
    results,
    count: results.length,
    searched_messages: searchedMessages,
    skipped_invalid_timestamps: stats.skipped,
  };
}

async function ioGuard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof InvalidArgs) throw e;
    throw new ToolIoError(e instanceof Error ? e.message : String(e));
  }
}
