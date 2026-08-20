import { join } from "node:path";

import { deriveContentFromBlocks } from "../engine/message_store";
import { SegmentReader } from "../engine/segments";
import type { ContentBlock, Message } from "../engine/types";
import type { Embedder } from "../llm/embed.ts";
import {
  HistorySearchIndex,
  loadCanonicalTexts,
  withHistoryIndexLock,
  type IndexedMessage,
} from "../memory/history_index.ts";
import { InvalidArgs, ToolIoError } from "./errors";

const DEFAULT_MAX_RESULTS = 3;
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
  const startChar = Math.max(Array.from(contentLower.slice(0, idx)).length - leading, 0);

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

function scoredCandidate(
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
  const { matcher, range, modelFilter, excerptChars } = filters;

  for (const message of messages) {
    const text = chatText(message.content_blocks);
    if (text === "" || !modelMatches(message.model, modelFilter)) continue;
    const relevance = relevanceFor(matcher, text);
    if (relevance === undefined || !matchesTimeRange(message.timestamp, range, stats)) continue;
    candidates.push(
      scoredCandidate(relevance, matcher?.coverage(text) ?? 0, text, message.timestamp, {
        msg_id: message.msg_id,
        role: roleLabel(message.role),
        timestamp: message.timestamp,
        model: message.model ?? null,
        text: cleanExcerptFor(text, matcher, excerptChars),
      }),
    );
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

export interface LegacySearchHistoryResult {
  query: string | null;
  time_range: { start_time: string | null; end_time: string | null; inclusive: true };
  model_filter: string | null;
  results: Record<string, unknown>[];
  count: number;
  searched_messages: number;
  skipped_invalid_timestamps: number;
}

export async function handleLegacySearchHistory(
  input: Record<string, unknown>,
  characterDataDir: string,
): Promise<LegacySearchHistoryResult> {
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

export type HistorySearchMode = "auto" | "lexical" | "hybrid" | "vector";

export interface HistorySearchOptions {
  indexPath?: string;
  embedder?: Embedder;
  defaultMode?: HistorySearchMode;
}

interface RankedHistoryCandidate {
  row: IndexedMessage;
  text: string;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalScore: number;
  coverage: number;
  phrase: boolean;
  timestampMs: number | undefined;
}

export interface SearchHistoryResult {
  mode: Exclude<HistorySearchMode, "auto">;
  semantic_index: {
    indexed_chunks: number;
    total_chunks: number;
    pending_chunks: number;
  };
  semantic_unavailable?: string;
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
  options: HistorySearchOptions = {},
): Promise<SearchHistoryResult> {
  const path = options.indexPath ?? join(characterDataDir, "history_search.db");
  return await withHistoryIndexLock(path, async () =>
    await handleSearchHistoryUnlocked(input, characterDataDir, options),
  );
}

async function handleSearchHistoryUnlocked(
  input: Record<string, unknown>,
  characterDataDir: string,
  options: HistorySearchOptions,
): Promise<SearchHistoryResult> {
  if (characterDataDir === "") throw new InvalidArgs("conversation history is not configured");
  const { query, range } = filtersFrom(input);
  const modelFilter = modelFilterFrom(input);
  if (query === undefined && rangeIsEmpty(range) && modelFilter === undefined) {
    throw new InvalidArgs("provide query, start_time, end_time, model, or a combination");
  }
  const requested = searchModeFrom(input, options.defaultMode ?? "auto");
  let mode: Exclude<HistorySearchMode, "auto"> = requested === "auto"
    ? options.embedder === undefined ? "lexical" : "hybrid"
    : requested;
  if (query === undefined) mode = "lexical";
  let semanticUnavailable: string | undefined;
  if ((mode === "hybrid" || mode === "vector") && options.embedder === undefined) {
    semanticUnavailable = "embedder_not_configured";
    mode = "lexical";
  }

  const index = await openAndReconcile(characterDataDir, options.indexPath);
  try {
    const diagnostics = index.diagnostics(options.embedder);
    const stats = { skipped: 0 };
    const matcher = query === undefined ? undefined : new QueryMatcher(query);
    let lexical: RankedHistoryCandidate[] = [];
    if (mode !== "vector") {
      lexical = await lexicalCandidates(index, characterDataDir, matcher, range, modelFilter, stats);
    }

    let vector: RankedHistoryCandidate[] = [];
    if ((mode === "hybrid" || mode === "vector") && query !== undefined && options.embedder !== undefined) {
      try {
        const vectors = await options.embedder.embed([query]);
        const queryVector = vectors[0];
        if (queryVector === undefined) throw new Error("embedding response did not include query vector");
        vector = await vectorCandidates(
          index,
          characterDataDir,
          queryVector,
          options.embedder,
          range,
          modelFilter,
          { skipped: 0 },
        );
      } catch (error) {
        semanticUnavailable = `query_embedding_failed: ${describeFailure(error)}`;
        mode = "lexical";
        if (lexical.length === 0) {
          lexical = await lexicalCandidates(index, characterDataDir, matcher, range, modelFilter, stats);
        }
      }
    }
    if (requested === "vector" && diagnostics.pending_chunks > 0 && semanticUnavailable === undefined) {
      semanticUnavailable = "incomplete_vector_coverage";
    }

    const ranked = mode === "hybrid"
      ? fuseCandidates(lexical, vector)
      : mode === "vector" ? vector : lexical;
    const chosen = deduplicateMessages(ranked).slice(0, maxResultsFrom(input));
    const neighborRows: IndexedMessage[] = [];
    for (const hit of chosen) {
      const before = index.neighbor(hit.row, -1);
      const after = index.neighbor(hit.row, 1);
      if (before !== undefined) neighborRows.push(before);
      if (after !== undefined) neighborRows.push(after);
    }
    const neighborTexts = await loadCanonicalTexts(characterDataDir, neighborRows);
    const results = chosen.map((hit) => {
      const before = index.neighbor(hit.row, -1);
      const after = index.neighbor(hit.row, 1);
      return {
        ...presentMessage(hit.row, hit.text),
        before: before === undefined ? [] : [presentMessage(before, neighborTexts.get(before.id) ?? "")],
        after: after === undefined ? [] : [presentMessage(after, neighborTexts.get(after.id) ?? "")],
      };
    });

    return {
      mode,
      semantic_index: diagnostics,
      ...(semanticUnavailable === undefined ? {} : { semantic_unavailable: semanticUnavailable }),
      query: query ?? null,
      time_range: {
        start_time: range.start?.rfc3339 ?? null,
        end_time: range.end?.rfc3339 ?? null,
        inclusive: true,
      },
      model_filter: modelFilter ?? null,
      results,
      count: results.length,
      searched_messages: index.selectedMessageCount(),
      skipped_invalid_timestamps: stats.skipped,
    };
  } finally {
    index.close();
  }
}

async function openAndReconcile(
  characterDataDir: string,
  path: string | undefined,
): Promise<HistorySearchIndex> {
  const open = () => HistorySearchIndex.open({
    characterDataDir,
    ...(path === undefined ? {} : { path }),
  });
  let index = open();
  try {
    await index.reconcile();
    return index;
  } catch (error) {
    index.close();
    try {
      const fs = await import("node:fs/promises");
      await fs.unlink(path ?? join(characterDataDir, "history_search.db"));
    } catch {}
    index = open();
    try {
      await index.reconcile(true);
      return index;
    } catch (retryError) {
      index.close();
      throw new ToolIoError(describeFailure(retryError ?? error));
    }
  }
}

function searchModeFrom(input: Record<string, unknown>, fallback: HistorySearchMode): HistorySearchMode {
  const raw = input["mode"];
  if (raw === undefined) return fallback;
  if (raw === "auto" || raw === "lexical" || raw === "hybrid" || raw === "vector") return raw;
  throw new InvalidArgs("mode must be auto, lexical, hybrid, or vector");
}

async function lexicalCandidates(
  index: HistorySearchIndex,
  characterDataDir: string,
  matcher: QueryMatcher | undefined,
  range: TimeRange,
  modelFilter: string | undefined,
  stats: { skipped: number },
): Promise<RankedHistoryCandidate[]> {
  const indexed = matcher === undefined
    ? index.allRows().map((row, i) => ({ row, rank: i + 1 }))
    : index.lexicalRows(matcher.rawLower);
  const source = matcher !== undefined && indexed.length === 0
    ? index.allRows().map((row, i) => ({ row, rank: i + 1 }))
    : indexed;
  const eligible = source.filter(({ row }) =>
    modelMatches(row.model ?? undefined, modelFilter) && matchesTimeRange(row.timestamp, range, stats),
  );
  const texts = await loadCanonicalTexts(characterDataDir, eligible.map(({ row }) => row));
  const candidates: RankedHistoryCandidate[] = [];
  for (const { row, rank } of eligible) {
    const text = texts.get(row.id);
    if (text === undefined) continue;
    const matchedScore = matcher?.score(text);
    if (matcher !== undefined && matchedScore === undefined) continue;
    const lexicalScore = matchedScore ?? 0;
    candidates.push({
      row,
      text,
      lexicalRank: rank,
      lexicalScore,
      coverage: matcher?.coverage(text) ?? 0,
      phrase: matcher === undefined ? false : text.toLocaleLowerCase().includes(matcher.rawLower),
      timestampMs: parseRfc3339(row.timestamp),
    });
  }
  if (matcher === undefined) {
    candidates.sort((a, b) => compareOptionalTs(a.timestampMs, b.timestampMs) || compareIndexed(a.row, b.row));
  } else {
    candidates.sort((a, b) =>
      Number(b.phrase) - Number(a.phrase) ||
      b.coverage - a.coverage ||
      b.lexicalScore - a.lexicalScore ||
      (a.lexicalRank ?? 0) - (b.lexicalRank ?? 0) ||
      compareOptionalTs(b.timestampMs, a.timestampMs) ||
      compareIndexed(a.row, b.row),
    );
  }
  candidates.forEach((candidate, i) => { candidate.lexicalRank = i + 1; });
  return candidates;
}

async function vectorCandidates(
  index: HistorySearchIndex,
  characterDataDir: string,
  queryVector: readonly number[],
  embedder: Embedder,
  range: TimeRange,
  modelFilter: string | undefined,
  stats: { skipped: number },
): Promise<RankedHistoryCandidate[]> {
  const raw = index.vectorRows(queryVector, embedder).filter(({ row }) =>
    modelMatches(row.model ?? undefined, modelFilter) && matchesTimeRange(row.timestamp, range, stats),
  );
  const texts = await loadCanonicalTexts(characterDataDir, raw.map(({ row }) => row));
  return raw.flatMap(({ row, rank }) => {
    const text = texts.get(row.id);
    return text === undefined ? [] : [{
      row, text, vectorRank: rank, lexicalScore: 0, coverage: 0, phrase: false,
      timestampMs: parseRfc3339(row.timestamp),
    }];
  });
}

function fuseCandidates(
  lexical: readonly RankedHistoryCandidate[],
  vector: readonly RankedHistoryCandidate[],
): RankedHistoryCandidate[] {
  const byId = new Map<number, RankedHistoryCandidate & { fused: number }>();
  const add = (candidate: RankedHistoryCandidate, rank: number, kind: "lexical" | "vector") => {
    const current = byId.get(candidate.row.id) ?? { ...candidate, fused: 0 };
    current.fused += 1 / (60 + rank);
    if (kind === "lexical") current.lexicalRank = rank;
    else current.vectorRank = rank;
    byId.set(candidate.row.id, current);
  };
  lexical.forEach((candidate, i) => add(candidate, i + 1, "lexical"));
  vector.forEach((candidate, i) => add(candidate, i + 1, "vector"));
  return [...byId.values()].sort((a, b) =>
    b.fused - a.fused ||
    Number(b.phrase) - Number(a.phrase) ||
    b.coverage - a.coverage ||
    compareOptionalTs(b.timestampMs, a.timestampMs) ||
    compareIndexed(a.row, b.row),
  );
}

function deduplicateMessages(candidates: readonly RankedHistoryCandidate[]): RankedHistoryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.row.segment}:${candidate.row.ordinal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function presentMessage(row: IndexedMessage, text: string): Record<string, unknown> {
  return {
    msg_id: row.msg_id,
    role: row.role,
    timestamp: row.timestamp,
    model: row.model,
    text,
  };
}

function compareIndexed(a: IndexedMessage, b: IndexedMessage): number {
  return a.segment - b.segment || a.ordinal - b.ordinal;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ioGuard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof InvalidArgs) throw e;
    throw new ToolIoError(e instanceof Error ? e.message : String(e));
  }
}
