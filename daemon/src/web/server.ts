import { readFileSync } from "node:fs";
import { required } from "../util/required.ts";
import type { WebConfig } from "../config/app.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { ArchiveSpool } from "../commands/archive_spool.ts";
import type { WebHello } from "../protocol/WebHello.ts";
import type { WebTransfer } from "../protocol/WebTransfer.ts";
import type { Server } from "../swp/server.ts";
import type { WebDevice } from "../protocol/WebDevice.ts";
import type { WebDeviceList } from "../protocol/WebDeviceList.ts";
import { browserName, LoginCodes, LoginFailures, WebSessions, type WebSession } from "./auth.ts";
import { WEB_CONTRACT, WEB_PROTOCOL, WEB_SUBPROTOCOL } from "./contract.ts";
import { validWebLogin, validWebLoginCode, validWebSession, validWebArchiveExport, validWebArchiveInfo, validWebArchiveList, validWebRequestList, validWebPreferences, validWebAutomationKey, validWebDeviceChoice, validWebDeviceList, validWebNewDevice } from "./contracts.ts";
import { bearerToken, DEVICE_NAME_RULE, deviceName, DeviceStore, principalName, principalOwner, type Principal } from "./devices.ts";
import { PasswordStore } from "./password.ts";
import { BUSY, problem, SignInDoor } from "./sign_in.ts";
import { commandRefusal, CONNECTION_ONLY_OPERATIONS, eventResponse, operationExists, operationResponse, refused, selected } from "./operations.ts";
import { checked, DAEMON_VERSION, pageOrigin, readSmallJson, securityHeaders, webBinding, WebBodyTooLarge, WEB_LIMITS } from "./policy.ts";
import { socketState, WebSocketPeers, type WebSocketState } from "./socket.ts";
import { browserAssets } from "./assets.generated.ts";

const servedAssets = new Map(Object.entries(browserAssets).map(([path, asset]) => [path, { type: asset.type, body: asset.encoding === "base64" ? Buffer.from(asset.body, "base64") : asset.body }]));
import { ArchiveTransfers, ArchiveTransferError, type ArchiveTransferLimits } from "./archives.ts";
import { WebRecovery, type WebRecoveryOptions } from "./recovery.ts";
import { RequestHistory, RequestHistoryError } from "./requests.ts";
import { PreferenceError, PreferenceStore, PREFERENCE_LIMITS } from "./preferences.ts";

export interface WebServerOptions {
  readonly config: WebConfig;
  readonly server: Server;
  readonly dataDir: string;
  readonly sessionLifetimeMs?: number;
  readonly loginCodeMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly archiveLimits?: Partial<ArchiveTransferLimits>;
  readonly recovery?: WebRecoveryOptions;
  readonly picture?: (file: string) => string | undefined;
  readonly transfers?: ArchiveSpool;
}

export interface RunningWebServer {
  readonly origin: string;
  readonly address: string;
  readonly port: number;
  activate(): void;
  stop(): Promise<void>;
}

const STATUS_CODES: Readonly<Record<number, WebProblem["code"]>> = { 401: "unauthorized", 404: "not_found", 429: "too_many_requests" };

export function statusProblem(status: number, message: string): Response {
  return problem(status, STATUS_CODES[status] ?? "invalid_request", message);
}

