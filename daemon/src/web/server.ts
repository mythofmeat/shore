import { readFileSync } from "node:fs";
import type { WebConfig } from "../config/app.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { Server } from "../swp/server.ts";
import { WebSessions, type WebSession } from "./auth.ts";
import { WEB_CONTRACT, WEB_PROTOCOL, WEB_SUBPROTOCOL } from "./contract.ts";
import { validWebLogin, validWebProblem, validWebSession, validWebArchiveExport, validWebArchiveInfo, validWebArchiveList, validWebRequestList } from "./contracts.ts";
import { readSmallJson, sameOrigin, securityHeaders, webBinding, WebBodyTooLarge, WEB_LIMITS } from "./policy.ts";
import { socketState, WebSocketPeers, type WebSocketState } from "./socket.ts";
import { browserAssets } from "./assets.generated.ts";
import { ArchiveTransfers, ArchiveTransferError, ARCHIVE_TRANSFER_LIMITS, type ArchiveTransferLimits } from "./archives.ts";
import { WebRecovery, type WebRecoveryOptions } from "./recovery.ts";
import { RequestHistory, RequestHistoryError } from "./requests.ts";

export interface WebServerOptions {
  readonly config: WebConfig;
  readonly server: Server;
  readonly authenticate: (token: string) => boolean;
  readonly sessionLifetimeMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly archiveLimits?: Partial<ArchiveTransferLimits>;
  readonly recovery?: WebRecoveryOptions;
}

export interface RunningWebServer {
  readonly origin: string;
  readonly port: number;
  activate(): void;
  stop(): Promise<void>;
}

function problem(status: number, code: WebProblem["code"], message: string): Response {
  const body: WebProblem = { code, message };
  if (!validWebProblem(body)) throw new Error("Invalid browser error response");
  return Response.json(body, { status, headers: securityHeaders() });
}

function sessionInfo(session: WebSession, maxBytes: number): WebSessionInfo {
  const info: WebSessionInfo = {
    contract: WEB_CONTRACT, protocol: WEB_PROTOCOL, expires_at: session.expiresAt,
    max_message_bytes: Math.min(maxBytes, WEB_LIMITS.messageBytes), max_pending_requests: WEB_LIMITS.pendingRequests,
  };
  if (!validWebSession(info)) throw new Error("Invalid browser session response");
  return info;
}

