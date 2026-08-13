export interface CassetteExchange {
  method: string;
  url: string;
  request_headers: [string, string][];
  request_body: string | null;
  status: number;
  status_text: string;
  response_headers: [string, string][];
  response_body: string | null;
}

export interface Cassette {
  name: string;
  exchanges: CassetteExchange[];
}

export const REPLAYED_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
];

export function keyOrdered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keyOrdered);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, keyOrdered(v)]));
}

export function canonicalBody(body: string | null): unknown {
  if (body === null || body === "") return null;
  try {
    return keyOrdered(JSON.parse(body));
  } catch {
    return body;
  }
}

export function replayableHeaders(pairs: readonly [string, string][]): [string, string][] {
  const allowed = new Set(REPLAYED_REQUEST_HEADERS);
  return pairs
    .filter(([name]) => allowed.has(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface RequestSnapshot {
  method: string;
  url: string;
  headers: [string, string][];
  body: unknown;
}

export function snapshotOf(
  method: string,
  url: string,
  headers: readonly [string, string][],
  body: string | null,
): RequestSnapshot {
  return {
    method: method.toUpperCase(),
    url,
    headers: replayableHeaders(headers),
    body: canonicalBody(body),
  };
}

export function snapshotKey(snapshot: RequestSnapshot): string {
  return JSON.stringify([snapshot.method, snapshot.url, snapshot.headers, snapshot.body]);
}

function flatten(value: unknown, prefix: string, into: Map<string, string>): void {
  if (value === null || typeof value !== "object") {
    into.set(prefix, JSON.stringify(value) ?? "undefined");
    return;
  }
  if (Array.isArray(value)) {
    into.set(`${prefix}.length`, String(value.length));
    value.forEach((item, i) => flatten(item, `${prefix}[${String(i)}]`, into));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, prefix === "" ? k : `${prefix}.${k}`, into);
  }
}

export function requestDiff(expected: RequestSnapshot, actual: RequestSnapshot): string[] {
  const lines: string[] = [];
  if (expected.method !== actual.method) {
    lines.push(`method: recorded ${expected.method}, got ${actual.method}`);
  }
  if (expected.url !== actual.url) {
    lines.push(`url: recorded ${expected.url}, got ${actual.url}`);
  }

  const left = new Map<string, string>();
  const right = new Map<string, string>();
  flatten(expected.body, "", left);
  flatten(actual.body, "", right);

  for (const [path, value] of left) {
    const other = right.get(path);
    if (other === undefined) lines.push(`body.${path}: recorded ${value}, missing`);
    else if (other !== value) lines.push(`body.${path}: recorded ${value}, got ${other}`);
  }
  for (const path of right.keys()) {
    if (!left.has(path)) lines.push(`body.${path}: not recorded, got ${right.get(path) ?? ""}`);
  }
  return lines;
}

export class CassetteMiss extends Error {
  readonly diff: string[];

  constructor(cassette: string, url: string, diff: string[]) {
    super(
      `cassette "${cassette}" has no recording for ${url}` +
        (diff.length === 0 ? "" : `\n  ${diff.join("\n  ")}`),
    );
    this.name = "CassetteMiss";
    this.diff = diff;
  }
}

export class CassettePlayer {
  readonly #cassette: Cassette;
  readonly #byKey = new Map<string, CassetteExchange[]>();
  readonly #played = new Map<string, number>();

  constructor(cassette: Cassette) {
    this.#cassette = cassette;
    for (const exchange of cassette.exchanges) {
      const key = snapshotKey(
        snapshotOf(
          exchange.method,
          exchange.url,
          exchange.request_headers,
          exchange.request_body,
        ),
      );
      const bucket = this.#byKey.get(key);
      if (bucket === undefined) this.#byKey.set(key, [exchange]);
      else bucket.push(exchange);
    }
  }

  get remaining(): number {
    let total = 0;
    for (const [key, bucket] of this.#byKey) {
      total += Math.max(0, bucket.length - (this.#played.get(key) ?? 0));
    }
    return total;
  }

  match(snapshot: RequestSnapshot): CassetteExchange {
    const key = snapshotKey(snapshot);
    const bucket = this.#byKey.get(key);
    if (bucket !== undefined) {
      const seen = this.#played.get(key) ?? 0;
      const picked = bucket[Math.min(seen, bucket.length - 1)];
      if (picked !== undefined) {
        this.#played.set(key, seen + 1);
        return picked;
      }
    }
    throw new CassetteMiss(this.#cassette.name, snapshot.url, this.#nearestDiff(snapshot));
  }

  #nearestDiff(snapshot: RequestSnapshot): string[] {
    let best: string[] | undefined;
    for (const exchange of this.#cassette.exchanges) {
      if (exchange.url !== snapshot.url) continue;
      const diff = requestDiff(
        snapshotOf(
          exchange.method,
          exchange.url,
          exchange.request_headers,
          exchange.request_body,
        ),
        snapshot,
      );
      if (best === undefined || diff.length < best.length) best = diff;
    }
    return best ?? [];
  }
}

export function installCassettePlayer(cassette: Cassette): {
  player: CassettePlayer;
  uninstall: () => void;
} {
  const player = new CassettePlayer(cassette);
  const upstream = globalThis.fetch;

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const body = request.body === null ? null : await request.text();
    const exchange = player.match(
      snapshotOf(request.method, request.url, headerPairs(request.headers), body),
    );
    return new Response(exchange.response_body, {
      status: exchange.status,
      statusText: exchange.status_text,
      headers: new Headers(exchange.response_headers),
    });
  }) as typeof fetch;

  return { player, uninstall: () => (globalThis.fetch = upstream) };
}

function headerPairs(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, name) => out.push([name, value]));
  return out;
}
