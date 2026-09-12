import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { BrowserSocket } from "./support/browser.ts";
import type { WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";
import { Server } from "../src/swp/server.ts";
import type { ControlRoutedMessage, RoutedMessage } from "../src/swp/session.ts";
import { WEB_CONTRACT, WEB_SUBPROTOCOL } from "../src/web/contract.ts";
import { WEB_LIMITS, webBinding } from "../src/web/policy.ts";
import { startWebServer, type WebServerOptions } from "../src/web/server.ts";

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
        return { messages: [], activeStart: 0, config: {}, selectedCharacter: selected, selectedThread: thread ?? "main", revision: 0 };
      },
    },
  });
  await swp.bind();
  const served = swp.serve();
  const routed: RoutedMessage[] = [];
  const controls: ControlRoutedMessage[] = [];
  swp.setControlHandler(async (message) => { controls.push(message); });
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
  return { swp, web, routed, controls, api, login, histories: () => histories };
}

function connectBrowser(origin: string, cookie: string, protocol = WEB_SUBPROTOCOL, options?: ConstructorParameters<typeof BrowserSocket>[3]): BrowserSocket {
  const browser = new BrowserSocket(origin, cookie, protocol, options);
  cleanups.push(async () => { await browser.close(); });
  return browser;
}

describe("browser authentication boundary", () => {
  test("HTTPS serves a verified TLS connection and a host-only secure cookie for WSS", async () => {
    const tls_cert = new URL("./fixtures/web-tls/cert.pem", import.meta.url).pathname;
    const tls_key = new URL("./fixtures/web-tls/key.pem", import.meta.url).pathname;
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
    expect(f.histories()).toBe(0);
    expect((await f.api("/api/session")).status).toBe(401);
  });

  test("session storage and repeated failed sign-ins are bounded", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    const first = await f.login(); await f.login();
    expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(429);
    await f.api("/api/logout", first.cookie);
    await f.login();
    for (let i = 5; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) {
      expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(401);
    }
    expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(401);
    expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(429);
    expect(f.histories()).toBe(0);
  });

  test("authentication and compatibility precede any history or peer attachment", async () => {
    const f = await fixture();
    expect((await f.api("/api/login", "", { token: TOKEN })).status).toBe(503);
    f.web.activate();
    expect((await f.api("/api/session")).status).toBe(401);
    expect((await f.api("/api/login", "", { token: "wrong" })).status).toBe(401);
    const denied = connectBrowser(f.web.origin, "");
    expect(denied.opened).rejects.toThrow("rejected");
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

  test("cross-origin, missing-origin, spoofed-host and URL-token requests are refused", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    for (const origin of ["https://evil.example", "null", ""]) {
      expect((await f.api("/api/logout", cookie, {}, { origin })).status).toBe(403);
      expect((await f.api("/api/login", "", { token: TOKEN }, { origin })).status).toBe(403);
    }
    expect((await f.api("/api/session", cookie, {}, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await f.api("/api/session", cookie, {}, { host: "evil.example" })).status).toBe(403);
    expect((await f.api("/api/login?token=secret", "", { token: TOKEN })).status).toBe(403);
    expect((await f.api("/api/session", cookie)).status).toBe(200);
    const forged = connectBrowser(f.web.origin, cookie, WEB_SUBPROTOCOL, { headers: { origin: "https://evil.example" } });
    expect(forged.opened).rejects.toThrow("rejected"); await forged.closed;
    expect(f.histories()).toBe(0);
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

  test("pending byte allowance is released by its correlated result", async () => {
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
    expect(extra.opened).rejects.toThrow("rejected"); await extra.closed;
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
});

describe("web listener policy", () => {
  test("remote listeners require TLS and an explicit HTTPS origin", () => {
    expect(defaultWebConfig().enabled).toBe(false);
    expect(webBinding(defaultWebConfig())).toEqual({ hostname: "127.0.0.1", port: 7340, secure: false });
    expect(() => webBinding({ ...defaultWebConfig(), bind_addr: "0.0.0.0:7340" })).toThrow("requires TLS");
    expect(() => webBinding({ ...defaultWebConfig(), public_origin: "https://shore.example/path" })).toThrow("exact");
    expect(() => webBinding({ ...defaultWebConfig(), public_origin: "http://shore.example" })).toThrow("HTTPS");
    expect(webBinding({ ...defaultWebConfig(), public_origin: "https://shore.example" })).toMatchObject({ secure: true });
    expect(webBinding({ ...defaultWebConfig(), bind_addr: "0.0.0.0:7340", public_origin: "https://shore.example", tls_key: "key.pem", tls_cert: "cert.pem" })).toMatchObject({ secure: true });
  });
});