export function startWebServer(options: WebServerOptions): RunningWebServer {
  const config = options.config;
  const binding = webBinding(config);
  let peers: WebSocketPeers;
  let requests: RequestHistory;
  let origin = "";
  let sessions: WebSessions;
  let closeSessions: (() => void) | undefined;
  let active = false;
  let stopping: Promise<void> | undefined;
  const loginFailures = new Map<string, { start: number; count: number }>();
  let loginRequests = 0;
  let archives: ArchiveTransfers;
  let recovery: WebRecovery | undefined;
  const server = Bun.serve({
    hostname: binding.hostname,
    port: binding.port,
    idleTimeout: 10,
    maxRequestBodySize: options.archiveLimits?.uploadBytes ?? ARCHIVE_TRANSFER_LIMITS.uploadBytes,
    ...(config.tls_cert === undefined || config.tls_key === undefined ? {} : {
      tls: { cert: readFileSync(config.tls_cert), key: readFileSync(config.tls_key) },
    }),
    async fetch(request, http) {
      const url = new URL(request.url);
      if (url.host !== new URL(origin).host || url.search !== "") return problem(403, "forbidden", "Unrecognized browser origin or URL");
      if (!active) return problem(503, "unavailable", "The daemon is not ready");
      if (request.method === "GET" || request.method === "HEAD") {
        const asset = browserAssets[url.pathname === "/workspace" || url.pathname.startsWith("/workspace/") ? "/" : url.pathname];
        if (asset !== undefined) {
          const headers = securityHeaders(); headers.set("content-type", asset.type);
          return new Response(request.method === "HEAD" ? null : asset.body, { headers });
        }
      }
      if (!sameOrigin(request, origin)) return problem(403, "forbidden", "Use the daemon's own browser origin");

      if (url.pathname === "/api/login" && request.method === "POST") {
        const now = Date.now();
        for (const [client, failure] of loginFailures) if (now - failure.start >= 60_000) loginFailures.delete(client);
        const client = http.requestIP(request)?.address ?? "unknown";
        if (loginRequests >= config.max_connections) {
          return problem(429, "too_many_requests", "Too many sign-in attempts; try again later");
        }
        loginRequests += 1;
        try {
          const body = await readSmallJson(request, WEB_LIMITS.loginBytes);
          if (!validWebLogin(body)) {
            return problem(400, "invalid_request", "Supply a token to sign in");
          }
          if (!options.authenticate(body.token)) {
            const failures = loginFailures.get(client) ?? { start: now, count: 0 };
            if (failures.count >= WEB_LIMITS.loginAttemptsPerMinute) return problem(429, "too_many_requests", "Too many sign-in attempts; try again later");
            failures.count += 1;
            if (!loginFailures.has(client) && loginFailures.size >= 4096) {
              const oldest = loginFailures.keys().next().value;
              if (oldest !== undefined) loginFailures.delete(oldest);
            }
            loginFailures.set(client, failures);
            return problem(401, "unauthorized", "The token was rejected");
          }
          loginFailures.delete(client);
          const previous = sessions.read(request);
          if (previous !== undefined) sessions.revoke(previous);
          const session = sessions.create();
          if (session === undefined) return problem(429, "too_many_requests", "Browser session limit reached");
          const headers = securityHeaders();
          headers.set("set-cookie", sessions.cookie(session));
          return Response.json(sessionInfo(session, config.max_queued_bytes), { headers });
        } catch (error) {
          if (error instanceof WebBodyTooLarge) return problem(413, "invalid_request", error.message);
          return problem(400, "invalid_request", "Invalid sign-in request");
        } finally {
          loginRequests -= 1;
        }
      }

      const session = sessions.read(request);
      if (session === undefined) return problem(401, "unauthorized", "Sign in to connect to the daemon");
      if (url.pathname.startsWith("/api/requests") && request.method === "POST") {
        try {
          if (url.pathname === "/api/requests/list") {
            const result = requests.list(session);
            if (!validWebRequestList(result)) throw new Error("Invalid request history");
            return Response.json(result, { headers: securityHeaders() });
          }
          const match = /^\/api\/requests\/([a-f0-9-]{36})\/acknowledge$/.exec(url.pathname);
          if (match?.[1] === undefined) return problem(404, "not_found", "Unknown request history endpoint");
          requests.acknowledge(session, match[1]);
          return new Response(null, { status: 204, headers: securityHeaders() });
        } catch (error) {
          if (error instanceof RequestHistoryError) return problem(error.status, error.status === 404 ? "not_found" : "invalid_request", error.message);
          return problem(503, "unavailable", "Request recovery storage is unavailable; retain unreviewed outcomes and try again");
        }
      }
      if (url.pathname.startsWith("/api/archives") && request.method === "POST") {
        try {
          if (url.pathname === "/api/archives/list") {
            const result = archives.list(session);
            if (!validWebArchiveList(result)) throw new Error("Invalid archive list");
            return Response.json(result, { headers: securityHeaders() });
          }
          const match = /^\/api\/archives\/([a-f0-9-]{36})\/(status|import|download|remove)$/.exec(url.pathname);
          if (match?.[1] !== undefined && match[2] === "download") { http.timeout(request, 0); return await archives.download(session, match[1], request); }
          if (match?.[1] !== undefined && match[2] === "remove") { await archives.remove(session, match[1]); return new Response(null, { status: 204, headers: securityHeaders() }); }
          let result;
          if (url.pathname === "/api/archives") { http.timeout(request, 0); result = await archives.upload(session, request); }
          else if (url.pathname === "/api/archives/export") {
            const body = await readSmallJson(request, WEB_LIMITS.loginBytes);
            if (!validWebArchiveExport(body)) return problem(400, "invalid_request", "Choose a character to export");
            result = archives.export(session, body.character);
          } else if (match?.[1] !== undefined && match[2] === "status") result = archives.get(session, match[1]);
          else if (match?.[1] !== undefined && match[2] === "import") result = archives.import(session, match[1]);
          else return problem(404, "not_found", "Unknown archive transfer endpoint");
          if (!validWebArchiveInfo(result)) throw new Error("Invalid archive transfer response");
          return Response.json(result, { status: result.phase === "importing" || result.phase === "exporting" ? 202 : 200, headers: securityHeaders() });
        } catch (error) {
          if (error instanceof WebBodyTooLarge) return problem(413, "invalid_request", error.message);
          if (error instanceof ArchiveTransferError) return problem(error.status, error.status === 404 ? "not_found" : error.status === 429 ? "too_many_requests" : error.status === 401 ? "unauthorized" : "invalid_request", error.message);
          return problem(400, "invalid_request", "Archive transfer could not be completed");
        }
      }
      if (url.pathname === "/api/logout" && request.method === "POST") {
        sessions.revoke(session);
        const headers = securityHeaders();
        headers.set("set-cookie", sessions.cookie());
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        return Response.json(sessionInfo(session, config.max_queued_bytes), { headers: securityHeaders() });
      }
      if (url.pathname === "/api/swp" && request.method === "GET") {
        if (request.headers.get("sec-websocket-protocol") !== WEB_SUBPROTOCOL) {
          return problem(409, "reload_required", "This browser version is incompatible; reload the page");
        }
        if (http.pendingWebSockets >= config.max_connections || peers.size >= config.max_connections) {
          return problem(429, "too_many_requests", "Browser connection limit reached");
        }
        const headers = securityHeaders();
        headers.set("sec-websocket-protocol", WEB_SUBPROTOCOL);
        return http.upgrade(request, { data: socketState(session), headers })
          ? undefined : problem(400, "invalid_request", "Expected a WebSocket upgrade");
      }
      return problem(404, "not_found", "Unknown browser endpoint");
    },
    websocket: {
      data: {} as WebSocketState,
      maxPayloadLength: WEB_LIMITS.messageBytes,
      backpressureLimit: config.max_queued_bytes,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: true,
      perMessageDeflate: false,
      open(socket) { peers.open(socket); },
      message(socket, message) { peers.message(socket, message); },
      drain(socket) { socket.data.drain?.(); },
      close(socket) { peers.close(socket); },
    },
    error() { return problem(500, "unavailable", "Browser transport error"); },
  });
  origin = config.public_origin ?? server.url.origin;
  try {
    recovery = options.recovery === undefined ? undefined : new WebRecovery(options.recovery, origin);
    sessions = new WebSessions(origin, config.max_connections * 2, options.sessionLifetimeMs ?? WEB_LIMITS.sessionLifetimeMs, recovery);
    closeSessions = () => sessions.close();
    archives = new ArchiveTransfers(options.server, () => active && stopping === undefined, options.archiveLimits, recovery);
    archives.restore(sessions);
    requests = new RequestHistory(recovery);
    requests.restore(sessions);
    peers = new WebSocketPeers(options.server, config.max_queued_bytes,
      options.handshakeTimeoutMs ?? WEB_LIMITS.handshakeTimeoutMs,
      options.drainTimeoutMs ?? WEB_LIMITS.drainTimeoutMs, requests);
  } catch (error) { closeSessions?.(); recovery?.close(); void server.stop(true); throw error; }
  return {
    origin,
    port: server.port ?? binding.port,
    activate() { if (stopping === undefined) active = true; },
    stop() {
      if (stopping !== undefined) return stopping;
      active = false;
      const drained = Promise.all([peers.stop(), archives.close()]);
      sessions.close();
      stopping = (async () => {
        await server.stop(true);
        await drained;
        recovery?.close();
      })();
      return stopping;
    },
  };
}
