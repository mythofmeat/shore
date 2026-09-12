import { readFileSync } from "node:fs";
import type { WebConfig } from "../config/app.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { Server } from "../swp/server.ts";
import { WebSessions, type WebSession } from "./auth.ts";
import { WEB_CONTRACT, WEB_PROTOCOL, WEB_SUBPROTOCOL } from "./contract.ts";
import { validWebLogin, validWebProblem, validWebSession } from "./contracts.ts";
import { readSmallJson, sameOrigin, securityHeaders, webBinding, WEB_LIMITS } from "./policy.ts";
import { socketState, WebSocketPeers, type WebSocketState } from "./socket.ts";

export interface WebServerOptions {
  readonly config: WebConfig;
  readonly server: Server;
  readonly authenticate: (token: string) => boolean;
  readonly sessionLifetimeMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
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

function sessionInfo(session: WebSession): WebSessionInfo {
  const info: WebSessionInfo = {
    contract: WEB_CONTRACT, protocol: WEB_PROTOCOL, expires_at: session.expiresAt,
    max_message_bytes: WEB_LIMITS.messageBytes, max_pending_requests: WEB_LIMITS.pendingRequests,
  };
  if (!validWebSession(info)) throw new Error("Invalid browser session response");
  return info;
}

export function startWebServer(options: WebServerOptions): RunningWebServer {
  const config = options.config;
  const binding = webBinding(config);
  const peers = new WebSocketPeers(options.server, config.max_queued_bytes,
    options.handshakeTimeoutMs ?? WEB_LIMITS.handshakeTimeoutMs,
    options.drainTimeoutMs ?? WEB_LIMITS.drainTimeoutMs);
  let origin = "";
  let sessions: WebSessions;
  let active = false;
  let stopping: Promise<void> | undefined;
  let loginWindow = Date.now();
  let loginAttempts = 0;
  let loginRequests = 0;
  const server = Bun.serve({
    hostname: binding.hostname,
    port: binding.port,
    idleTimeout: 10,
    maxRequestBodySize: WEB_LIMITS.loginBytes,
    ...(config.tls_cert === undefined || config.tls_key === undefined ? {} : {
      tls: { cert: readFileSync(config.tls_cert), key: readFileSync(config.tls_key) },
    }),
    async fetch(request, http) {
      const url = new URL(request.url);
      if (url.host !== new URL(origin).host || url.search !== "") return problem(403, "forbidden", "Unrecognized browser origin or URL");
      if (!active) return problem(503, "unavailable", "The daemon is not ready");
      if (!sameOrigin(request, origin)) return problem(403, "forbidden", "Use the daemon's own browser origin");

      if (url.pathname === "/api/login" && request.method === "POST") {
        const now = Date.now();
        if (now - loginWindow >= 60_000) { loginWindow = now; loginAttempts = 0; }
        loginAttempts += 1;
        if (loginAttempts > WEB_LIMITS.loginAttemptsPerMinute || loginRequests >= config.max_connections) {
          return problem(429, "too_many_requests", "Too many sign-in attempts; try again later");
        }
        loginRequests += 1;
        try {
          const body = await readSmallJson(request, WEB_LIMITS.loginBytes);
          if (!validWebLogin(body)) {
            return problem(400, "invalid_request", "Supply a token to sign in");
          }
          if (!options.authenticate(body.token)) return problem(401, "unauthorized", "The token was rejected");
          const previous = sessions.read(request);
          if (previous !== undefined) sessions.revoke(previous);
          const session = sessions.create();
          if (session === undefined) return problem(429, "too_many_requests", "Browser session limit reached");
          const headers = securityHeaders();
          headers.set("set-cookie", sessions.cookie(session));
          return Response.json(sessionInfo(session), { headers });
        } catch {
          return problem(400, "invalid_request", "Invalid sign-in request");
        } finally {
          loginRequests -= 1;
        }
      }

      const session = sessions.read(request);
      if (session === undefined) return problem(401, "unauthorized", "Sign in to connect to the daemon");
      if (url.pathname === "/api/logout" && request.method === "POST") {
        sessions.revoke(session);
        const headers = securityHeaders();
        headers.set("set-cookie", sessions.cookie());
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        return Response.json(sessionInfo(session), { headers: securityHeaders() });
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
  sessions = new WebSessions(origin, config.max_connections * 2, options.sessionLifetimeMs ?? WEB_LIMITS.sessionLifetimeMs);
  return {
    origin,
    port: server.port ?? binding.port,
    activate() { if (stopping === undefined) active = true; },
    stop() {
      if (stopping !== undefined) return stopping;
      active = false;
      const drained = peers.stop();
      sessions.close();
      stopping = (async () => {
        await server.stop(true);
        await drained;
      })();
      return stopping;
    },
  };
}
