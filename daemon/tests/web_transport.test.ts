import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import type { WebRequestList } from "../src/protocol/WebRequestList.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { BrowserSocket } from "./support/browser.ts";
import { browserConnection } from "./support/browser_connection.ts";
import { InterruptedRequestError } from "../src/browser/connection.ts";
import { OperationClient, OperationFailure } from "../src/browser/operations.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";
import { Server } from "../src/swp/server.ts";
import type { ControlRoutedMessage, RoutedMessage } from "../src/swp/session.ts";
import { WEB_CONTRACT, WEB_SUBPROTOCOL } from "../src/web/contract.ts";
import { WEB_LIMITS, webBinding, webRequestOrigin } from "../src/web/policy.ts";
import { startWebServer, type WebServerOptions } from "../src/web/server.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";

const TOKEN = "web-transport-test-token";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Transport did not settle");
    await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
  }
}

async function fixture(options: Partial<Omit<WebServerOptions, "server" | "authenticate">> = {}, provider?: HandshakeProvider) {
  let histories = 0;
  const swp = new Server({
    addr: "127.0.0.1:0", serverName: "web-test", authenticate: (token) => tokenMatches(TOKEN, token),
    handshake: provider ?? {
      hello: async () => ({ characters: [{ name: "ada" }, { name: "bo" }] }),
      history: async (selected, thread) => {
        histories += 1;
        return { messages: [], previousSegment: null, config: {}, selectedCharacter: selected, selectedThread: thread ?? "main", revision: 0 };
      },
    },
  });
  await swp.bind();
  const served = swp.serve();
  const routed: RoutedMessage[] = [];
  const controls: ControlRoutedMessage[] = [];
  swp.setControlHandler(async (message) => { if (message.kind !== "session_connected") controls.push(message); });
  const routing = (async () => { for await (const message of swp.routes()) routed.push(message); })();
  const web = startWebServer({
    server: swp, authenticate: (token) => tokenMatches(TOKEN, token),
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" }, ...options,
  });
  cleanups.push(async () => { await web.stop(); swp.stop(); await Promise.all([served, routing]); });
  const api = (path: string, cookie = "", body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${web.origin}${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { origin: web.origin, "content-type": "application/json", cookie, ...headers },
      ...(options.config?.tls_cert === undefined ? {} : { tls: { ca: readFileSync(options.config.tls_cert) } }),
    });
  const login = async () => {
    const response = await api("/api/login", "", { token: TOKEN });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("No session cookie");
    return { cookie, response, info: await response.json() as WebSessionInfo };
  };
  const finish = async (session: number, message: ServerMessage) => {
    swp.sessionRouter.reportRequest(session, message);
    await swp.sessionRouter.sendToSession(session, message);
  };
  return { swp, web, routed, controls, api, login, finish, histories: () => histories };
}

function connectBrowser(origin: string, cookie: string, protocol = WEB_SUBPROTOCOL, options?: ConstructorParameters<typeof BrowserSocket>[3]): BrowserSocket {
  const browser = new BrowserSocket(origin, cookie, protocol, options);
  cleanups.push(async () => { await browser.close(); });
  return browser;
}

