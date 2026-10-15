
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { WebLoginCode } from "../src/protocol/WebLoginCode.ts";
import type { WebProblem } from "../src/protocol/WebProblem.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { BrowserSocket } from "./support/browser.ts";
import { browserConnection } from "./support/browser_connection.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";
import { Server } from "../src/swp/server.ts";
import type { ControlRoutedMessage, RoutedMessage } from "../src/swp/session.ts";
import { WEB_CONTRACT, WEB_SUBPROTOCOL } from "../src/web/contract.ts";
import { LoginCodes } from "../src/web/auth.ts";
import { WEB_LIMITS } from "../src/web/policy.ts";
import { startWebServer, type WebServerOptions } from "../src/web/server.ts";
import { outcomeOf } from "./support/outcome.ts";

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

  test("an HTTPS proxy that passes on the Host header needs no configuration, and other ports stay out", async () => {
    const f = await fixture(); f.web.activate();
    for (const origin of ["https://shore.test-tailnet.ts.net:8443", "https://shore.test-tailnet.ts.net"]) {
      const headers = { host: new URL(origin).host, origin };
      const login = await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toStartWith("__Host-shore_web_");
      expect(login.headers.get("set-cookie")).toContain("Secure");
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Missing browser cookie");
      expect((await fetch(`${f.web.origin}/api/session`, { method: "POST", headers: { ...headers, cookie } })).status).toBe(200);
      const browser = connectBrowser(f.web.origin, cookie, WEB_SUBPROTOCOL, { headers });
      await browser.attach();
      await browser.close();
      for (const foreign of ["https://shore.test-tailnet.ts.net:9443", "https://other.test-tailnet.ts.net:8443"]) {
        const refused = await fetch(`${f.web.origin}/api/session`, { method: "POST", headers: { host: headers.host, origin: foreign, cookie } });
        expect(refused.status).toBe(403);
        expect((await refused.json() as WebProblem).message).toContain(`daemon.web.public_origin = "${foreign}"`);
      }
    }
  });

  test("HTTPS proxy configuration allows direct HTTP access with working cookies and logout for each", async () => {
    const origin = "https://shore.example";
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", public_origin: origin } }); f.web.activate();
    const target = `http://127.0.0.1:${String(f.web.port)}`;
    const rewritten = await fetch(`${target}/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get("set-cookie")).toStartWith("__Host-shore_web_");
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
    const bare = await fetch(`${f.web.origin}/api/session`, { method: "POST", headers: { cookie } });
    expect(bare.status).toBe(403);
    expect((await bare.json() as WebProblem).message).toContain("no Origin header");
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

  test("a sign-in nothing renews expires even while its socket remains active", async () => {
    const f = await fixture({ sessionLifetimeMs: 150 }); f.web.activate();
    const { cookie } = await f.login();
    const browser = connectBrowser(f.web.origin, cookie); await browser.attach();
    expect((await browser.closed).code).toBe(4001);
    expect(f.swp.sessionRouter.sessions()).toEqual([]);
    expect((await f.api("/api/session", cookie)).status).toBe(401);
  });
});

describe("staying signed in and signing in other devices", () => {

  test("a signed-in browser's code signs in one other browser, once", async () => {
    const f = await fixture(); f.web.activate();
    expect((await f.api("/api/login-code")).status).toBe(401);
    const { cookie } = await f.login();
    const created = await f.api("/api/login-code", cookie);
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const code = await created.json() as WebLoginCode;
    expect(code.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code.expires_at - Date.now()).toBeGreaterThan(WEB_LIMITS.loginCodeMs - 5000);
    expect(code.expires_at - Date.now()).toBeLessThanOrEqual(WEB_LIMITS.loginCodeMs);
    const phone = await f.api("/api/login", "", { token: code.code });
    expect(phone.status).toBe(200);
    const phoneCookie = phone.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(phoneCookie).not.toBe(cookie);
    expect((await f.api("/api/session", phoneCookie)).status).toBe(200);
    expect((await f.api("/api/session", cookie)).status).toBe(200);
    expect((await f.api("/api/login", "", { token: code.code })).status).toBe(401);
    const next = await (await f.api("/api/login-code", phoneCookie)).json() as WebLoginCode;
    const laptop = browserConnection(f.web.origin);
    const late = browserConnection(f.web.origin);
    try {
      await laptop.client.signIn(next.code, "This link was used"); await until(() => laptop.client.status === "ready");
      expect(await outcomeOf(late.client.signIn(next.code, "This link was used"))).toThrow("This link was used");
      expect(late.client.status).toBe("signed_out");
      expect(late.client.detail).toBe("This link was used");
      expect(await outcomeOf(late.client.signIn("wrong", "This link was used"))).toThrow("This link was used");
    } finally { laptop.client.stop(); late.client.stop(); }
    const fromClient = await laptop.client.loginCode();
    expect((await f.api("/api/login", "", { token: fromClient.code })).status).toBe(200);
  });

  test("sign-in codes expire, and only the newest few stay usable", async () => {
    const f = await fixture({ loginCodeMs: 50 }); f.web.activate();
    const { cookie } = await f.login();
    const stale = await (await f.api("/api/login-code", cookie)).json() as WebLoginCode;
    await Bun.sleep(80);
    expect((await f.api("/api/login", "", { token: stale.code })).status).toBe(401);
    const codes = new LoginCodes(60_000, 2);
    const [first, second, third] = [codes.create(), codes.create(), codes.create()];
    expect(codes.redeem(first.code)).toBe(false);
    expect(codes.redeem(third.code)).toBe(true);
    expect(codes.redeem(second.code)).toBe(true);
    expect(codes.redeem(second.code)).toBe(false);
  });
});
