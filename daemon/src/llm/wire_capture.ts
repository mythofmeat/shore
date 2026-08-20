import { AsyncLocalStorage } from "node:async_hooks";

import { redactHeaders } from "./redact.ts";

export interface WireScope {
  call_id: string;
  character: string | null;
  call_type: string | null;
  rid: string | null;
  seq: number;
}

export interface WireExchange {
  call_id: string;
  character: string | null;
  call_type: string | null;
  rid: string | null;
  seq: number;
  ts: Date;
  method: string;
  url: string;
  request_headers: [string, string][];
  request_body: Uint8Array | null;
  status: number | null;
  status_text: string | null;
  response_headers: [string, string][] | null;
  response_body: Uint8Array | null;
  duration_ms: number;
  error: string | null;
}

export type WireSink = (exchange: WireExchange) => void;

const scopes = new AsyncLocalStorage<WireScope>();
const INSTALLED = Symbol.for("shore.wireCapture.installed");

export function newWireScope(
  call_id: string,
  fields: {
    character?: string | null | undefined;
    call_type?: string | null | undefined;
    rid?: string | null | undefined;
  },
): WireScope {
  return {
    call_id,
    character: fields.character ?? null,
    call_type: fields.call_type ?? null,
    rid: fields.rid ?? null,
    seq: 0,
  };
}

export function withWireScope<T>(scope: WireScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

export function activeWireScope(): WireScope | undefined {
  return scopes.getStore();
}

export async function* wireScopedIteration<T>(
  scope: WireScope,
  start: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = withWireScope(scope, () => start()[Symbol.asyncIterator]());
  try {
    for (;;) {
      const step = await withWireScope(scope, () => iterator.next());
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

export function installWireCapture(sink: WireSink, now: () => number = Date.now): () => void {
  const target = globalThis as typeof globalThis & { [INSTALLED]?: true };
  if (target[INSTALLED] === true) return () => {};
  const upstream = globalThis.fetch;
  target[INSTALLED] = true;

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const scope = scopes.getStore();
    if (scope === undefined) return await upstream(input, init);

    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const ts = new Date();
    const startedAt = now();
    const seq = scope.seq++;
    const requestBody = await readRequestBody(request);

    const base = {
      call_id: scope.call_id,
      character: scope.character,
      call_type: scope.call_type,
      rid: scope.rid,
      seq,
      ts,
      method: request.method,
      url: request.url,
      request_headers: headerPairs(request.headers),
      request_body: requestBody,
    };

    let response: Response;
    try {
      response = await upstream(request);
    } catch (e) {
      emit(sink, {
        ...base,
        status: null,
        status_text: null,
        response_headers: null,
        response_body: null,
        duration_ms: now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const responseHeaders = headerPairs(response.headers);
    const finish = (body: Uint8Array | null, error: string | null): void => {
      emit(sink, {
        ...base,
        status: response.status,
        status_text: response.statusText,
        response_headers: responseHeaders,
        response_body: body,
        duration_ms: now() - startedAt,
        error,
      });
    };

    if (response.body === null || !bodyAllowed(response.status)) {
      finish(null, null);
      return response;
    }

    const [downstream, recorded] = response.body.tee();
    void drain(recorded).then(
      (body) => finish(body, null),
      (e) => finish(null, e instanceof Error ? e.message : String(e)),
    );

    return new Response(downstream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = upstream;
    delete target[INSTALLED];
  };
}

function emit(sink: WireSink, exchange: WireExchange): void {
  try {
    sink(exchange);
  } catch {
  }
}

function bodyAllowed(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function headerPairs(headers: Headers): [string, string][] {
  return redactHeaders([...headers.entries()].map(([name, value]) => [name, value]));
}

async function readRequestBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null && ! request.bodyUsed) {
    const buffer = await request.clone().arrayBuffer();
    return buffer.byteLength === 0 ? null : new Uint8Array(buffer);
  }
  try {
    const buffer = await request.clone().arrayBuffer();
    return buffer.byteLength === 0 ? null : new Uint8Array(buffer);
  } catch {
    return null;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
