/**
 * The conversation-history search tool.
 *
 * Ported from `crates/daemon/src/tools/history.rs`, pinned by
 * `tests/engine_fixtures/history_parity.json`.
 *
 * Searches the character's frozen segments and the live active window. This is
 * deliberately not filesystem search: history is transcript data, and the
 * question "what did we say about X" is not the question "which file mentions
 * X".
 *
 * # What is searchable is narrower than what is stored
 *
 * Only the user-visible chat text participates — `text` blocks, nothing else.
 * Thinking is the model's private reasoning and tool results are machine
 * payloads, and surfacing either would let the model "remember" things the user
 * never saw. `Message.content` folds tool-result text in for replay and
 * rendering, so it is specifically *not* the field searched here.
 *
 * # Characters and bytes and code units, all in one function
 *
 * The excerpt window is a *character* count, the match index the Rust computed
 * is a *byte* offset, and TypeScript's native string index is a UTF-16 code
 * unit. All three differ on the same input, and the transcripts this searches
 * are full of emoji and CJK. Every place the three could be confused is called
 * out at its site and pinned by the fixture; the short version is that this
 * module counts code points via iteration and never indexes a string directly.
 */

import { join } from "node:path";

import { deriveContentFromBlocks, MessageStore } from "../engine/message_store";
import { SegmentReader } from "../engine/segments";
import type { ContentBlock, Message, MessageAlternative } from "../engine/types";

const ACTIVE_JSONL_FILE = "active.jsonl";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 100;
const EXCERPT_CHARS = 360;
const MIN_EXCERPT_CHARS = 80;
const MAX_EXCERPT_CHARS = 2000;

/**
 * Relevance weights. A contiguous phrase beats scattered terms, and full term
 * coverage beats partial.
 */
const TERM_HIT = 10;
const FULL_COVERAGE_BONUS = 15;
const PHRASE_BONUS = 25;
/**
 * Cap on the recency contribution, in the same units as relevance. Kept below
 * a phrase match so a recent weak hit cannot outrank an older strong one, while
 * recent matches still win among results of comparable relevance.
 */
const RECENCY_WEIGHT = 15.0;

/** An argument the caller got wrong. Reported to the model as a failed tool. */
export class InvalidArgs extends Error {
  constructor(message: string) {
    super(`invalid args: ${message}`);
    this.name = "InvalidArgs";
  }
}

/** The transcript could not be read. */
export class ToolIoError extends Error {
  constructor(message: string) {
    super(`io: ${message}`);
    this.name = "ToolIoError";
  }
}

// ── Argument parsing ────────────────────────────────────────────────────

/**
 * A string argument, trimmed, with blank treated as absent.
 *
 * A *present but non-string* value is an error rather than a silent skip: the
 * model passing `{"query": 5}` has misunderstood the schema, and saying so is
 * more useful than searching for nothing.
 */
export function optionalTrimmedString(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!(field in input)) return undefined;
  const value = input[field];
  if (typeof value !== "string") throw new InvalidArgs(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A parsed time bound.
 *
 * Both halves are needed: comparisons run on the instant, but the response
 * echoes the bound back and chrono's `to_rfc3339` *keeps the offset the caller
 * wrote*. Collapsing to an instant and reformatting would answer a query about
 * `+10:00` in UTC, which reads as though the tool ignored the timezone.
 */
interface TimeBound {
  ms: number;
  rfc3339: string;
}

/** An RFC3339 bound, or `undefined` when absent. */
export function parseTimeBound(
  input: Record<string, unknown>,
  field: string,
): TimeBound | undefined {
  const raw = optionalTrimmedString(input, field);
  if (raw === undefined) return undefined;
  const parsed = parseRfc3339Full(raw);
  if (parsed === undefined) {
    // chrono's message for every rejected shape this reaches. Kept verbatim
    // because it is what the model has been reading.
    throw new InvalidArgs(`${field} must be an RFC3339 timestamp: premature end of input`);
  }
  return parsed;
}

/**
 * The RFC3339 shape chrono accepts: date, `T`, time, optional fraction, and a
 * mandatory `Z` or `±HH:MM`.
 *
 * `Date.parse` accepts far more — `2026-01-01`, `Jan 1 2026`, and other shapes
 * the Rust rejected outright — and accepting them here would silently widen
 * every time filter, so the shape is checked before the value.
 */
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
    // `Z` is spelled `+00:00` on the way out, and a zero fraction is dropped —
    // both are what chrono emits.
    rfc3339: `${date}T${time}${echoFraction(fraction)}${/^[Zz]$/.test(offset) ? "+00:00" : offset}`,
  };
}