describe("browser connection state", () => {
  test("embedded app assets and deep links are public without attaching a peer or exposing history", async () => {
    const f = await fixture(); f.web.activate();
    const document = await fetch(`${f.web.origin}/workspace/ada/main`);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("text/html");
    expect(document.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await document.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    expect(assets).toHaveLength(3);
    for (const asset of assets) {
      const response = await fetch(`${f.web.origin}${asset ?? ""}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect((await fetch(`${f.web.origin}/`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${f.web.origin}/`, { headers: { origin: "https://outside.example" } })).status).toBe(200);
    for (const site of ["cross-site", "same-site"]) {
      expect((await fetch(`${f.web.origin}/workspace/ada/main`, { headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status).toBe(200);
    }
    expect((await f.api("/api/session")).status).toBe(401);
    expect(f.histories()).toBe(0);
    expect(f.swp.sessionRouter.sessions()).toHaveLength(0);
  });

  test("typed actions reject invalid results and failures while preserving correlation and additive results", async () => {
    const f = await fixture(); f.web.activate();
    const b = browserConnection(f.web.origin);
    const actions = new OperationClient(b.client);
    try {
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      const session = f.swp.sessionRouter.sessions().at(0)?.[0];
      if (session === undefined) throw new Error("Missing session");
      // @ts-expect-error the canonical input rejects unknown fields at compile time and runtime
      expect(await outcomeOf(actions.run("edit", { ref: "1", content: "hi", typo: true }))).toThrow("Invalid arguments");
      expect(b.client.pendingCount).toBe(0);
      for (const scenario of ["invalid", "missing", "wrong-name", "duplicate", "failed", "valid"] as const) {
        const observed: string[] = [];
        const action = actions.run("edit", { ref: "1", content: "hi" }, { observe: (frame) => { observed.push(frame.type); } });
        const outcome = action.then((value) => ({ value }), (error: unknown) => ({ error }));
        await until(() => f.routed.length > 0);
        const route = f.routed.shift();
        if (route?.kind !== "command") throw new Error("Missing command route");
        const rid = route.meta.rid;
        if (rid === undefined || rid === null) throw new Error("Missing action request");
        expect(actions.pendingOperation(rid)).toBe("edit");
        const data = { ref: "1", edited: true, future_metadata: scenario };
        await f.swp.sessionRouter.sendToSession(session, { type: "command_output", rid: "unrelated", name: "edit", data: {} });
        if (scenario !== "missing") await f.swp.sessionRouter.sendToSession(session, {
          type: "command_output", rid, name: scenario === "wrong-name" ? "get" : "edit", data: scenario === "invalid" ? { ref: "1" } : data,
        });
        if (scenario === "duplicate") await f.swp.sessionRouter.sendToSession(session, { type: "command_output", rid, name: "edit", data });
        await f.swp.sessionRouter.sendToSession(session, {
          type: "request_finished", rid, outcome: scenario === "failed" ? "failed" : "completed",
          ...(scenario === "failed" ? { error: { code: "not_found" as const, message: "Message disappeared" } } : {}),
        });
        const result = await outcome;
        expect(actions.pendingOperation(rid)).toBeUndefined();
        expect(observed).toEqual(scenario === "missing" ? ["request_finished"] : scenario === "duplicate" ? ["command_output", "command_output", "request_finished"] : ["command_output", "request_finished"]);
        if (scenario === "valid") expect(result).toEqual({ value: data });
        else if ("error" in result) {
          expect(result.error).toBeInstanceOf(scenario === "failed" ? OperationFailure : Error);
          expect(String(result.error)).toContain(scenario === "failed" ? "Message disappeared" : "Invalid result for edit");
        } else throw new Error(`Unexpected success: ${scenario}`);
        expect(b.client.pendingCount).toBe(0);
      }
    } finally { b.client.stop(); }
  });

  test("advertised pending byte limits apply after socket drain and are released by completion", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie, info } = await f.login();
    const b = browserConnection(f.web.origin, {
      fetch: async () => Response.json({ ...info, max_message_bytes: 1024 }),
      socket: (url, subprotocol) => new WebSocket(url, { protocols: [subprotocol], headers: { origin: f.web.origin, cookie } }),
    });
    try {
      b.client.connect(); await until(() => b.client.status === "ready");
      const command = { type: "command", name: "status", args: { text: "x".repeat(600) } } as const;
      const first = b.client.submit(command);
      await until(() => f.routed.length === 1);
      expect(() => b.client.submit(command)).toThrow("connection limit");
      const session = f.swp.sessionRouter.sessions().at(0)?.[0];
      if (session === undefined) throw new Error("Missing session");
      await f.swp.sessionRouter.sendToSession(session, { type: "request_finished", rid: first.rid, outcome: "completed" });
      await first.finished;
      expect(() => b.client.submit(command)).not.toThrow();
      await until(() => f.routed.length === 2);
      expect(b.client.pendingCount).toBe(1);
    } finally { b.client.stop(); }
  });

  test("sign-in, completion and cancellation use the same bounded native session", async () => {
    const f = await fixture(); f.web.activate();
    const b = browserConnection(f.web.origin);
    try {
      b.client.connect(); await until(() => b.client.status === "signed_out");
      expect(f.histories()).toBe(0);
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      expect(b.client.selection).toMatchObject({ character: "ada", thread: "main", snapshotRevision: 0 });
      const requests = Array.from({ length: 32 }, () => b.client.submit({ type: "command", name: "status", args: {} }));
      expect(() => b.client.submit({ type: "command", name: "status", args: {} })).toThrow("Wait for a pending request");
      b.client.cancel(); await until(() => f.controls.length === 1 && f.routed.length === 32);
      const session = f.swp.sessionRouter.sessions().at(0)?.[0];
      const request = requests.at(0);
      if (session === undefined || request === undefined) throw new Error("Missing request session");
      await f.swp.sessionRouter.sendToSession(session, { type: "command_output", rid: request.rid, name: "status", data: { result: "visible" } });
      await until(() => b.updates.some((update) => update.kind === "frame" && update.message.type === "command_output"));
      expect(b.client.pendingCount).toBe(32);
      await f.swp.sessionRouter.sendToSession(session, { type: "request_finished", rid: request.rid, outcome: "completed" });
      expect(await request.finished).toMatchObject({ rid: request.rid, outcome: "completed" });
      expect(b.client.pendingCount).toBe(31);
      await b.client.signOut(); expect(b.client.status).toBe("signed_out");
      await until(() => f.swp.sessionRouter.sessions().length === 0);
    } finally { b.client.stop(); }
  });

  test("a lost mutation is marked uncertain and never resent after a fresh selected-thread snapshot", async () => {
    const f = await fixture(); f.web.activate();
    const b = browserConnection(f.web.origin, { thread: "side" });
    try {
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      const request = b.client.submit({ type: "command", name: "create_thread", args: { name: "possibly-created" } });
      await until(() => f.routed.length === 1);
      b.sockets.at(0)?.close();
      expect(await rejectionOf(request.finished)).toBeInstanceOf(InterruptedRequestError);
      await until(() => f.histories() === 2 && b.client.status === "ready");
      const probe = b.client.submit({ type: "command", name: "status", args: {} });
      await until(() => f.routed.some((route) => route.kind === "command" && route.meta.rid === probe.rid));
      expect(f.routed.filter((route) => route.kind === "command" && route.cmd.name === "create_thread")).toHaveLength(1);
      expect(b.client.pendingCount).toBe(1);
      expect(b.client.selection.thread).toBe("side");
      expect(b.updates.find((update) => update.kind === "uncertain")).toMatchObject({ rid: request.rid, request: { name: "create_thread" }, selection: { thread: "side" } });
    } finally { b.client.stop(); }
  });

  test("a revision gap reconnects for fresh history while stale and foreign updates stay hidden", async () => {
    const f = await fixture(); f.web.activate();
    const b = browserConnection(f.web.origin);
    try {
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      const session = f.swp.sessionRouter.sessions().at(0)?.[0];
      if (session === undefined) throw new Error("Missing session");
      const snapshot = { type: "history", messages: [], config: {}, selected_character: "ada", selected_thread: "main", revision: 1 } as const;
      await f.swp.sessionRouter.sendToSession(session, { ...snapshot, messages: [] });
      await until(() => b.client.selection.snapshotRevision === 1);
      const count = () => b.updates.filter((update) => update.kind === "frame" && update.message.type === "history").length;
      expect(count()).toBe(2);
      await f.swp.sessionRouter.sendToSession(session, { ...snapshot, messages: [], revision: 0 });
      await f.swp.sessionRouter.sendToSession(session, { ...snapshot, messages: [], selected_thread: "side", revision: 100, delta: { base_revision: 1, after: null } });
      await f.swp.sessionRouter.sendToSession(session, { ...snapshot, messages: [], revision: 3, delta: { base_revision: 2, after: null } });
      await until(() => f.histories() === 2 && b.client.status === "ready");
      expect(count()).toBe(3);
      expect(b.client.selection.snapshotRevision).toBe(0);
      expect(b.updates.some((update) => update.kind === "status" && update.detail.includes("updates were missed"))).toBe(true);
    } finally { b.client.stop(); }
  });

  test("a stale browser contract stops before attaching and session expiry prompts sign-in", async () => {
    const f = await fixture({ sessionLifetimeMs: 100 }); f.web.activate();
    const stale = browserConnection(f.web.origin, { contract: "old-contract" });
    const current = browserConnection(f.web.origin);
    try {
      await stale.client.signIn(TOKEN); await until(() => stale.client.status === "reload_required");
      expect(stale.sockets).toHaveLength(0); expect(f.histories()).toBe(0);
      await current.client.signIn(TOKEN); await until(() => current.client.status === "ready");
      await until(() => current.client.status === "signed_out");
      expect(current.client.detail).toContain("Sign in");
      expect(current.sockets).toHaveLength(1);
    } finally { stale.client.stop(); current.client.stop(); }
  });

  test("a session lifetime beyond the timer limit keeps the browser signed in", async () => {
    const f = await fixture({ sessionLifetimeMs: 90 * 24 * 60 * 60 * 1000 }); f.web.activate();
    const b = browserConnection(f.web.origin);
    try {
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      await Bun.sleep(50);
      expect(b.client.status).toBe("ready");
      b.client.reconnect(); await until(() => b.client.status === "ready");
    } finally { b.client.stop(); }
  });

  test("future events remain inspectable but invalid known events halt the connection", async () => {
    const f = await fixture(); f.web.activate();
    const b = browserConnection(f.web.origin);
    try {
      await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
      const session = f.swp.sessionRouter.sessions().at(0)?.[0];
      if (session === undefined) throw new Error("Missing session");
      await f.swp.sessionRouter.sendToSession(session, { type: "future_progress", detail: { text: "inspectable" } } as unknown as ServerMessage);
      await until(() => b.updates.some((update) => update.kind === "future"));
      expect(b.client.status).toBe("ready");
      await f.swp.sessionRouter.sendToSession(session, { type: "stream_chunk", text: 123, content_type: "text" } as unknown as ServerMessage);
      await until(() => b.client.status === "error");
      expect(b.client.detail).toContain("invalid stream_chunk");
      expect(b.sockets).toHaveLength(1);
    } finally { b.client.stop(); }
  });
});

describe("browser authentication boundary", () => {
  test("LAN, Tailscale and arbitrary DNS hostnames and ports support authenticated HTTP and WebSocket", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "0.0.0.0:0" } }); f.web.activate();
    const target = `http://127.0.0.1:${String(f.web.port)}`;
    for (const host of [`localhost:${String(f.web.port)}`, "localhost:17340", "127.0.0.1:17340", "192.168.1.10:7340", "[::1]:17340", `${hostname()}:7340`, "100.101.102.103:7340", "shore.test-tailnet.ts.net:7340", "lab-box:7340", "alias.example:17340"]) {
      const origin = `http://${host}`;
      expect((await fetch(`${target}/workspace`, { headers: { host } })).status).toBe(200);
      expect((await fetch(`${target}/api/session`, { method: "POST", headers: { host, origin } })).status).toBe(401);
      expect((await fetch(`${target}/api/login`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) })).status).toBe(401);
      const login = await fetch(`${target}/api/login`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).not.toContain("Secure");
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Missing browser cookie");
      expect((await fetch(`${target}/api/session`, { method: "POST", headers: { host, origin, cookie } })).status).toBe(200);
      const browser = connectBrowser(target, cookie, WEB_SUBPROTOCOL, { headers: { host, origin } });
      await browser.attach();
      expect(await browser.frame("history")).toMatchObject({ selected_character: "ada" });
      await browser.close();
      for (const foreign of [target, "http://localhost:9999", "https://outside.example", "null", ""]) {
        expect((await fetch(`${target}/api/session`, { method: "POST", headers: { host, origin: foreign, cookie } })).status).toBe(403);
      }
    }
  });

  test("HTTPS proxy configuration allows direct HTTP access with working cookies and logout for each", async () => {
    const origin = "https://shore.example";
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", public_origin: origin } }); f.web.activate();
    const target = `http://127.0.0.1:${String(f.web.port)}`;
    for (const accessOrigin of [origin, target, "http://shore.test-tailnet.ts.net:17340"]) {
      const headers = { host: new URL(accessOrigin).host, origin: accessOrigin };
      const secure = accessOrigin.startsWith("https:");
      expect((await fetch(`${target}/workspace`, { headers })).status).toBe(200);
      expect((await fetch(`${target}/api/session`, { method: "POST", headers })).status).toBe(401);
      const login = await fetch(`${target}/api/login`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")?.includes("Secure")).toBe(secure);
      expect(login.headers.get("set-cookie")?.startsWith("__Host-")).toBe(secure);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Missing browser cookie");
      expect((await fetch(`${target}/api/session`, { method: "POST", headers: { ...headers, cookie } })).status).toBe(200);
      const browser = connectBrowser(target, cookie, WEB_SUBPROTOCOL, { headers });
      await browser.attach();
      expect(await browser.frame("history")).toMatchObject({ selected_character: "ada" });
      const logout = await fetch(`${target}/api/logout`, { method: "POST", headers: { ...headers, cookie } });
      expect(logout.status).toBe(204);
      expect(logout.headers.get("set-cookie")?.split("=", 1)[0]).toBe(cookie.split("=", 1)[0]);
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await browser.closed).code).toBe(4001);
      expect((await fetch(`${target}/api/session`, { method: "POST", headers: { ...headers, cookie } })).status).toBe(401);
    }
  });

  test("HTTPS serves a verified TLS connection and a host-only secure cookie for WSS", async () => {
    const tls_cert = new URL("./support/web-tls/cert.pem", import.meta.url).pathname;
    const tls_key = new URL("./support/web-tls/key.pem", import.meta.url).pathname;
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", tls_cert, tls_key } }); f.web.activate();
    expect(f.web.origin).toStartWith("https://");
    const { cookie, response } = await f.login();
    expect(cookie).toStartWith("__Host-shore_web_");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("Path=/");
    const browser = connectBrowser(f.web.origin, cookie, WEB_SUBPROTOCOL, { tls: { ca: readFileSync(tls_cert) } });
    await browser.attach();
    expect(await browser.frame("history")).toMatchObject({ selected_character: "ada" });
  });

  test("malformed sign-in bodies and oversized native HTTP bodies cannot create a session", async () => {
    const f = await fixture(); f.web.activate();
    for (const body of [{}, { token: 1 }, { token: TOKEN, extra: true }, [TOKEN]]) {
      expect((await f.api("/api/login", "", body)).status).toBe(400);
    }
    expect((await f.api("/api/login", "", { token: TOKEN }, { "content-type": "text/plain" })).status).toBe(400);
    const malformed = await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { origin: f.web.origin, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await f.api("/api/login", "", { token: "x".repeat(WEB_LIMITS.loginBytes) })).status).toBe(413);
    const chunked = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(WEB_LIMITS.loginBytes + 1)); controller.close(); } });
    expect((await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { origin: f.web.origin, "content-type": "application/json" }, body: chunked })).status).toBe(413);
    expect(f.histories()).toBe(0);
    expect((await f.api("/api/session")).status).toBe(401);
  });

  test("session storage and repeated failed sign-ins are bounded", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    const first = await f.login(); await f.login();
    expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(200);
    expect((await f.api("/api/session", first.cookie)).status).toBe(401);
    for (let i = 0; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) {
      expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(401);
    }
    expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(429);
    expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(200);
    expect(f.histories()).toBe(0);
  });

  test("authentication and compatibility precede any history or peer attachment", async () => {
    const f = await fixture();
    expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(503);
    f.web.activate();
    expect((await f.api("/api/session")).status).toBe(401);
    expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(401);
    const denied = connectBrowser(f.web.origin, "");
    expect(await outcomeOf(denied.opened)).toThrow("rejected");
    await denied.closed;
    expect(denied.messages).toEqual([]);
    const { cookie, response, info } = await f.login();
    expect(info).toMatchObject({ contract: WEB_CONTRACT, protocol: 1, max_pending_requests: 32 });
    expect(JSON.stringify(info)).not.toContain(TOKEN);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const stale = await fetch(`${f.web.origin}/api/swp`, { headers: { origin: f.web.origin, cookie, "sec-websocket-protocol": "old-browser" } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "reload_required" });
    expect(f.histories()).toBe(0);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
  });

  test("cross-origin, missing-origin and mismatched-host requests are refused", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    for (const origin of ["https://evil.example", "null", ""]) {
      expect((await f.api("/api/logout", cookie, {}, { origin })).status).toBe(403);
      expect((await f.api("/api/login", "", { token: TOKEN }, { origin })).status).toBe(403);
    }
    expect((await f.api("/api/session", cookie, {}, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await f.api("/api/session", cookie, {}, { host: "evil.example" })).status).toBe(403);
    expect((await f.api("/api/session", cookie)).status).toBe(200);
    const forged = connectBrowser(f.web.origin, cookie, WEB_SUBPROTOCOL, { headers: { origin: "https://evil.example" } });
    expect(await outcomeOf(forged.opened)).toThrow("rejected"); await forged.closed;
    expect(f.histories()).toBe(0);
  });

  test("query parameters do not block navigation or replace token authentication", async () => {
    const f = await fixture(); f.web.activate();
    expect((await fetch(`${f.web.origin}/workspace?view=chat`)).status).toBe(200);
    expect((await f.api(`/api/session?token=${TOKEN}`)).status).toBe(401);
    expect((await f.api(`/api/login?token=${TOKEN}`)).status).toBe(400);
    const { cookie } = await f.login();
    expect((await f.api("/api/session?view=chat", cookie)).status).toBe(200);
  });

  test("logout revokes active sockets and prevents cookie reuse", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    expect(f.swp.sessionRouter.sessions()).toHaveLength(1);
    const logout = await f.api("/api/logout", cookie);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await browser.closed).code).toBe(4001);
    expect((await f.api("/api/session", cookie)).status).toBe(401);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
  });

  test("a sign-in expires even while its socket remains active", async () => {
    const f = await fixture({ sessionLifetimeMs: 150 }); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    expect((await browser.closed).code).toBe(4001);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
    expect((await f.api("/api/session", cookie)).status).toBe(401);
  });
});

