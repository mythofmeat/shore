import type { ArchiveLimits } from "../commands/archive.ts";
import { operationSchema } from "../operations/contracts.ts";
import { coreRequests } from "../operations/requests.ts";
import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { Error as ProtocolError } from "../protocol/Error.ts";
import type { ErrorCode } from "../protocol/ErrorCode.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { AdmissionError, admitClientMessage } from "../swp/admission.ts";
import { MULTIMODAL_TOOL_RESULTS } from "../swp/content_projection.ts";
import { decodeClientMessage, WireError } from "../swp/framing.ts";
import { encodeServerMessage } from "../swp/outbound.ts";
import type { Server } from "../swp/server.ts";
import { REQUEST_LIFECYCLE_CAPABILITY } from "../swp/session.ts";
import { readSmallJson, securityHeaders, WebBodyTooLarge, WEB_LIMITS } from "./policy.ts";

export type OneOffMessage = Exclude<ClientMessage, { type: "hello" }>;

export interface OneOffRequest {
  readonly message: OneOffMessage;
  readonly clientName: string;
  readonly character?: string | null | undefined;
  readonly thread?: string | undefined;
  readonly signal: AbortSignal;
  readonly archiveLimits?: ArchiveLimits;
  readonly queuedBytes: number;
}

export const CONNECTION_ONLY_OPERATIONS: ReadonlySet<string> = new Set(["switch_character", "switch_thread"]);
export const STREAM_TYPE = "application/x-ndjson";
const PING_MS = 30_000;

export function operationExists(name: string): boolean {
  if (Object.hasOwn(coreRequests, name)) return true;
  try { operationSchema(name as never); return true; } catch { return false; }
}

export async function* runRequest(server: Server, request: OneOffRequest): AsyncGenerator<ServerMessage, void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const peer = await server.attachLocal({
    clientType: "http", clientName: request.clientName, history: false, broadcasts: false, signal,
    capabilities: [REQUEST_LIFECYCLE_CAPABILITY, MULTIMODAL_TOOL_RESULTS],
    ...(request.character === undefined ? {} : { character: request.character }),
    ...(request.thread === undefined ? {} : { thread: request.thread }),
    ...(request.archiveLimits === undefined ? {} : { archiveLimits: request.archiveLimits }),
    outboundLimits: { messages: WEB_LIMITS.queuedMessages, bytes: request.queuedBytes, coalesceStreams: true,
      onOverflow: () => { abort.abort(new Error("The answer outgrew what the daemon holds for a slow reader")); } },
  });
  try {
    const events = peer.events();
    const sent = peer.send(request.message);
    sent.catch((error: unknown) => { abort.abort(error); });
    if (request.message.type === "cancel") { await sent; return; }
    const rid = request.message.rid;
    for await (const frame of events) {
      if (!("rid" in frame) || frame.rid !== rid) continue;
      yield frame;
      if (frame.type === "request_finished") { await sent; return; }
    }
    await sent;
    signal.throwIfAborted();
    throw new Error("The daemon stopped before the request finished");
  } finally { await peer.detach(); }
}

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400, protocol_error: 400, unauthorized: 401, not_found: 404, busy: 409,
  internal_error: 500, provider_error: 502, timeout: 504,
};

function failure(error: ProtocolError): Response {
  const { code, message, retry_after_ms } = error;
  const body = { code, message, ...(retry_after_ms === undefined || retry_after_ms === null ? {} : { retry_after_ms }) };
  return Response.json(body, { status: STATUS[code], headers: securityHeaders() });
}

const refused = (code: ErrorCode, message: string): Response => failure({ code, message });

function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0]?.trim() === STREAM_TYPE);
}

async function argumentsOf(request: Request): Promise<unknown> {
  if (request.headers.get("content-type") === null && (request.headers.get("content-length") ?? "0") === "0") return {};
  return await readSmallJson(request, WEB_LIMITS.messageBytes);
}

export function requestMessage(name: string, args: unknown, rid: string): OneOffMessage {
  if (name === "cancel") return { type: "cancel" };
  const raw = name === "message" || name === "regen"
    ? decodeClientMessage({ ...(typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}), type: name, rid })
    : { type: "command", name, args, rid };
  const admitted = admitClientMessage(raw);
  if (admitted.type === "hello") throw new AdmissionError("A request can't be a hello");
  return admitted;
}

export interface OperationCall {
  readonly server: Server;
  readonly name: string;
  readonly clientName: string;
  readonly queuedBytes: number;
  readonly holdOpen: () => void;
}

export async function operationResponse(request: Request, call: OperationCall): Promise<Response> {
  const { name } = call;
  call.holdOpen();
  if (CONNECTION_ONLY_OPERATIONS.has(name)) return refused("invalid_request", `${name} changes what a connection is looking at, and a request has no connection; name the character and thread with ?character= and ?thread= instead`);
  let args: unknown;
  try { args = await argumentsOf(request); } catch (error) {
    return refused("invalid_request", error instanceof WebBodyTooLarge ? error.message : "Send the operation's arguments as a JSON object");
  }
  let message: OneOffMessage;
  try { message = requestMessage(name, args, `http-${crypto.randomUUID()}`); } catch (error) {
    if (error instanceof AdmissionError || error instanceof WireError) return refused("invalid_request", error.message);
    throw error;
  }
  const url = new URL(request.url);
  const selected = (key: string): string | undefined => { const value = url.searchParams.get(key); return value === null || value === "" ? undefined : value; };
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const frames = runRequest(call.server, {
    message, clientName: call.clientName, character: selected("character"), thread: selected("thread"), signal, queuedBytes: call.queuedBytes,
  });
  return wantsStream(request) ? streamed(frames, controller) : await answered(name, frames);
}

function streamed(frames: AsyncGenerator<ServerMessage, void>, controller: AbortController): Response {
  const encoder = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      ping = setInterval(() => { output.enqueue(encoder.encode(`${encodeServerMessage({ type: "ping" }).text}\n`)); }, PING_MS);
    },
    async pull(output) {
      try {
        const next = await frames.next();
        if (next.done) { clearInterval(ping); output.close(); return; }
        output.enqueue(encoder.encode(`${encodeServerMessage(next.value).text}\n`));
      } catch (error) {
        clearInterval(ping);
        const message = error instanceof Error ? error.message : String(error);
        output.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: "internal_error", message })}\n`));
        output.close();
      }
    },
    async cancel() {
      clearInterval(ping);
      controller.abort(new Error("The client stopped reading"));
      await frames.return();
    },
  });
  const headers = securityHeaders();
  headers.set("content-type", STREAM_TYPE);
  return new Response(stream, { headers });
}

async function answered(name: string, frames: AsyncGenerator<ServerMessage, void>): Promise<Response> {
  let output: { data: unknown } | undefined;
  let error: ProtocolError | undefined;
  try {
    for await (const frame of frames) {
      if (frame.type === "command_output" && frame.name === name) output = { data: frame.data };
      else if (frame.type === "error") error ??= frame;
      else if (frame.type === "request_finished") {
        if (frame.outcome !== "completed") return failure(frame.error ?? error ?? { code: "internal_error", message: `The request ended as ${frame.outcome}` });
        if (output !== undefined) return Response.json(output.data, { headers: securityHeaders() });
        return Response.json(frame, { headers: securityHeaders() });
      }
    }
  } catch (failed) {
    return refused("internal_error", failed instanceof Error ? failed.message : String(failed));
  }
  if (error !== undefined) return failure(error);
  return Response.json(null, { headers: securityHeaders() });
}
