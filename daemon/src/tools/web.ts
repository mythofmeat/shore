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
      signal: requestSignal(signal),
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

export { InvalidArgs, ToolIoError };