describe("browser session routing", () => {
  test("tabs have independent selections and correlated replies", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const first = connectBrowser(f.web.origin, cookie); await first.attach("ada", "main");
    const second = connectBrowser(f.web.origin, cookie); await second.attach("bo", "branch");
    expect(await first.frame("history")).toMatchObject({ selected_character: "ada", selected_thread: "main" });
    expect(await second.frame("history")).toMatchObject({ selected_character: "bo", selected_thread: "branch" });
    first.send({ type: "command", rid: "first", name: "list_threads", args: {} });
    second.send({ type: "command", rid: "second", name: "list_threads", args: {} });
    await until(() => f.routed.length === 2);
    expect(f.routed).toMatchObject([
      { kind: "command", meta: { rid: "first", session: { selectedCharacter: "ada", selectedThread: "main" } } },
      { kind: "command", meta: { rid: "second", session: { selectedCharacter: "bo", selectedThread: "branch" } } },
    ]);
    const [entry] = f.swp.sessionRouter.sessions();
    if (entry === undefined) throw new Error("No first session");
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "command_output", rid: "first", name: "list_threads", data: { character: "ada" } });
    expect(await first.frame("command_output", "first")).toMatchObject({ data: { character: "ada" } });
    expect(second.messages.some((message) => message.type === "command_output")).toBe(false);
    first.socket.close(); await first.closed;
    await until(() => !f.swp.sessionRouter.has(entry[0]));
    expect(f.swp.sessionRouter.sessions()).toHaveLength(1);
  });

  test("pending requests are bounded while cancellation still reaches the control handler", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    for (let i = 0; i <= WEB_LIMITS.pendingRequests; i += 1) browser.send({ type: "command", rid: `pending-${String(i)}`, name: "status", args: {} });
    expect(await browser.frame("error", "pending-32")).toMatchObject({ message: "Too many pending requests; wait for a result" });
    browser.send({ type: "cancel" });
    await until(() => f.controls.length > 0);
    expect(f.routed).toHaveLength(32);
    expect(f.controls).toMatchObject([{ kind: "engine", msg: { type: "cancel" } }]);
    const [entry] = f.swp.sessionRouter.sessions();
    if (entry === undefined) throw new Error("No session");
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "command_output", rid: "pending-0", name: "status", data: {} });
    await browser.frame("command_output", "pending-0");
    browser.send({ type: "command", rid: "not-finished", name: "status", args: {} });
    expect(await browser.frame("request_finished", "not-finished")).toMatchObject({ outcome: "failed" });
    expect(f.routed).toHaveLength(32);
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "request_finished", rid: "pending-0", outcome: "completed" });
    await browser.frame("request_finished", "pending-0");
    browser.send({ type: "command", rid: "new", name: "status", args: {} });
    await until(() => f.routed.length === 33);
    expect(f.routed.at(-1)).toMatchObject({ meta: { rid: "new" } });
  });

  test("shutdown sends a terminal notice and releases every attached peer", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    await f.web.stop();
    await browser.closed;
    expect(browser.messages.some((message) => message.type === "shutdown")).toBe(true);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
  });
});