/**
 * Fractional seconds as chrono's `AutoSi` writes them: nothing when the value
 * is zero, otherwise padded out to milli-, micro-, or nanosecond precision.
 */
function echoFraction(fraction: string | undefined): string {
  if (fraction === undefined) return "";
  const digits = fraction.slice(1).replace(/0+$/, "");
  if (digits === "") return "";
  const width = digits.length <= 3 ? 3 : digits.length <= 6 ? 6 : 9;
  return `.${digits.padEnd(width, "0")}`;
}

/** Epoch milliseconds for an RFC3339 timestamp, or `undefined` when malformed. */
function parseRfc3339(value: string): number | undefined {
  return parseRfc3339Full(value)?.ms;
}

/** An inclusive instant range. Both ends optional; neither means "everything". */
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

/**
 * A `u64` argument, clamped, defaulting when it is anything else.
 *
 * Fractional and negative values fall back to the default rather than being
 * rounded or clamped into range — `serde_json::Value::as_u64` answers for the
 * number's representation, so `5.5` is not "5", it is "not a count".
 */
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

// ── Model filtering ─────────────────────────────────────────────────────

/**
 * Fold the ways one model is written into a single form.
 *
 * The same model differs by route — `claude-opus-4-6` direct,
 * `anthropic/claude-opus-4.6` through a gateway — so `.` and `-` compare equal
 * and case is ignored.
 */
export function normalizeModel(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

/**
 * Whether an optional minting model passes an optional *pre-normalized* filter.
 *
 * A message with no model never matches an explicit filter. Those predate model
 * tracking, and guessing that they might be the model asked for would be worse
 * than omitting them.
 */
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

// ── Query matching ──────────────────────────────────────────────────────

/**
 * A tokenized, lowercased query.
 *
 * Multi-word queries match any message containing *at least one* term, and rank
 * by how many. The whole-string substring match this replaced returned nothing
 * for most natural-language phrases, which made the tool useless for the way
 * people actually ask.
 */
export class QueryMatcher {
  readonly rawLower: string;
  readonly terms: string[];

  constructor(query: string) {
    this.rawLower = query.toLowerCase();
    this.terms = tokenize(this.rawLower);
  }

  /** Relevance, or `undefined` when `content` contains no term at all. */
  score(content: string): number | undefined {
    const contentLower = content.toLowerCase();

    // A query with no usable tokens — all single characters, or all
    // punctuation — falls back to a literal substring match so the tool still
    // does something defensible rather than matching everything.
    if (this.terms.length === 0) {
      return contentLower.includes(this.rawLower) ? PHRASE_BONUS : undefined;
    }

    const hits = this.terms.filter((t) => contentLower.includes(t)).length;
    if (hits === 0) return undefined;

    let score = hits * TERM_HIT;
    if (hits === this.terms.length) score += FULL_COVERAGE_BONUS;
    // A single-term query cannot earn the phrase bonus on top of full
    // coverage — the term *is* the phrase, and it would be counted twice.
    if (this.terms.length > 1 && contentLower.includes(this.rawLower)) score += PHRASE_BONUS;
    return score;
  }

  /**
   * UTF-16 index of the earliest match — full phrase or any single term — used
   * to centre the excerpt on the most relevant span.
   *
   * The Rust returned a *byte* offset here and its caller immediately converted
   * to a character count. Returning a UTF-16 index and converting the same way
   * gives the same character count, so the units differ from the Rust while the
   * answer does not; nothing outside this class sees the raw index.
   */
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

/**
 * Split a lowercased query into search terms.
 *
 * Two details that a plain `/\W+/` split gets wrong, both pinned:
 *
 * 1. The separator test is "not alphanumeric, and not `_` or `-`", where
 *    *alphanumeric* is the Unicode property, not ASCII. `茶` is a letter and
 *    stays part of a term; `🙂` is not and separates.
 * 2. The minimum term length is **two bytes**, not two characters. A one-letter
 *    ASCII term is dropped; a single CJK character is three bytes and is kept.
 *    A `t.length >= 2` test would throw away exactly the queries where a
 *    one-character term is the entire question.
 */
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

/** Unicode alphanumeric, plus the two joiners identifiers use. */
const TERM_CHAR = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}\p{Mn}\p{Mc}_-]/u;

