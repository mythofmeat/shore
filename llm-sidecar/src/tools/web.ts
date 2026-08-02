/**
 * `web_search` and `fetch_url`.
 *
 * Ported from `crates/daemon/src/tools/web.rs`, pinned by
 * `tests/tools_fixtures/web_images_parity.json`.
 *
 * The HTTP is not what needed care. {@link stripHtml} and the byte-accurate
 * truncation are: both walk UTF-8 by byte offset, and JavaScript measures
 * strings in UTF-16 code units, so the naive port is wrong on every non-ASCII
 * page in a way no ASCII test reveals.
 */

import { InvalidArgs, ToolIoError } from "./errors.ts";

/** Reported as `http:` — a remote call that failed, not the caller's mistake. */
export class ToolHttpError extends Error {
  constructor(message: string) {
    super(`http: ${message}`);
    this.name = "ToolHttpError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The part of `fetch` these handlers use.
 *
 * Narrower than `typeof fetch` on purpose: Bun's `fetch` carries extras like
 * `preconnect`, and requiring those of an injected stub would mean every test
 * double had to fake them.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Maximum content returned to the model, in **bytes**, cut on a char boundary. */
export const MAX_CONTENT_BYTES = 50_000;

// ── Byte-accurate truncation ────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Truncate to at most `maxBytes` **UTF-8 bytes**, never splitting a character.
 *
 * This is `String::len()` plus `floor_char_boundary`, and there is no way to
 * spell either in terms of JavaScript string indices: `.length` counts UTF-16
 * code units (so `"🎵".length` is 2 where Rust sees 4 bytes), and `.slice()`
 * will happily cut a surrogate pair in half. Encoding to bytes and decoding
 * back is the honest translation.
 *
 * `TextDecoder` with `fatal: false` would replace a partial trailing sequence
 * with U+FFFD, which is not what `floor_char_boundary` does — it backs the cut
 * off instead — so the boundary is found first and the slice is always valid.
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { content: text, truncated: false };

  // Back off to a UTF-8 boundary: continuation bytes are 0b10xxxxxx.
  //
  // The parentheses around the cast are load-bearing. `bytes[end] as number &
  // 0b1100_0000` parses as `bytes[end] as (number & 0b1100_0000)` — a type
  // intersection, not a bitwise AND — so the mask silently vanishes and the
  // loop only backs off a byte that happens to equal 0x80.
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { content: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

// ── HTML extraction ─────────────────────────────────────────────────────

/** Blocks dropped whole, content included. */
const SKIPPED_BLOCKS = ["script", "style", "head"] as const;

/**
 * Entity decoding, applied as an ordered sequence of whole-string replacements.
 *
 * The order is behaviour, not style. `&amp;` runs **first**, so an escaped
 * entity is decoded twice: `&amp;lt;` becomes `&lt;` and then `<`. Reordering
 * this table, or decoding in a single pass, changes what the model reads.
 */
const ENTITIES: readonly (readonly [string, string])[] = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&nbsp;", " "],
  ["&#x27;", "'"],
  ["&#x2F;", "/"],
];

/** `str::to_ascii_lowercase` — ASCII only, so `ｓ` is not `s`. */
function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Strip HTML tags and extract readable text.
 *
 * Three phases, and they interact in ways worth knowing:
 *
 * 1. **Block removal.** `<script>`, `<style>` and `<head>` go with their
 *    contents, matched case-insensitively in ASCII. An *unclosed* one drops
 *    everything after it — the Rust breaks out of the walk rather than
 *    recovering, so a page with a stray `<script` returns only its prefix.
 * 2. **Tag removal.** Any other `<…>` becomes a single space, because block
 *    elements are word boundaries. A `<` with no `>` after it is not a tag at
 *    all and survives as literal text.
 * 3. **Entity decoding, then whitespace collapse.** Decoding runs *after* tag
 *    stripping, so `&lt;script&gt;` decodes to the literal text `<script>` and
 *    is *not* treated as a tag. This is not a sanitizer and must not be used
 *    as one.
 */
export function stripHtml(html: string): string {
  // Phase 1 & 2. Indices are JavaScript string indices rather than the Rust's
  // byte offsets; every one is derived from a search over the same string, so
  // the substrings they cut are identical either way.
  let cleaned = "";
  let i = 0;

  while (i < html.length) {
    if (html[i] === "<") {
      const remainingLower = asciiLowercase(html.slice(i));
      const tag = SKIPPED_BLOCKS.find((t) => remainingLower.startsWith(`<${t}`));
      if (tag !== undefined) {
        const close = `</${tag}`;
        const endPos = remainingLower.indexOf(close);
        if (endPos !== -1) {
          const afterClose = i + endPos + close.length;
          const gt = html.indexOf(">", afterClose);
          if (gt !== -1) {
            i = gt + 1;
            continue;
          }
        }
        // No closing tag — the rest of the document is dropped.
        break;
      }

      const gt = html.indexOf(">", i);
      if (gt !== -1) {
        cleaned += " ";
        i = gt + 1;
        continue;
      }
      // A `<` with no `>` after it falls through and is kept verbatim.
    }

    // One UTF-16 unit at a time is enough, even for astral characters: the
    // surrogates are copied in order and reassemble on their own, and neither
    // half can be `<`. The Rust advances by `len_utf8()` for the same reason —
    // it is walking bytes, not characters.
    cleaned += html[i] as string;
    i += 1;
  }

  // Phase 3a: entities, in order.
  let decoded = cleaned;
  for (const [from, to] of ENTITIES) {
    decoded = decoded.split(from).join(to);
  }

  // Phase 3b: collapse whitespace runs to one space, then trim.
  // `\p{White_Space}` is exactly `char::is_whitespace`; JavaScript's own `\s`
  // and `trim` use a different set — see `memory/lines.ts`.
  return decoded.replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, "");
}

// ── web_search ──────────────────────────────────────────────────────────

/** The `[tools.web_search]` fields this module reads. */
export interface SearchConfigView {
  api_key_env: string;
  result_limit: number;
  search_depth: string;
  include_answer: boolean;
}

export interface WebSearchResult {
  query: string;
  results: { title: string; url: string; content: string }[];
  answer?: string;
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Handle `web_search`.
 *
 * A result field the provider omits becomes `""`, not `undefined` — the model
 * reads a uniform shape and a missing title is not an error worth failing the
 * whole search over. `answer` is the exception: it is present only when Tavily
 * returned one, because an empty answer and no answer mean different things.
 */
export async function handleWebSearch(
  input: Record<string, unknown>,
  searchConfig: SearchConfigView,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<WebSearchResult> {
  const query = input["query"];
  if (typeof query !== "string") {
    throw new InvalidArgs("missing 'query' field");
  }

  const apiKey = env[searchConfig.api_key_env];
  if (apiKey === undefined) {
    throw new InvalidArgs(
      `web_search requires the ${searchConfig.api_key_env} environment variable to be set`,
    );
  }

  const rawMax = input["max_results"];
  const maxResults =
    typeof rawMax === "number" && Number.isSafeInteger(rawMax) && rawMax >= 0
      ? rawMax
      : searchConfig.result_limit;

  let resp: Response;
  try {
    resp = await fetchImpl(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: searchConfig.search_depth,
        include_answer: searchConfig.include_answer,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ToolHttpError(`Tavily request failed: ${String(e)}`);
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new ToolHttpError(`Tavily API returned HTTP ${resp.status}: ${errBody}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (e) {
    throw new ToolHttpError(`failed to parse Tavily response: ${String(e)}`);
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const rawResults = Array.isArray(raw["results"]) ? raw["results"] : [];
  const results = rawResults.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      title: typeof row["title"] === "string" ? row["title"] : "",
      url: typeof row["url"] === "string" ? row["url"] : "",
      content: typeof row["content"] === "string" ? row["content"] : "",
    };
  });

  const answer = raw["answer"];
  return {
    query,
    results,
    ...(typeof answer === "string" ? { answer } : {}),
  };
}

// ── fetch_url ───────────────────────────────────────────────────────────

export interface FetchUrlResult {
  url: string;
  content_type: string;
  content: string;
  truncated: boolean;
}

/**
 * Handle `fetch_url`.
 *
 * HTML is detected by a substring match on the content type, not a parse — a
 * `text/html; charset=utf-8` and an `application/xhtml+xml` both extract, and
 * anything else is returned as-is. A response with no content type at all
 * reports `"unknown"` and is treated as non-HTML.
 */
export async function handleFetchUrl(
  input: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<FetchUrlResult> {
  const url = input["url"];
  if (typeof url !== "string") {
    throw new InvalidArgs("missing 'url' field");
  }

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      headers: { "user-agent": "shore/2.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ToolHttpError(`request failed: ${String(e)}`);
  }

  if (!resp.ok) {
    throw new ToolHttpError(`HTTP ${resp.status} for ${url}`);
  }

  const contentType = resp.headers.get("content-type") ?? "unknown";

  let body: string;
  try {
    body = await resp.text();
  } catch (e) {
    throw new ToolHttpError(`failed to read body: ${String(e)}`);
  }

  const extracted = contentType.includes("html") ? stripHtml(body) : body;
  const { content, truncated } = truncateToBytes(extracted, MAX_CONTENT_BYTES);

  return { url, content_type: contentType, content, truncated };
}

// Re-exported so a caller catching tool failures has one import.
export { InvalidArgs, ToolIoError };