describe("browser resource limits", () => {
  test("a reader that resumes receives a buffered frame exactly once and then the next frame", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    const [entry] = f.swp.sessionRouter.sessions();
    if (entry === undefined) throw new Error("No session");
    browser.socket.pause();
    try {
      await f.swp.sessionRouter.sendToSession(entry[0], { type: "command_output", rid: "buffered", name: "status", data: "x".repeat(16 * 1024 * 1024) });
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    } finally { browser.socket.resume(); }
    await browser.frame("command_output", "buffered");
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "ping" });
    await browser.frame("ping");
    expect(browser.messages.filter((message) => message.type === "command_output")).toHaveLength(1);
    expect(f.swp.sessionRouter.has(entry[0])).toBe(true);
  });

  test("a paused network reader times out in native backpressure without holding other sessions", async () => {
    const f = await fixture({ drainTimeoutMs: 50 }); f.web.activate();
    const { cookie } = await f.login();
    const slow = connectBrowser(f.web.origin, cookie); await slow.attach();
    const other = connectBrowser(f.web.origin, cookie); await other.attach();
    const [slowEntry, otherEntry] = f.swp.sessionRouter.sessions();
    if (slowEntry === undefined || otherEntry === undefined) throw new Error("Missing sessions");
    slow.socket.pause();
    try {
      await f.swp.sessionRouter.sendToSession(slowEntry[0], { type: "command_output", name: "status", data: "x".repeat(16 * 1024 * 1024) });
      await until(() => !f.swp.sessionRouter.has(slowEntry[0]));
      await f.swp.sessionRouter.sendToSession(otherEntry[0], { type: "ping" });
      expect(await other.frame("ping")).toEqual({ type: "ping" });
    } finally { slow.socket.resume(); }
    expect((await slow.closed).code).toBe(1013);
    expect(slow.closeDetail).toContain("Slow connection");
    expect(slow.messages.filter((message) => message.type === "command_output")).toHaveLength(1);
  });

  test("request IDs that the shared router cannot preserve are refused before routing", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    for (const rid of ["", "💬", "bad\u0000id", "x".repeat(129)]) {
      const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
      browser.send({ type: "message", rid, text: "hi", stream: true });
      expect((await browser.closed).code).toBe(1008);
    }
    expect(f.routed).toEqual([]);
  });

  test("pending byte allowance is released after its correlated request finishes", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_queued_bytes: 1024 } }); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    const command = (rid: string) => ({ type: "command", rid, name: "status", args: { text: "a".repeat(600) } });
    browser.send(command("first")); browser.send(command("full"));
    await browser.frame("error", "full");
    expect(f.routed).toHaveLength(1);
    const [entry] = f.swp.sessionRouter.sessions();
    if (entry === undefined) throw new Error("No session");
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "command_output", rid: "first", name: "status", data: {} });
    await browser.frame("command_output", "first");
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "request_finished", rid: "first", outcome: "completed" });
    await browser.frame("request_finished", "first");
    browser.send(command("after"));
    await until(() => f.routed.length === 2);
    expect(f.routed.at(-1)).toMatchObject({ meta: { rid: "after" } });
  });

  test("duplicate correlation IDs and request floods disconnect their originating peer", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const duplicate = connectBrowser(f.web.origin, cookie); await duplicate.attach();
    for (let i = 0; i < 2; i += 1) duplicate.send({ type: "command", rid: "same", name: "status", args: {} });
    expect((await duplicate.closed).code).toBe(1008);
    const flood = connectBrowser(f.web.origin, cookie); await flood.attach();
    for (let i = 0; i <= WEB_LIMITS.requestsPerSecond; i += 1) flood.send({ type: "cancel" });
    expect((await flood.closed).code).toBe(1008);
    await until(() => f.swp.sessionRouter.sessions().length === 0);
  });

  test("connection admission includes sockets still waiting for their hello", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    const { cookie } = await f.login();
    const first = connectBrowser(f.web.origin, cookie); await first.opened;
    const extra = connectBrowser(f.web.origin, cookie);
    expect(await outcomeOf(extra.opened)).toThrow("rejected"); await extra.closed;
    expect(f.histories()).toBe(0);
  });

  test("a stalled attachment expires without leaving a late session", async () => {
    const f = await fixture({ handshakeTimeoutMs: 30 }, {
      hello: async () => ({ characters: [{ name: "ada" }] }),
      history: () => new Promise(() => {}),
    }); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.opened;
    browser.send({ type: "hello", client_type: "web", client_name: "slow", capabilities: [] });
    expect((await browser.closed).code).toBe(1008);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
  });

  test("malformed, oversized and binary hello messages never attach", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    for (const text of ["{", "x".repeat(WEB_LIMITS.helloBytes + 1), new Uint8Array([1, 2])]) {
      const browser = connectBrowser(f.web.origin, cookie); await browser.opened;
      browser.socket.send(text); await browser.closed;
      expect(browser.messages).toEqual([]);
    }
    expect(f.histories()).toBe(0);
  });

  test("outgoing overflow closes one peer and keeps another usable", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_queued_bytes: 1024 } }); f.web.activate();
    const { cookie } = await f.login();
    const first = connectBrowser(f.web.origin, cookie); await first.attach();
    const other = connectBrowser(f.web.origin, cookie); await other.attach();
    const [firstEntry, otherEntry] = f.swp.sessionRouter.sessions();
    if (firstEntry === undefined || otherEntry === undefined) throw new Error("Missing sessions");
    await f.swp.sessionRouter.sendToSession(firstEntry[0], { type: "command_output", name: "status", data: "x".repeat(2048) });
    expect((await first.closed).code).toBe(1013);
    await f.swp.sessionRouter.sendToSession(otherEntry[0], { type: "ping" });
    expect(await other.frame("ping")).toEqual({ type: "ping" });
  });

  test("unrelated history broadcasts do not consume a browser peer's queue", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_queued_bytes: 1024 } }); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach("ada", "main");
    const history = { type: "history", messages: [], config: { oversized: "x".repeat(2048) }, selected_character: "bo", selected_thread: "main", revision: 1 } satisfies ServerMessage;
    f.swp.broadcast(history);
    f.swp.broadcast({ ...history, selected_character: "ada", selected_thread: "side" });
    for (let revision = 2; revision < 300; revision += 1) f.swp.broadcast({ ...history, config: {}, revision });
    f.swp.broadcast({ type: "ping" });
    expect(await browser.frame("ping")).toEqual({ type: "ping" });
    expect(f.swp.sessionRouter.sessions()).toHaveLength(1);
    f.swp.broadcast({ ...history, selected_character: "ada" });
    await until(() => browser.messages.some(message => message.type === "history" && message.revision === 1));
    expect(f.swp.sessionRouter.sessions()).toHaveLength(1);
  });

  test("archive-sized local queues route broadcasts using the current selection before counting bytes", async () => {
    const f = await fixture();
    let overflows = 0;
    const peer = await f.swp.attachLocal({ clientType: "web", clientName: "archive-worker", character: "ada", thread: "main",
      outboundLimits: { messages: 4, bytes: 1024 * 1024, onOverflow: () => { overflows += 1; } } });
    try {
      const events = peer.events();
      expect((await events.next()).value).toMatchObject({ type: "history" });
      const oversized = { type: "history", messages: [], config: { oversized: "x".repeat(1024 * 1024) }, selected_character: "bo", selected_thread: "side", revision: 1 } satisfies ServerMessage;
      f.swp.broadcast(oversized);
      f.swp.broadcast({ type: "ping" });
      expect((await events.next()).value).toEqual({ type: "ping" });
      expect(overflows).toBe(0);
      f.swp.sessionRouter.setSelectedCharacter(peer.session.sessionId, "bo");
      f.swp.sessionRouter.setSelectedThread(peer.session.sessionId, "side");
      f.swp.broadcast({ ...oversized, selected_character: "ada", selected_thread: "main" });
      const matching = { ...oversized, config: {} };
      f.swp.broadcast(matching);
      expect((await events.next()).value).toEqual(matching);
      expect(overflows).toBe(0);
      f.swp.broadcast(oversized);
      expect((await events.next()).done).toBe(true);
      expect(overflows).toBe(1);
    } finally { await peer.detach(); }
  });
});

