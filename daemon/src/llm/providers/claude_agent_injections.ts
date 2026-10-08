import { randomUUID } from "node:crypto";
import type { Server } from "bun";
import { shoreLog } from "../../log.ts";
import { outsideWireScope, withWireScope, type WireScope } from "../wire_capture.ts";

const ANTHROPIC_API = "https://api.anthropic.com";
const REMINDER = "<system-reminder>";
const IMAGE_SOURCE = /^\[Image:? source: [^\]\n]*\]$/;
const CLI_PLACEHOLDERS = new Set(["No response requested.", "(no content)"]);
const CLI_INTERRUPTIONS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);
const SCOPE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_TTL_MS = 24 * 60 * 60 * 1000;
const FILTERED_PATH = /\/v1\/messages(\/count_tokens)?$/;

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown };

function isInjected(role: unknown, block: Block): boolean {
  if (block.type !== "text" || typeof block.text !== "string") return false;
  if (role === "assistant") return CLI_PLACEHOLDERS.has(block.text.trim());
  const text = block.text.trim();
  return role === "user" && (text.startsWith(REMINDER) || IMAGE_SOURCE.test(text) || CLI_INTERRUPTIONS.has(text));
}

function canHoldCacheControl(block: Block): boolean {
  return block.type !== "thinking" && block.type !== "redacted_thinking";
}

function isBillingHeader(block: Block): boolean {
  return block.type === "text" && typeof block.text === "string" && block.text.trim().startsWith("x-anthropic-billing-header:");
}

export function withoutInjectedContext(body: Record<string, unknown>): Record<string, unknown> {
  const system = Array.isArray(body.system) ? { system: (body.system as Block[]).filter(block => !isBillingHeader(block)) } : {};
  if (!Array.isArray(body.messages)) return { ...body, ...system };
  const kept: Message[] = [];
  let anchor: Block | undefined;
  const drop = (block: unknown) => {
    const cacheControl = typeof block === "object" && block !== null ? (block as Block).cache_control : undefined;
    if (cacheControl !== undefined && anchor !== undefined && anchor.cache_control === undefined) {
      anchor.cache_control = cacheControl;
    }
  };
  for (const message of body.messages as Message[]) {
    const content = message.content;
    if (message.role === "system") {
      if (Array.isArray(content)) content.forEach(drop);
      continue;
    }
    if (typeof content === "string") {
      if (message.role === "user" && content.trimStart().startsWith(REMINDER)) continue;
      kept.push(message);
      continue;
    }
    if (!Array.isArray(content)) {
      kept.push(message);
      continue;
    }
    const blocks: Block[] = [];
    for (const block of content as Block[]) {
      if (isInjected(message.role, block)) {
        drop(block);
        continue;
      }
      blocks.push(block);
      if (canHoldCacheControl(block)) anchor = block;
    }
    if (blocks.length > 0) kept.push({ ...message, content: blocks });
  }
  return { ...body, ...system, messages: kept };
}

function filteredBody(raw: ArrayBuffer): ArrayBuffer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return raw;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw;
  return JSON.stringify(withoutInjectedContext(parsed as Record<string, unknown>));
}

async function forward(request: Request, target: URL): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of ["host", "accept-encoding", "content-length"]) headers.delete(name);
  const raw = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = raw !== undefined && request.method === "POST" && FILTERED_PATH.test(target.pathname) ? filteredBody(raw) : raw;
  try {
    const response = await fetch(target, { method: request.method, headers, body, redirect: "manual", signal: request.signal });
    const returned = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) returned.delete(name);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: returned });
  } catch (error) {
    if (request.signal.aborted) throw error;
    shoreLog.warn(`claude_agent: context filter could not reach ${target.origin}: ${String(error)}`);
    return Response.json({ type: "error", error: { type: "api_error", message: `Shore could not reach ${target.origin}` } }, { status: 502 });
  }
}

class ContextFilter {
  #server: Server<undefined> | undefined;
  readonly #upstreams = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  readonly #scopes = new Map<string, { scope: WireScope; at: number }>();

  baseUrl(upstream: string, scope?: WireScope): string {
    const server = this.#server ??= outsideWireScope(() => this.#start());
    const origin = upstream.replace(/\/+$/, "");
    let key = this.#keys.get(origin);
    if (key === undefined) {
      key = randomUUID();
      this.#keys.set(origin, key);
      this.#upstreams.set(key, origin);
    }
    const base = `http://127.0.0.1:${String(server.port)}/${key}`;
    if (scope === undefined) return base;
    const now = Date.now();
    for (const [scopeKey, entry] of this.#scopes) if (now - entry.at > SCOPE_TTL_MS) this.#scopes.delete(scopeKey);
    const scopeKey = randomUUID();
    this.#scopes.set(scopeKey, { scope, at: now });
    return `${base}/${scopeKey}`;
  }

  #start(): Server<undefined> {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        const [, key = "", ...rest] = url.pathname.split("/");
        const upstream = this.#upstreams.get(key);
        if (upstream === undefined) return new Response(null, { status: 404 });
        const scopeKey = SCOPE_KEY.test(rest[0] ?? "") ? rest.shift() : undefined;
        const scope = scopeKey === undefined ? undefined : this.#scopes.get(scopeKey)?.scope;
        const target = new URL(`${upstream}/${rest.join("/")}${url.search}`);
        return scope === undefined ? forward(request, target) : withWireScope(scope, () => forward(request, target));
      },
    });
    server.unref();
    return server;
  }
}

const filter = new ContextFilter();

export function contextFilterEnvironment(baseUrl: string | undefined, scope?: WireScope): Record<string, string> {
  const upstream = baseUrl ?? ANTHROPIC_API;
  const firstParty = URL.parse(upstream)?.host === new URL(ANTHROPIC_API).host;
  return {
    ANTHROPIC_BASE_URL: filter.baseUrl(upstream, scope),
    NO_PROXY: "127.0.0.1",
    ...(firstParty ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}),
  };
}
