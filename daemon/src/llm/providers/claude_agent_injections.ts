import { createHash, randomUUID } from "node:crypto";
import type { Server } from "bun";
import { shoreLog } from "../../log.ts";
import { outsideWireScope, withWireScope, type WireScope } from "../wire_capture.ts";

const ANTHROPIC_API = "https://api.anthropic.com";
const REMINDER = "<system-reminder>";
const IMAGE_SOURCE = /^\[Image:? source: [^\]\n]*\]$/;
const CLI_PLACEHOLDERS = new Set(["No response requested.", "(no content)"]);
const CLI_INTERRUPTIONS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);
const SAFETY_STOP = "Your response above was stopped by a safety classifier \u2014 this is not a tool or API error. " +
  "The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.";
const CLI_NUDGES = new Set([
  "The previous response failed to produce a valid tool call. Please retry the tool call now.",
  "Your tool call was malformed and could not be parsed. Please retry.",
  "[Your previous response had no visible output. Please continue and produce a user-visible response.]",
  "The PermissionDenied hook indicated you may retry this tool call.",
  SAFETY_STOP,
  `${SAFETY_STOP} Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.`,
  "Output token limit hit. Resume directly \u2014 no apology, no recap of what you were doing. " +
    "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
  "Your response above was cut off mid-stream. Resume directly from where it stops \u2014 no apology, no recap. " +
    "If none of it survived, answer the request from the start.",
  "Your response above was cut off mid-stream and only your next message is delivered. " +
    "Write the complete response again from the start \u2014 no apology, no mention of the cut-off.",
]);
const ROUTE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const FILTERED_PATH = /\/v1\/messages(\/count_tokens)?$/;
const SYSTEM_MESSAGE_MODELS = new Set([
  "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-fable-5-1", "claude-fable-5",
  "claude-mythos-5-1", "claude-mythos-5", "claude-sonnet-5-5",
]);

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown; output_config?: unknown };

export interface SystemNote {
  anchor: string;
  text: string;
  delivered?: boolean;
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

export function resultAnchor(toolUseId: string): string {
  return `result:${toolUseId}`;
}

export function anchorKeys(messages: readonly Message[]): string[][] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    if (message.role !== "user") return [];
    const blocks = blocksOf(message.content);
    const results = blocks.flatMap(block => block.type === "tool_result" && typeof block.tool_use_id === "string" ? [resultAnchor(block.tool_use_id)] : []);
    if (results.length > 0) return results;
    const last = blocks.findLast(block => textOf(block).trim() !== "");
    if (last === undefined) return [];
    const base = `text:${createHash("sha256").update(textOf(last).trim()).digest("hex").slice(0, 32)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return [`${base}#${String(occurrence)}`];
  });
}

export function takesSystemMessages(model: unknown): boolean {
  return typeof model === "string" && SYSTEM_MESSAGE_MODELS.has(model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, ""));
}

function repliedNext(messages: readonly Message[], index: number): boolean {
  let next = index + 1;
  while (messages[next]?.role === "system") next += 1;
  const role = messages[next]?.role;
  return role === undefined || role === "assistant";
}

export function insertSystemNotes(body: Record<string, unknown>, notes: readonly SystemNote[]): Record<string, unknown> {
  if (notes.length === 0 || !Array.isArray(body.messages)) return body;
  const messages = body.messages as Message[];
  const keys = anchorKeys(messages);
  const native = takesSystemMessages(body.model);
  const out: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Message;
    const here = notes.filter(note => keys[index]?.includes(note.anchor));
    if (here.length === 0 || !repliedNext(messages, index)) {
      out.push(message);
      continue;
    }
    for (const note of here) note.delivered = true;
    const blocks = here.map(note => ({ type: "text", text: note.text }));
    if (!native) {
      out.push({ ...message, content: [...blocksOf(message.content), ...blocks] });
      continue;
    }
    out.push(message);
    const next = messages[index + 1];
    if (next?.role === "system") {
      out.push({ ...next, content: [...blocks, ...blocksOf(next.content)] });
      index += 1;
    } else {
      out.push({ role: "system", content: blocks });
    }
  }
  return { ...body, messages: out };
}