function isTermChar(ch: string): boolean {
  return TERM_CHAR.test(ch);
}

// ── Excerpting ──────────────────────────────────────────────────────────

/**
 * A window of `content` around the match, in *characters*.
 *
 * With no query there is no match to centre on, so it is simply the head.
 * With one, the window starts a little before the match so the reader gets
 * context rather than landing mid-sentence, and ellipses mark each side that
 * was cut.
 */
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
    // Matched on a different field, or not at all: no ellipsis is added here,
    // deliberately — the Rust's no-match branch returns the bare head.
    return chars.slice(0, excerptChars).join("");
  }

  // The lead-in has to stay well under the window: a fixed 80 characters with
  // `excerptChars` at its 80 minimum would end the excerpt exactly where the
  // match begins.
  const leading = Math.min(Math.floor(excerptChars / 4), 80);
  // `idx` indexes the *lowercased* string. Lowercasing can change a string's
  // length (`İ` becomes two code units), so the prefix is measured on the same
  // string the index came from rather than on `content`.
  const startChar = Math.max([...contentLower.slice(0, idx)].length - leading, 0);

  let excerpt = chars.slice(startChar, startChar + excerptChars).join("");
  if (startChar > 0) excerpt = `...${excerpt}`;
  if (chars.length > startChar + excerptChars) excerpt += "...";
  return excerpt;
}

// ── Corpus scan ─────────────────────────────────────────────────────────

/**
 * The text a reader actually saw: `text` blocks only.
 *
 * See the note at the top of the file — this is the whole reason the tool does
 * not simply read `Message.content`.
 */
function chatText(blocks: ContentBlock[]): string {
  return deriveContentFromBlocks(blocks, false);
}

interface SearchFilters {
  matcher: QueryMatcher | undefined;
  range: TimeRange;
  /** Already normalized by {@link normalizeModel}. */
  modelFilter: string | undefined;
  excerptChars: number;
}

interface ScoredCandidate {
  value: Record<string, unknown>;
  relevance: number;
  /** Epoch ms, or `undefined` when the stored timestamp does not parse. */
  parsedTs: number | undefined;
}

/** No query means every message is a zero-relevance candidate, ordered by time. */
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
    // Counted and reported, not silently dropped: a transcript accumulating
    // unparseable timestamps is a real problem and the caller should see it.
    stats.skipped += 1;
    return false;
  }
  return rangeContains(range, parsed);
}

function candidate(
  relevance: number,
  timestamp: string,
  value: Record<string, unknown>,
): ScoredCandidate {
  return { relevance, parsedTs: parseRfc3339(timestamp), value };
}

function roleLabel(role: Message["role"]): string {
  return role;
}

/**
 * Score every message in `messages`, appending all matches.
 *
 * There is no early cutoff at `max_results` on purpose: with one, the oldest
 * segment fills the quota and recent matches are never reached at all.
 */
function collectMatches(
  candidates: ScoredCandidate[],
  messages: readonly Message[],
  source: string,
  filters: SearchFilters,
  stats: { skipped: number },
): void {
  const { matcher, range, modelFilter, excerptChars } = filters;

  for (const message of messages) {
    const text = chatText(message.content_blocks);
    // A turn with no chat text at all — a tool result, a thinking-only reply —
    // is skipped entirely, including for time-range-only queries where there is
    // no keyword to fail to match.
    if (text !== "" && modelMatches(message.model, modelFilter)) {
      const relevance = relevanceFor(matcher, text);
      if (relevance !== undefined && matchesTimeRange(message.timestamp, range, stats)) {
        candidates.push(
          candidate(relevance, message.timestamp, {
            msg_id: message.msg_id,
            role: roleLabel(message.role),
            timestamp: message.timestamp,
            source,
            model: message.model ?? null,
            excerpt: excerptFor(text, matcher, excerptChars),
          }),
        );
      }
    }

    const alternatives: MessageAlternative[] = message.alternatives ?? [];
    for (const [index, alternative] of alternatives.entries()) {
      // The selected alternative is already represented by the message itself.
      if (alternative.content === message.content) continue;
      const altText = chatText(alternative.content_blocks);
      if (altText === "") continue;

      // Alternatives stored before per-alternative provenance inherit the
      // parent's model, mirroring how alternative selection resolves it.
      const altModel = alternative.model ?? message.model;
      if (!modelMatches(altModel, modelFilter)) continue;

      const relevance = relevanceFor(matcher, altText);
      if (relevance === undefined) continue;

      const timestamp = alternative.timestamp === "" ? message.timestamp : alternative.timestamp;
      if (!matchesTimeRange(timestamp, range, stats)) continue;

      candidates.push(
        candidate(relevance, timestamp, {
          msg_id: message.msg_id,
          role: roleLabel(message.role),
          timestamp,
          source: `${source}:alt:${index}`,
          alternative_index: index,
          alternative_count: alternatives.length,
          model: altModel ?? null,
          excerpt: excerptFor(altText, matcher, excerptChars),
        }),
      );
    }
  }
}