describe("web listener policy", () => {
  test("LAN listeners allow HTTP and optional TLS without a public origin", () => {
    expect(defaultWebConfig().enabled).toBe(false);
    expect(webBinding(defaultWebConfig())).toEqual({ hostname: "127.0.0.1", port: 7340, secure: false });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "0.0.0.0:7340" })).toEqual({ hostname: "0.0.0.0", port: 7340, secure: false });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "[::]:7340" })).toEqual({ hostname: "::", port: 7340, secure: false });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "shore.test-tailnet.ts.net:7340" })).toEqual({ hostname: "shore.test-tailnet.ts.net", port: 7340, secure: false });
    expect(() => webBinding({ ...defaultWebConfig(), public_origin: "https://shore.example/path" })).toThrow("exact");
    expect(webBinding({ ...defaultWebConfig(), public_origin: "http://shore.example" })).toMatchObject({ secure: false });
    expect(webBinding({ ...defaultWebConfig(), public_origin: "https://shore.example" })).toMatchObject({ secure: true });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "0.0.0.0:7340", public_origin: "https://shore.example", tls_key: "key.pem", tls_cert: "cert.pem" })).toMatchObject({ secure: true });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "0.0.0.0:7340", tls_key: "key.pem", tls_cert: "cert.pem" })).toMatchObject({ secure: true });
    expect(() => webBinding({ ...defaultWebConfig(), tls_cert: "cert.pem" })).toThrow("Set both");
    expect(webBinding({ ...defaultWebConfig(), public_origin: "http://shore.example", tls_key: "key.pem", tls_cert: "cert.pem" })).toMatchObject({ secure: true });
  });

  test("all hostnames and numeric addresses work with an optional proxy scheme", () => {
    for (const host of ["localhost:17340", "127.0.0.1:17340", "192.168.1.10:7340", "[::1]:17340", "[fd00::1]:7340", hostname(), "100.101.102.103:7340", "shore.test-tailnet.ts.net:7340", "lab-box:7340", "alias.example:17340"]) {
      const url = new URL(`http://${host}`);
      expect(webRequestOrigin(url, undefined)).toBe(url.origin);
    }
    expect(webRequestOrigin(new URL("http://shore.example/workspace"), "https://shore.example")).toBe("https://shore.example");
    expect(webRequestOrigin(new URL("http://localhost:7340/workspace"), "https://shore.example")).toBe("http://localhost:7340");
    expect(webRequestOrigin(new URL("https://shore.example/workspace"), "http://shore.example")).toBe("http://shore.example");
  });
});