function isInjected(role: unknown, block: Block): boolean {
  if (block.type !== "text" || typeof block.text !== "string") return false;
  if (role === "assistant") return CLI_PLACEHOLDERS.has(block.text.trim());
  const text = block.text.trim();
  return role === "user" && (text.startsWith(REMINDER) || IMAGE_SOURCE.test(text) || CLI_INTERRUPTIONS.has(text) || CLI_NUDGES.has(text));
}

function textOf(block: Block): string {
  return typeof block.text === "string" ? block.text : "";
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
      const controls = Array.isArray(content) ? (content as Block[]).filter(block => block.type !== "text") : [];
      if (Array.isArray(content)) (content as Block[]).filter(block => block.type === "text").forEach(drop);
      if (controls.length > 0 || message.output_config !== undefined) {
        kept.push({ ...message, content: controls });
      }
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

function filteredBody(raw: ArrayBuffer, notes: readonly SystemNote[]): ArrayBuffer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return raw;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw;
  return JSON.stringify(insertSystemNotes(withoutInjectedContext(parsed as Record<string, unknown>), notes));
}

async function forward(request: Request, target: URL, notes: readonly SystemNote[]): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of ["host", "accept-encoding", "content-length"]) headers.delete(name);
  const raw = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = raw !== undefined && request.method === "POST" && FILTERED_PATH.test(target.pathname) ? filteredBody(raw, notes) : raw;
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

interface FilterRoute {
  scope: WireScope | undefined;
  notes: readonly SystemNote[];
  at: number;
}

class ContextFilter {
  #server: Server<undefined> | undefined;
  readonly #upstreams = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  readonly #routes = new Map<string, FilterRoute>();

  baseUrl(upstream: string, scope?: WireScope, notes: readonly SystemNote[] = []): string {
    const server = this.#server ??= outsideWireScope(() => this.#start());
    const origin = upstream.replace(/\/+$/, "");
    let key = this.#keys.get(origin);
    if (key === undefined) {
      key = randomUUID();
      this.#keys.set(origin, key);
      this.#upstreams.set(key, origin);
    }
    const base = `http://127.0.0.1:${String(server.port)}/${key}`;
    if (scope === undefined && notes.length === 0) return base;
    const now = Date.now();
    for (const [routeKey, route] of this.#routes) if (now - route.at > ROUTE_TTL_MS) this.#routes.delete(routeKey);
    const routeKey = randomUUID();
    this.#routes.set(routeKey, { scope, notes, at: now });
    return `${base}/${routeKey}`;
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
        const routeKey = ROUTE_KEY.test(rest[0] ?? "") ? rest.shift() : undefined;
        const route = routeKey === undefined ? undefined : this.#routes.get(routeKey);
        const target = new URL(`${upstream}/${rest.join("/")}${url.search}`);
        const notes = route?.notes ?? [];
        const scope = route?.scope;
        return scope === undefined ? forward(request, target, notes) : withWireScope(scope, () => forward(request, target, notes));
      },
    });
    server.unref();
    return server;
  }
}

const filter = new ContextFilter();

export function contextFilterEnvironment(baseUrl: string | undefined, scope?: WireScope, notes: readonly SystemNote[] = []): Record<string, string> {
  const upstream = baseUrl ?? ANTHROPIC_API;
  const firstParty = URL.parse(upstream)?.host === new URL(ANTHROPIC_API).host;
  return {
    ANTHROPIC_BASE_URL: filter.baseUrl(upstream, scope, notes),
    NO_PROXY: "127.0.0.1",
    ...(firstParty ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}),
  };
}