// ── Ranking ─────────────────────────────────────────────────────────────

/**
 * Lexical relevance plus a recency boost normalized over the candidate span.
 *
 * The oldest candidate contributes nothing, the newest contributes
 * `RECENCY_WEIGHT`, and everything in between scales linearly — so recency
 * breaks ties among comparable matches without ever overturning a much stronger
 * one.
 */
function combinedScore(
  c: ScoredCandidate,
  minTs: number | undefined,
  spanSecs: number,
): number {
  let recency = 0;
  if (c.parsedTs !== undefined && minTs !== undefined && spanSecs > 0) {
    // Seconds, truncated toward zero, matching `num_seconds()` on a duration
    // that is never negative here.
    const elapsed = Math.trunc((c.parsedTs - minTs) / 1000);
    recency = (elapsed / spanSecs) * RECENCY_WEIGHT;
  }
  return c.relevance + recency;
}

/** Order by blended score, newest first on ties. */
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

  // `sort` is stable in every engine this runs on, which is what preserves
  // storage order among candidates that tie on both keys.
  candidates.sort((a, b) => {
    const diff = combinedScore(b, minTs, spanSecs) - combinedScore(a, minTs, spanSecs);
    if (diff !== 0) return diff < 0 ? -1 : 1;
    return compareOptionalTs(b.parsedTs, a.parsedTs);
  });
}

/**
 * Compare two optional timestamps the way `Option<DateTime>` orders.
 *
 * `None` sorts *below* every `Some`, so a message with an unparseable timestamp
 * lands last among equals rather than first.
 */
function compareOptionalTs(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// ── Entry point ─────────────────────────────────────────────────────────

export interface SearchHistoryResult {
  query: string | null;
  time_range: { start_time: string | null; end_time: string | null; inclusive: true };
  model_filter: string | null;
  results: Record<string, unknown>[];
  count: number;
  searched_messages: number;
  skipped_invalid_timestamps: number;
}

/**
 * Run a history search over a character's whole transcript.
 *
 * Throws {@link InvalidArgs} for a malformed request and {@link ToolIoError}
 * when the transcript cannot be read. Both surface to the model as a failed
 * tool rather than ending the turn.
 */
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
  };

  const candidates: ScoredCandidate[] = [];
  const stats = { skipped: 0 };
  let searchedMessages = 0;

  // The whole corpus is scanned so ranking sees every match and
  // `searched_messages` reports the true total. Segments are oldest-first;
  // active goes last.
  const segments = await ioGuard(() => SegmentReader.load(characterDataDir));
  for (let index = 0; index < segments.segmentCount(); index += 1) {
    const messages = await ioGuard(() => segments.readSegment(index));
    searchedMessages += messages.length;
    collectMatches(candidates, messages, `segment:${index}`, filters, stats);
  }

  const active = await ioGuard(() =>
    MessageStore.load(join(characterDataDir, ACTIVE_JSONL_FILE)),
  );
  searchedMessages += active.messageCount();
  collectMatches(candidates, active.messages(), "active", filters, stats);

  // Keyword queries rank by relevance blended with recency; time-range-only
  // queries stay chronological. Sorting is stable either way, which keeps
  // storage order on ties and fixes the case where an alternative's timestamp
  // diverges from its parent's position in the transcript.
  if (matcher !== undefined) {
    rankCandidates(candidates);
  } else {
    candidates.sort((a, b) => compareOptionalTs(a.parsedTs, b.parsedTs));
  }

  const results = candidates.slice(0, maxResults).map((c) => c.value);

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