test("request history authenticates, isolates owners, uses current selection and refuses duplicate mutation IDs across tabs", async () => {
  const f = await fixture(); f.web.activate();
  expect((await f.api("/api/requests/list")).status).toBe(401);
  const owner = await f.login(); const other = await f.login();
  expect((await f.api("/api/requests/list", owner.cookie, {}, { origin: "https://evil.example" })).status).toBe(403);
  const first = connectBrowser(f.web.origin, owner.cookie); await first.attach();
  const session = f.swp.sessionRouter.sessions().at(0)?.[0]; if (session === undefined) throw new Error("Missing session");
  f.swp.sessionRouter.setSelectedCharacter(session, "bo"); f.swp.sessionRouter.setSelectedThread(session, "side");
  const command = { type: "command", rid: "tracked-edit", name: "edit", args: { ref: "1", content: "secret input" } };
  first.send(command); await until(() => f.routed.length === 1);
  const listing = await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList;
  const record = listing.requests[0]; if (record === undefined) throw new Error("Missing request record");
  expect(record).toMatchObject({ rid: "tracked-edit", character: "bo", thread: "side", phase: "running" });
  expect(JSON.stringify(listing)).not.toContain("secret input");
  expect((await (await f.api("/api/requests/list", other.cookie)).json() as WebRequestList).requests).toEqual([]);
  expect((await f.api(`/api/requests/${record.id}/acknowledge`, other.cookie)).status).toBe(404);
  expect((await f.api(`/api/requests/${record.id}/acknowledge`, owner.cookie)).status).toBe(409);
  const second = connectBrowser(f.web.origin, owner.cookie); await second.attach(); second.send(command);
  const duplicate = await second.frame("request_finished", command.rid);
  expect(duplicate).toMatchObject({ outcome: "failed" });
  if (duplicate.type !== "request_finished") throw new Error("Missing duplicate rejection");
  expect(duplicate.error?.message).toContain("already has an outcome");
  expect(f.routed).toHaveLength(1);
  await f.finish(session, { type: "command_output", rid: command.rid, name: "edit", data: { ref: "1", edited: true } });
  await f.finish(session, { type: "request_finished", rid: command.rid, outcome: "completed" });
  await first.frame("request_finished", command.rid);
  expect((await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList).requests[0]).toMatchObject({ phase: "completed", result: { name: "edit", data: { ref: "1", edited: true } } });
  expect((await f.api(`/api/requests/${record.id}/acknowledge`, owner.cookie)).status).toBe(204);
  expect((await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList).requests).toEqual([]);
});

