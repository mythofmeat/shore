import { InvalidArgs, ToolIoError } from "./errors.ts";

export class ToolHttpError extends Error {
  constructor(message: string) {
    super(`http: ${message}`);
    this.name = "ToolHttpError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(caller: AbortSignal | undefined): AbortSignal {
  const own = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return caller === undefined ? own : AbortSignal.any([caller, own]);
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const MAX_CONTENT_BYTES = 50_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function truncateToBytes(
  text: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { content: text, truncated: false };

  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { content: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

const SKIPPED_BLOCKS = ["script", "style", "head"] as const;

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

function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function stripHtml(html: string): string {
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
        break;
      }

      const gt = html.indexOf(">", i);
      if (gt !== -1) {
        cleaned += " ";
        i = gt + 1;
        continue;
      }
    }

    cleaned += html[i] as string;
    i += 1;
  }

  let decoded = cleaned;
  for (const [from, to] of ENTITIES) {
    decoded = decoded.split(from).join(to);
  }

  return decoded.replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, "");
}

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

export async function handleWebSearch(
  input: Record<string, unknown>,
  searchConfig: SearchConfigView,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
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
      signal: requestSignal(signal),
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

export const MAX_BODY_BYTES = 5_242_880;
const MAX_REDIRECTS = 5;

export interface FetchUrlPolicy {
  lookup?: (hostname: string) => Promise<string[]>;
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidArgs(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgs(`only http and https URLs can be fetched, not ${url.protocol}`);
  }
  return url;
}

function ipv4Blocked(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function addressBlocked(address: string): boolean {
  const plain = address.split("%")[0] ?? address;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(plain);
  if (v4 !== null) {
    return ipv4Blocked(Number(v4[1]), Number(v4[2]));
  }

  const lower = plain.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped !== null) return addressBlocked(mapped[1] as string);

  const packed = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(lower);
  if (packed !== null) {
    const high = Number.parseInt(packed[1] as string, 16);
    return ipv4Blocked(high >> 8, high & 0xff);
  }

  if (lower === "::1" || lower === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
  return false;
}

async function resolveHost(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const found = await lookup(hostname, { all: true });
  return found.map((entry) => entry.address);
}

async function assertReachable(
  url: URL,
  lookup: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (addressBlocked(host)) {
    throw new ToolHttpError(`refusing to fetch a private or local address: ${url.hostname}`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return;

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (e) {
    throw new ToolHttpError(`could not resolve ${host}: ${String(e)}`);
  }
  if (addresses.length === 0) throw new ToolHttpError(`could not resolve ${host}`);
  if (addresses.some(addressBlocked)) {
    throw new ToolHttpError(`refusing to fetch ${host}: it resolves to a private or local address`);
  }
}

export interface FetchUrlResult {
  url: string;
  content_type: string;
  content: string;
  truncated: boolean;
}

export async function handleFetchUrl(
  input: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  policy: FetchUrlPolicy = {},
): Promise<FetchUrlResult> {
  const url = input["url"];
  if (typeof url !== "string") {
    throw new InvalidArgs("missing 'url' field");
  }

  const lookup = policy.lookup ?? resolveHost;
  let target = parseTarget(url);
  let resp: Response;
  let hops = 0;

  for (;;) {
    await assertReachable(target, lookup);
    try {
      resp = await fetchImpl(target.href, {
        headers: { "user-agent": "shore/2.0" },
        redirect: "manual",
        signal: requestSignal(signal),
      });
    } catch (e) {
      throw new ToolHttpError(`request failed: ${String(e)}`);
    }

    const location = redirectTarget(resp);
    if (location === undefined) break;
    hops += 1;
    if (hops > MAX_REDIRECTS) {
      throw new ToolHttpError(`too many redirects (over ${String(MAX_REDIRECTS)}) from ${url}`);
    }
    target = parseTarget(new URL(location, target).href);
  }

  if (!resp.ok) {
    throw new ToolHttpError(`HTTP ${resp.status} for ${url}`);
  }

  const contentType = resp.headers.get("content-type") ?? "unknown";
  const { text, capped } = await readCapped(resp);
  const extracted = contentType.includes("html") ? stripHtml(text) : text;
  const { content, truncated } = truncateToBytes(extracted, MAX_CONTENT_BYTES);

  return { url, content_type: contentType, content, truncated: truncated || capped };
}

function redirectTarget(resp: Response): string | undefined {
  if (resp.status < 300 || resp.status > 399) return undefined;
  return resp.headers.get("location") ?? undefined;
}

async function readCapped(resp: Response): Promise<{ text: string; capped: boolean }> {
  const body: ReadableStream<Uint8Array> | null = resp.body;
  if (body === null) return { text: "", capped: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = MAX_BODY_BYTES - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        capped = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    throw new ToolHttpError(`failed to read body: ${String(e)}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), capped };
}

export { InvalidArgs, ToolIoError };
