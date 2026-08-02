/**
 * Rendering memory search results for a human to read.
 *
 * Ported from `crates/daemon/src/memory/markdown_query.rs`, pinned by
 * `tests/memory_fixtures/markdown_parity.json`.
 *
 * `markdown_store` decides *which* files matched and in what order. This
 * decides what a person sees: a count, or a short list with one excerpt each,
 * cut around the line that actually matched rather than from the top of the
 * file.
 */

import { rustLines, rustTrim, tokenizeQuery } from "./lines";
import type { MarkdownEntry, MarkdownMemoryStore } from "./markdown_store";

/** How many hits `formatDirectResponse` will render. */
const MAX_DIRECT_HITS = 10;

/** How many characters of each hit it renders. */
const DIRECT_EXCERPT_LIMIT = 220;

/** File counts, bucketed by top-level folder. */
export interface MemoryStatus {
  totalFiles: number;
  topicFiles: number;
  dailyFiles: number;
  imageFiles: number;
}

/**
 * Count the store's files by bucket.
 *
 * `daily/` and `images/` are prefixes, so `daily.md` and `sub/daily/x.md` are
 * both topic files. Everything that is not one of the two folders counts as a
 * topic, which means the three buckets always sum to the total.
 */
export async function memoryStatus(store: MarkdownMemoryStore): Promise<MemoryStatus> {
  const status: MemoryStatus = {
    totalFiles: 0,
    topicFiles: 0,
    dailyFiles: 0,
    imageFiles: 0,
  };
  for (const entry of await store.listAll()) {
    status.totalFiles += 1;
    if (entry.path.startsWith("daily/")) status.dailyFiles += 1;
    else if (entry.path.startsWith("images/")) status.imageFiles += 1;
    else status.topicFiles += 1;
  }
  return status;
}

/** Render search hits as the text a `/memory` query returns. */
export function formatDirectResponse(query: string, hits: MarkdownEntry[]): string {
  if (hits.length === 0) return `No memory files matched '${query}'.`;

  const lines = [`Top memory matches for '${query}':`];
  for (const entry of hits.slice(0, MAX_DIRECT_HITS)) {
    lines.push(`- ${entry.path}\n  ${excerptForQuery(entry.content, query, DIRECT_EXCERPT_LIMIT)}`);
  }
  return lines.join("\n");
}

/**
 * The first `limit` characters of `text`.
 *
 * Characters, not UTF-16 code units: Rust counts `char`s, so a limit of 2 over
 * `"🌊🌊🌊"` yields two emoji, where `text.slice(0, 2)` would yield one. The
 * fixture pins exactly that case.
 */
export function truncateChars(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}

/**
 * An excerpt of `text` centred on the first line that matches `query`.
 *
 * The window is the matching line plus the one before and the one after, blank
 * lines dropped, joined with single spaces. A line matches on the whole query
 * *or* on any single term of it, so a two-word query still finds a line
 * carrying only one of the words.
 *
 * Falls back to an excerpt from the top of the text when the query is blank,
 * when nothing matches, or when the window collapses to nothing.
 */
export function excerptForQuery(text: string, query: string, limit: number): string {
  const normalizedQuery = rustTrim(query).toLowerCase();
  if (normalizedQuery === "") return excerpt(text, limit);

  // The store's scorer tokenizes the same way, two-*byte* floor included.
  // Sharing it is what keeps a hit's excerpt containing the term it was
  // ranked for; the Rust kept two copies of this split.
  const terms = tokenizeQuery(normalizedQuery);
  const lines = rustLines(text);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = rustTrim(lines[idx]!);
    // Kept for what it says, not for what it does: the query is non-empty by
    // the check above and every term is at least two bytes, so a blank line
    // could never have matched anyway. Mutation testing confirms removing it
    // changes nothing.
    if (line === "") continue;

    const lower = line.toLowerCase();
    if (!lower.includes(normalizedQuery) && !terms.some((term) => lower.includes(term))) {
      continue;
    }

    const start = Math.max(0, idx - 1);
    const end = Math.min(idx + 2, lines.length);
    // The blank filter is likewise unobservable: a blank can only sit at an
    // end of a three-line window, since the middle line is the one that
    // matched, so all it ever removes is padding `excerpt` would trim off
    // anyway. Kept because the window should be well formed where it is
    // built, rather than by accident downstream.
    const window = lines
      .slice(start, end)
      .map(rustTrim)
      .filter((l) => l !== "")
      .join(" ");

    // The Rust guarded this with `if !window.is_empty()`. Dropped: the window
    // always contains the line that just matched, and that line is non-blank
    // by the check above, so the filter can never remove everything. Mutation
    // testing found the guard unkillable, which is what sent me looking.
    return excerpt(window, limit);
  }

  return excerpt(text, limit);
}

/**
 * Flatten to one line and cut to `limit` characters, marking the cut.
 *
 * Every line is trimmed and then joined with a single space — including the
 * blank ones, which is why a run of empty lines shows up as a run of spaces
 * rather than disappearing. That is what the Rust did and the fixture records
 * it; tidying it here would change what `formatDirectResponse` prints.
 */
function excerpt(text: string, limit: number): string {
  const normalized = rustLines(text)
    .map(rustTrim)
    .join(" ");
  if ([...normalized].length > limit) {
    return `${truncateChars(normalized, limit)}...`;
  }
  return normalized;
}