test.each([true, false])("a request outlives its socket, and its outcome reaches the owner's next tab (reconnected first: %p)", async (reconnectedFirst) => {
  const f = await fixture(); f.web.activate(); const owner = await f.login();
  const first = connectBrowser(f.web.origin, owner.cookie); await first.attach();
  const session = f.swp.sessionRouter.sessions().at(0)?.[0]; if (session === undefined) throw new Error("Missing session");
  first.send({ type: "command", rid: "orphaned-edit", name: "edit", args: { ref: "1", content: "new" } });
  await until(() => f.routed.some((message) => message.kind === "command"));
  await first.close(); await until(() => f.swp.sessionRouter.sessions().length === 0);
  const listing = await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList;
  expect(listing.requests[0]).toMatchObject({ phase: "running", rid: "orphaned-edit" });

  const finished = { type: "request_finished", rid: "orphaned-edit", outcome: "completed" } as const;
  const second = connectBrowser(f.web.origin, owner.cookie);
  if (reconnectedFirst) await second.attach();
  f.swp.sessionRouter.reportRequest(session, finished);
  if (!reconnectedFirst) await second.attach();
  expect(await second.frame("request_finished", "orphaned-edit")).toEqual(finished);
  expect((await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList).requests[0]).toMatchObject({ phase: "completed" });
  expect(f.routed.filter((message) => message.kind === "command")).toHaveLength(1);
});

test("failed durable admission never reaches dispatch, and failed completion storage still reports the outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-request-admission-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data"); await mkdir(dataDir);
  const f = await fixture({ recovery: { dataDir, cacheDir: join(root, "cache"), token: TOKEN } }); f.web.activate(); const owner = await f.login();
  const namespace = (await readdir(join(root, "cache", "web")))[0]; if (namespace === undefined) throw new Error("Missing recovery namespace");
  const db = new Database(join(root, "cache", "web", namespace, "recovery.sqlite"));
  try {
    const browser = connectBrowser(f.web.origin, owner.cookie); await browser.attach();
    const session = f.swp.sessionRouter.sessions().at(0)?.[0]; if (session === undefined) throw new Error("Missing peer");
    db.run("CREATE TRIGGER reject_admission BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL, 'secret database path'); END;");
    browser.send({ type: "command", rid: "refused", name: "edit", args: { ref: "1", content: "new" } });
    const refused = await browser.frame("request_finished", "refused");
    expect(refused).toMatchObject({ outcome: "failed" });
    if (refused.type !== "request_finished") throw new Error("Missing admission rejection");
    expect(refused.error?.message).toContain("Nothing was dispatched");
    expect(f.routed).toHaveLength(0);
    db.run("DROP TRIGGER reject_admission");
    browser.send({ type: "command", rid: "admitted", name: "edit", args: { ref: "1", content: "new" } });
    await until(() => f.routed.length === 1);
    db.run("CREATE TRIGGER reject_completion BEFORE UPDATE ON requests BEGIN SELECT RAISE(FAIL, 'secret database path'); END;");
    await f.finish(session, { type: "request_finished", rid: "admitted", outcome: "completed" });
    await browser.frame("request_finished", "admitted");
    expect(JSON.stringify(browser.messages)).not.toContain("secret database path");
    expect((await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList).requests[0]?.phase).toBe("completed");
    expect(db.query<{ info: string }, []>("SELECT info FROM requests").get()?.info).toContain('"phase":"running"');
  } finally { db.run("DROP TRIGGER IF EXISTS reject_admission; DROP TRIGGER IF EXISTS reject_completion;"); db.close(); }
});