async function jsonBody(request: Request): Promise<unknown> {
  try { return await readSmallJson(request, WEB_LIMITS.loginBytes); } catch (error) {
    if (error instanceof WebBodyTooLarge) throw error;
    return undefined;
  }
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
  const loginFailures = new LoginFailures(WEB_LIMITS.loginAttemptsPerMinute);
  const codes = new LoginCodes(options.loginCodeMs ?? WEB_LIMITS.loginCodeMs, WEB_LIMITS.loginCodes);
  let archives: ArchiveTransfers;
  let recovery: WebRecovery | undefined;
  const preferences = new PreferenceStore(options.dataDir);
  const devices = new DeviceStore(options.dataDir);
  const door = new SignInDoor(new PasswordStore(options.dataDir), devices, loginFailures, config.max_connections);

  const deviceList = (principal: Principal): WebDeviceList => {
    const browsers = sessions.list().map((session): WebDevice => ({
      id: session.id, kind: "browser", name: session.name, created_at: session.createdAt, last_used_at: session.lastUsedAt, expires_at: session.expiresAt,
      current: principal.kind === "browser" && principal.session.id === session.id,
    }));
    const others = devices.list().map((device): WebDevice => ({
      id: device.id, kind: device.kind, name: device.name, created_at: device.createdAt,
      ...(device.lastUsedAt === undefined ? {} : { last_used_at: device.lastUsedAt }),
      ...(device.operations === undefined ? {} : { operations: [...device.operations] }),
      current: principal.kind === "device" && principal.device.id === device.id,
    }));
    return checked(validWebDeviceList, { devices: [...browsers, ...others] }, "device list");
  };

  const signIn = async (request: Request, url: URL, client: string): Promise<Response> => {
    if (["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return problem(403, "forbidden", "Another site’s page can’t use this daemon");
    const body = await jsonBody(request);
    return await door.attempt(async () => url.pathname === "/api/password" ? await door.password(body, client) : await door.cli(body, client));
  };

  const redeemed = (client: string, code: string): Response | undefined => {
    if (codes.redeem(code)) {
      loginFailures.succeeded(client);
      return undefined;
    }
    if (loginFailures.refused(client)) return problem(429, "too_many_requests", BUSY);
    loginFailures.failed(client);
    return problem(401, "unauthorized", "That sign-in code has expired or was already used");
  };

  const shared = async (request: Request, url: URL, http: Bun.Server<WebSocketState>, principal: Principal): Promise<Response | undefined> => {
    const owner = principalOwner(principal);
    const holdOpen = () => { http.timeout(request, 0); };
    const operation = /^\/api\/op\/([A-Za-z0-9_]+)$/.exec(url.pathname)?.[1];
    if (operation !== undefined && request.method === "POST") {
      if (!operationExists(operation)) return problem(404, "not_found", `There is no operation named ${operation}`);
      const allowed = principal.kind === "device" ? principal.device.operations : undefined;
      if (allowed !== undefined && !allowed.includes(operation)) return problem(403, "forbidden", `This key may run only ${allowed.join(", ")}`);
      return await operationResponse(request, { server: options.server, name: operation, clientName: principalName(principal), owner, queuedBytes: config.max_queued_bytes, holdOpen });
    }
    if (principal.kind === "device" && principal.device.operations !== undefined) return problem(403, "forbidden", "An automation key can only run the operations it was given");
    if (url.pathname === "/api/hello" && request.method === "GET") {
      const selection = await options.server.selection(selected(url, "character"), selected(url, "thread"));
      const hello: WebHello = {
        server_name: "shore-daemon", server_version: DAEMON_VERSION, characters: [...selection.characters],
        ...(selection.character === null ? {} : { selected_character: selection.character }),
        ...(selection.thread === null ? {} : { selected_thread: selection.thread }),
      };
      return Response.json(hello, { headers: securityHeaders() });
    }
    if (url.pathname === "/api/events" && request.method === "GET") {
      return await eventResponse(request, { server: options.server, clientName: principalName(principal), owner, queuedBytes: config.max_queued_bytes, holdOpen });
    }
    const transfer = /^\/api\/transfers\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    if (transfer !== undefined && request.method === "GET") {
      if (options.transfers === undefined) return problem(503, "unavailable", "This daemon keeps no archive transfers");
      let sent;
      try { sent = options.transfers.send(owner, transfer); } catch (error) { return commandRefusal(error); }
      holdOpen();
      const headers = securityHeaders();
      headers.set("content-type", "application/x-tar");
      return new Response(sent.stream, { headers });
    }
    if (url.pathname === "/api/transfers" && request.method === "POST") {
      if (options.transfers === undefined) return problem(503, "unavailable", "This daemon keeps no archive transfers");
      if (request.headers.get("content-type") !== "application/octet-stream" || request.body === null) return refused("invalid_request", "Send the archive's bytes as application/octet-stream");
      holdOpen();
      let received: WebTransfer;
      try { received = await options.transfers.receive(owner, request.body); } catch (error) { return commandRefusal(error); }
      return Response.json(received, { headers: securityHeaders() });
    }
    if (request.method !== "POST") return undefined;
    if (url.pathname === "/api/login-code") {
      const created = codes.create();
      return Response.json(checked(validWebLoginCode, { code: created.code, expires_at: created.expiresAt }, "browser sign-in code response"), { headers: securityHeaders() });
    }
    if (url.pathname === "/api/devices/list") return Response.json(deviceList(principal), { headers: securityHeaders() });
    if (url.pathname === "/api/devices/automation") {
      const body = await jsonBody(request);
      if (!validWebAutomationKey(body)) return problem(400, "invalid_request", "Name the key and list the operations it may run");
      const unknown = body.operations.filter((name) => !operationExists(name) || CONNECTION_ONLY_OPERATIONS.has(name));
      if (body.operations.length === 0 || unknown.length > 0) return problem(400, "invalid_request", unknown.length > 0 ? `A key can't run ${unknown.join(", ")}` : "Choose at least one operation the key may run");
      const name = deviceName(body.name);
      if (name === undefined) return problem(400, "invalid_request", DEVICE_NAME_RULE);
      const created = devices.create("automation", name, body.operations);
      const device = deviceList(principal).devices.find((entry) => entry.id === created.device.id);
      return Response.json(checked(validWebNewDevice, { device, token: created.token }, "automation key response"), { headers: securityHeaders() });
    }
    if (url.pathname === "/api/devices/revoke") {
      const body = await jsonBody(request);
      if (!validWebDeviceChoice(body)) return problem(400, "invalid_request", "Say which device to sign out");
      const browser = sessions.get(body.id);
      if (browser !== undefined) sessions.revoke(browser);
      else if (!devices.revoke(body.id)) return problem(404, "not_found", "No device has that id");
      return new Response(null, { status: 204, headers: securityHeaders() });
    }
    return undefined;
  };
  const server = Bun.serve({
    hostname: binding.hostname,
    port: binding.port,
    idleTimeout: 10,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    ...(config.tls_cert === undefined ? {} : { tls: { cert: readFileSync(config.tls_cert), key: readFileSync(required(config.tls_key)) } }),
    async fetch(request, http) {
      const url = new URL(request.url);
      if (!active) return problem(503, "unavailable", "The daemon is not ready");
      if (request.method === "GET" || request.method === "HEAD") {
        const asset = servedAssets.get(url.pathname === "/workspace" || url.pathname.startsWith("/workspace/") ? "/" : url.pathname);
        if (asset !== undefined) {
          const headers = securityHeaders(); headers.set("content-type", asset.type);
          if (url.pathname.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
          return new Response(request.method === "HEAD" ? null : asset.body, { headers });
        }
      }
      const picture = /^\/api\/pictures\/([^/]+)$/.exec(url.pathname)?.[1];
      if (picture !== undefined && (request.method === "GET" || request.method === "HEAD")) {
        if (["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return problem(403, "forbidden", "Another site’s page can’t use this daemon");
        if ((sessions.read(request, true) ?? sessions.read(request, false)) === undefined) return problem(401, "unauthorized", "Sign in to see pictures");
        const path = options.picture?.(picture);
        if (path === undefined) return problem(404, "not_found", "No such picture");
        const headers = securityHeaders();
        headers.set("cache-control", "private, max-age=31536000, immutable");
        headers.set("content-type", Bun.file(path).type);
        return new Response(request.method === "HEAD" ? null : Bun.file(path), { headers });
      }
      if (url.pathname === "/api/sign-in" && request.method === "GET") return door.state();
      if ((url.pathname === "/api/sign-in" || url.pathname === "/api/password") && request.method === "POST") {
        try { return await signIn(request, url, http.requestIP(request)?.address ?? "unknown"); } catch (error) {
          return error instanceof WebBodyTooLarge ? problem(413, "invalid_request", error.message) : problem(503, "unavailable", "The daemon couldn’t record this sign-in");
        }
      }
      const bearer = bearerToken(request);
      if (bearer !== undefined) {
        const device = devices.authenticate(bearer);
        if (device === undefined) return problem(401, "unauthorized", "This credential isn’t signed in to this daemon; sign in again");
        try { return await shared(request, url, http, { kind: "device", device }) ?? problem(404, "not_found", "Unknown endpoint for a signed-in device"); } catch (error) {
          return error instanceof WebBodyTooLarge ? problem(413, "invalid_request", error.message) : problem(503, "unavailable", "The daemon couldn’t complete this request");
        }
      }
      const page = pageOrigin(request, config.public_origin);
      if ("refused" in page) return problem(403, "forbidden", page.refused);
      const secureCookie = page.origin.startsWith("https:");

      if (url.pathname === "/api/login" && request.method === "POST") {
        const client = http.requestIP(request)?.address ?? "unknown";
        try {
          return await door.attempt(async () => {
            const body = await readSmallJson(request, WEB_LIMITS.loginBytes);
            if (!validWebLogin(body)) return problem(400, "invalid_request", "Give the password, or a sign-in code");
            const turnedAway = "password" in body ? await door.refusal(client, body.password) : redeemed(client, body.code);
            if (turnedAway !== undefined) return turnedAway;
            const previous = sessions.read(request, secureCookie);
            if (previous !== undefined) sessions.revoke(previous);
            const session = sessions.create(browserName(request.headers.get("user-agent")));
            if (session === undefined) return problem(503, "unavailable", "The daemon is stopping");
            const headers = securityHeaders();
            headers.set("set-cookie", sessions.cookie(session, secureCookie));
            return Response.json(sessionInfo(session, config.max_queued_bytes), { headers });
          });
        } catch (error) {
          if (error instanceof WebBodyTooLarge) return problem(413, "invalid_request", error.message);
          return problem(400, "invalid_request", "Invalid sign-in request");
        }
      }

      const session = sessions.read(request, secureCookie);
      if (session === undefined) return problem(401, "unauthorized", "Sign in to connect to the daemon");
      if (url.pathname.startsWith("/api/requests") && request.method === "POST") {
        try {
          if (url.pathname === "/api/requests/list") {
            return Response.json(checked(validWebRequestList, requests.list(session), "request history"), { headers: securityHeaders() });
          }
          const match = /^\/api\/requests\/([a-f0-9-]{36})\/acknowledge$/.exec(url.pathname);
          if (match?.[1] === undefined) return problem(404, "not_found", "Unknown request history endpoint");
          requests.acknowledge(session, match[1]);
          return new Response(null, { status: 204, headers: securityHeaders() });
        } catch (error) {
          if (error instanceof RequestHistoryError) return statusProblem(error.status, error.message);
          return problem(503, "unavailable", "Request recovery storage is unavailable; retain unreviewed outcomes and try again");
        }
      }
      if (url.pathname.startsWith("/api/archives") && request.method === "POST") {
        try {
          if (url.pathname === "/api/archives/list") {
            return Response.json(checked(validWebArchiveList, archives.list(session), "archive list"), { headers: securityHeaders() });
          }
          const [, id, action] = /^\/api\/archives\/([a-f0-9-]{36})\/(status|import|download|remove)$/.exec(url.pathname) ?? [];
          if (id !== undefined && action === "download") { http.timeout(request, 0); return await archives.download(session, id, request); }
          if (id !== undefined && action === "remove") { await archives.remove(session, id); return new Response(null, { status: 204, headers: securityHeaders() }); }
          let result;
          if (url.pathname === "/api/archives") { http.timeout(request, 0); result = await archives.upload(session, request); }
          else if (url.pathname === "/api/archives/export") {
            const body = await readSmallJson(request, WEB_LIMITS.loginBytes);
            if (!validWebArchiveExport(body)) return problem(400, "invalid_request", "Choose a character to export");
            result = archives.export(session, body.character);
          } else if (id === undefined) return problem(404, "not_found", "Unknown archive transfer endpoint");
          else result = action === "status" ? archives.get(session, id) : archives.import(session, id);
          const info = checked(validWebArchiveInfo, result, "archive transfer response");
          return Response.json(info, { status: info.phase === "importing" || info.phase === "exporting" ? 202 : 200, headers: securityHeaders() });
        } catch (error) {
          if (error instanceof WebBodyTooLarge) return problem(413, "invalid_request", error.message);
          if (error instanceof ArchiveTransferError) return statusProblem(error.status, error.message);
          return problem(400, "invalid_request", "Archive transfer could not be completed");
        }
      }
      if (url.pathname === "/api/preferences/list" && request.method === "POST") return Response.json(preferences.list(), { headers: securityHeaders() });
      if (url.pathname === "/api/preferences" && request.method === "POST") {
        let body: unknown;
        try { body = await readSmallJson(request, PREFERENCE_LIMITS.bodyBytes); } catch (error) {
          return error instanceof WebBodyTooLarge ? problem(413, "invalid_request", error.message) : problem(400, "invalid_request", "Invalid settings request");
        }
        if (!validWebPreferences(body)) return problem(400, "invalid_request", "Supply the settings to keep");
        try { return Response.json(preferences.save(body), { headers: securityHeaders() }); } catch (error) {
          return error instanceof PreferenceError ? problem(400, "invalid_request", error.message) : problem(503, "unavailable", "The daemon couldn’t save these settings");
        }
      }
      if (url.pathname === "/api/logout" && request.method === "POST") {
        sessions.revoke(session);
        const headers = securityHeaders();
        headers.set("set-cookie", sessions.cookie(undefined, secureCookie));
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const headers = securityHeaders();
        headers.set("set-cookie", sessions.renew(session, request, secureCookie));
        return Response.json(sessionInfo(session, config.max_queued_bytes), { headers });
      }
      if (url.pathname === "/api/swp" && request.method === "GET") {
        if (request.headers.get("sec-websocket-protocol") !== WEB_SUBPROTOCOL) {
          return problem(409, "reload_required", "This browser version is incompatible; reload the page");
        }
        if (http.pendingWebSockets >= config.max_connections) return problem(429, "too_many_requests", "Browser connection limit reached");
        return http.upgrade(request, { data: socketState(session), headers: securityHeaders() })
          ? undefined : problem(400, "invalid_request", "Expected a WebSocket upgrade");
      }
      try { return await shared(request, url, http, { kind: "browser", session }) ?? problem(404, "not_found", "Unknown browser endpoint"); } catch (error) {
        return error instanceof WebBodyTooLarge ? problem(413, "invalid_request", error.message) : problem(503, "unavailable", "The daemon couldn’t complete this request");
      }
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
    sessions = new WebSessions(origin, config.max_connections * 2, options.sessionLifetimeMs ?? config.session_lifetime.asMillis(), recovery);
    closeSessions = () => sessions.close();
    archives = new ArchiveTransfers(options.server, () => active, options.archiveLimits, recovery);
    archives.restore(sessions);
    requests = new RequestHistory(recovery);
    requests.restore(sessions);
    peers = new WebSocketPeers(options.server, config.max_queued_bytes,
      options.handshakeTimeoutMs ?? WEB_LIMITS.handshakeTimeoutMs,
      options.drainTimeoutMs ?? WEB_LIMITS.drainTimeoutMs, requests);
  } catch (error) { closeSessions?.(); recovery?.close(); void server.stop(true); throw error; }
  return {
    origin,
    address: server.url.origin,
    port: server.port ?? binding.port,
    activate() { if (stopping === undefined) active = true; },
    stop() {
      if (stopping !== undefined) return stopping;
      active = false;
      const drained = Promise.all([peers.stop(), archives.close()]);
      sessions.close();
      stopping = (async () => {
        const finished = server.stop(false);
        await Promise.race([finished, Bun.sleep(WEB_LIMITS.finishOnStopMs)]);
        await server.stop(true);
        await drained;
        recovery?.close();
      })();
      return stopping;
    },
  };
}