test("large snapshots open in the browser and matching full broadcasts refresh them", async () => {
  let serializations = 0;
  const config = { toJSON() { serializations += 1; return {}; } };
  const messages = [{ msg_id: "large-image", role: "user" as const, content: "Photo", content_blocks: [], timestamp: "2026-09-24T00:00:00Z", images: [{ path: "large.png", data: "A".repeat(33 * 1024 * 1024) }] }];
  const f = await fixture({}, {
    hello: async () => ({ characters: [{ name: "ada" }] }),
    history: async () => ({ messages, previousSegment: null, config, selectedCharacter: "ada", selectedThread: "main", revision: 0 }),
  }); f.web.activate();
  const b = browserConnection(f.web.origin);
  try {
    await b.client.signIn(TOKEN); await until(() => b.client.status === "ready");
    f.swp.broadcast({ type: "history", messages, config, selected_character: "ada", selected_thread: "main", revision: 1 });
    await until(() => b.client.selection.snapshotRevision === 1);
    expect(b.client.status).toBe("ready");
    expect(serializations).toBe(2);
  } finally { b.client.stop(); }
});

test("a short stalled stream preserves more than 128 chunks and their terminal event", async () => {
  const f = await fixture(); f.web.activate();
  const { cookie } = await f.login();
  const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
  const entry = f.swp.sessionRouter.sessions()[0]; if (entry === undefined) throw new Error("No session");
  browser.socket.pause();
  try {
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "command_output", name: "status", data: "x".repeat(16 * 1024 * 1024) });
    await Bun.sleep(10);
    for (let i = 0; i < 512; i += 1) await f.swp.sessionRouter.sendToSession(entry[0], { type: "stream_chunk", rid: "stream", text: `${i},`, content_type: "text" });
    await f.swp.sessionRouter.sendToSession(entry[0], { type: "request_finished", rid: "stream", outcome: "completed" });
  } finally { browser.socket.resume(); }
  await browser.frame("request_finished", "stream");
  expect(browser.messages.flatMap(message => message.type === "stream_chunk" ? [message.text] : []).join("")).toBe(Array.from({ length: 512 }, (_, i) => `${i},`).join(""));
  expect(f.swp.sessionRouter.has(entry[0])).toBe(true);
});

test("configured request size is advertised and a single oversized request fails without dispatch", async () => {
  const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_queued_bytes: 1024 } }); f.web.activate();
  const { cookie, info } = await f.login(); expect(info.max_message_bytes).toBe(1024);
  expect((await (await f.api("/api/session", cookie)).json() as WebSessionInfo).max_message_bytes).toBe(1024);
  const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
  browser.send({ type: "command", rid: "oversized", name: "edit", args: { ref: "1", content: "x".repeat(2048) } });
  const error = await browser.frame("error", "oversized");
  if (error.type !== "error") throw new Error("Missing size error");
  expect(error.message).toContain("too large");
  await browser.frame("request_finished", "oversized");
  expect(f.routed).toEqual([]);
  expect((await (await f.api("/api/requests/list", cookie)).json() as WebRequestList).requests).toEqual([]);
});


test("a peer detached before routing creates no uncertain request record", async () => {
  const f = await fixture(); f.web.activate();
  const attach = f.swp.attachLocal.bind(f.swp);
  f.swp.attachLocal = async options => {
    const peer = await attach(options);
    return { ...peer, send: async (message, beforeDispatch) => {
      await peer.detach();
      await peer.send(message, beforeDispatch);
    } };
  };
  const { cookie } = await f.login();
  const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
  browser.send({ type: "command", rid: "never-routed", name: "edit", args: { ref: "1", content: "new" } });
  await browser.closed;
  expect(f.routed).toEqual([]);
  expect((await (await f.api("/api/requests/list", cookie)).json() as WebRequestList).requests).toEqual([]);
});

test("manual tool image bytes cross the socket once while results and recovery retain them", async () => {
  const f = await fixture(); f.web.activate();
  const owner = await f.login();
  const b = browserConnection(f.web.origin, {
    fetch: async (url, options) => fetch(url, { ...options, headers: { origin: f.web.origin, cookie: owner.cookie, "content-type": "application/json" } }),
    socket: (url, subprotocol) => new WebSocket(url, { protocols: [subprotocol], headers: { origin: f.web.origin, cookie: owner.cookie } }),
  });
  const actions = new OperationClient(b.client);
  try {
    b.client.connect(); await until(() => b.client.status === "ready");
    const request = actions.run("run_tool", { tool: "read", input: { file_path: "image.png" } });
    await until(() => f.routed.length === 1);
    const route = f.routed[0]; if (route?.kind !== "command" || route.meta.rid === null) throw new Error("No request");
    const rid = route.meta.rid;
    const image = { path: "image.png", data: "iVBORw0KGgo=", caption: "Original image" };
    const report = { tool: "read", character: "ada", kind: "builtin" as const, enabled: true, input: { file_path: "image.png" }, ok: true, rejected: false, duration_ms: 1, output: "Image", truncated: false, result_chars: 5, raw: null, calls: [], images: [image] };
    const send = (message: ServerMessage) => f.swp.sessionRouter.sendToSession(route.meta.session.sessionId, message);
    await send({ type: "send_image", rid, ...image });
    await f.finish(route.meta.session.sessionId, { type: "command_output", rid, name: "run_tool", data: report });
    await f.finish(route.meta.session.sessionId, { type: "request_finished", rid, outcome: "completed" });
    expect(await request).toEqual(report);
    const output = b.updates.find(update => update.kind === "frame" && update.message.type === "command_output");
    expect(output).toMatchObject({ message: { data: { images: [{ path: image.path, caption: image.caption }] } } });
    expect(JSON.stringify(output)).not.toContain(image.data);
    const recovered = await (await f.api("/api/requests/list", owner.cookie)).json() as WebRequestList;
    expect(recovered.requests[0]?.result?.data).toEqual(report);
  } finally { b.client.stop(); }
});


test("sign-in failures are isolated by peer address and ignore forwarded address claims", async () => {
  const f = await fixture(); f.web.activate();
  for (let i = 0; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) await f.api("/api/login", "", { token: "wrong" });
  expect((await f.api("/api/login", "", { token: "wrong" }, { "x-forwarded-for": "127.0.0.2" })).status).toBe(429);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${f.web.origin}/api/login`, {
      method: "POST", localAddress: "127.0.0.2", headers: { origin: f.web.origin, "content-type": "application/json" },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject); request.end(JSON.stringify({ token: "wrong" }));
  });
  expect(status).toBe(401);
  expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(200);
});
