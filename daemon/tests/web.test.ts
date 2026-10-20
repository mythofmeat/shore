import { until } from "./support/until.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { type WebLoginCode } from "../src/protocol/WebLoginCode.ts";
import { type WebProblem } from "../src/protocol/WebProblem.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { BrowserSocket } from "./support/browser.ts";
import { browserConnection } from "./support/browser_connection.ts";
import { type ServerMessage } from "../src/protocol/ServerMessage.ts";
import { type WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";
import { type HandshakeProvider } from "../src/swp/connection.ts";
import { Server } from "../src/swp/server.ts";
import { type ControlRoutedMessage, type RoutedMessage } from "../src/swp/session.ts";
import { WEB_CONTRACT, WEB_SUBPROTOCOL } from "../src/web/contract.ts";
import { LoginCodes, WebSessions, type WebSession } from "../src/web/auth.ts";
import { WEB_LIMITS } from "../src/web/policy.ts";
import { startWebServer, type WebServerOptions } from "../src/web/server.ts";
import { outcomeOf } from "./support/outcome.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { WebRecovery, sessionDigest, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { ArchiveTransfers, type ArchiveTransferLimits } from "../src/web/archives.ts";
import { type WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";
import { parseOperationInput } from "../src/operations/contracts.ts";
import { validWebArchiveInfo, validWebArchiveList } from "../src/web/contracts.ts";
import { findSentPicture, sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOKEN = "web-transport-test-token";

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
      await laptop.client.signIn(next.code, "This link was used"); await until(() => laptop.client.status === "ready", "the transport to settle");
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

const origin = "http://127.0.0.1:7430";

async function recoveryOptions(): Promise<WebRecoveryOptions> {
  const root = await mkdtemp(join(tmpdir(), "shore-web-recovery-"));
  const dataDir = join(root, "data"); await mkdir(dataDir);
  return { dataDir, cacheDir: join(root, "cache"), token: "private-recovery-daemon-token" };
}

function open(config: WebRecoveryOptions, url = origin, capacity = 4, lifetime = 60_000) {
  const recovery = new WebRecovery(config, url);
  const sessions = new WebSessions(url, capacity, lifetime, recovery);
  const server = new Server({ addr: "127.0.0.1:0", serverName: "recovery", authenticate: () => true });
  const transfers = new ArchiveTransfers(server, () => true, {}, recovery);
  transfers.restore(sessions);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await transfers.close(); sessions.close(); recovery.close(); };
  cleanups.push(close);
  return { recovery, sessions, transfers, server, close };
}

function signIn(sessions: WebSessions) {
  const session = sessions.create();
  if (session === undefined) throw new Error("Missing test sign-in");
  const cookie = sessions.cookie(session);
  return { session, cookie, request: new Request(origin, { headers: { cookie } }) };
}

function saved(phase: WebArchiveInfo["phase"], expiresAt = Date.now() + 60_000): WebArchiveInfo {
  return { id: crypto.randomUUID(), filename: "test.tar.gz", bytes: 12, expires_at: expiresAt, phase, downloadable: false };
}

test("restart preserves session ownership and original expiry using hashes, never persisted bearer credentials", async () => {
  const config = await recoveryOptions(); const a = open(config);
  const first = signIn(a.sessions); const second = signIn(a.sessions);
  const info = saved("imported"); a.recovery.saveArchive(first.session.id, info);
  const path = join(dirname(a.recovery.artifacts), "recovery.sqlite");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  const cookieToken = first.cookie.split(";")[0]?.split("=")[1];
  if (cookieToken === undefined) throw new Error("Missing token");
  expect(first.session.id).toBe(sessionDigest(cookieToken));
  const bytes = await readFile(path);
  expect(bytes.includes(cookieToken)).toBe(false); expect(bytes.includes(config.token)).toBe(false);
  await a.close();
  const b = open(config); const recovered = b.sessions.read(first.request); const other = b.sessions.read(second.request);
  expect(recovered?.expiresAt).toBe(first.session.expiresAt);
  if (recovered === undefined || other === undefined) throw new Error("Sign-ins did not recover");
  expect(b.transfers.get(recovered, info.id)).toEqual(info);
  expect(b.transfers.list(other).archives).toEqual([]);
  expect(() => b.transfers.import(other, info.id)).toThrow("missing or expired");
  const forged = new Request(origin, { headers: { cookie: first.cookie.replace(cookieToken, first.session.id) } });
  expect(b.sessions.read(forged)).toBeUndefined();
  b.sessions.revoke(recovered);
  await b.close();
  const c = open(config);
  expect(c.sessions.read(first.request)).toBeUndefined();
  expect(c.sessions.read(second.request)).toBeDefined();
  expect(c.recovery.archives()).toEqual([]);
});

test.each(["token", "origin"])("changing the %s invalidates old credentials and transfers before serving", async (changed) => {
  const config = await recoveryOptions(); const a = open(config); const signed = signIn(a.sessions);
  a.recovery.saveArchive(signed.session.id, saved("uncertain"));
  const artifacts = a.recovery.artifacts;
  await a.close(); await writeFile(join(artifacts, "crash-orphan"), "private bytes");
  const b = open(changed === "token" ? { ...config, token: "rotated-token" } : config, changed === "origin" ? "https://shore.example" : origin);
  expect(b.sessions.read(signed.request)).toBeUndefined(); expect(b.recovery.archives()).toEqual([]);
  expect(await readdir(artifacts)).toEqual([]);
  await b.close();
  const c = open(config);
  expect(c.sessions.read(signed.request)).toBeUndefined();
});

type CommandRoute = Extract<RoutedMessage, { kind: "command" }>;

function owner() {
  const controller = new AbortController();
  const session: WebSession = { id: crypto.randomUUID(), expiresAt: Date.now() + 60_000, signal: controller.signal };
  return { session, controller };
}

function exportOutput(route: CommandRoute): string {
  const { output } = parseOperationInput("export_character", route.cmd.args);
  if (output === undefined) throw new Error("Browser exports name their archive file");
  return output;
}

function upload(body: NonNullable<RequestInit["body"]> = "archive bytes", headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/archives", { method: "POST", body, headers: { "content-type": "application/octet-stream", "x-shore-filename": "ada.tar.gz", ...headers }, ...(signal === undefined ? {} : { signal }) });
}

async function archiveFixture(limits: Partial<ArchiveTransferLimits> = {}, singleCharacter = false) {
  const server = new Server({ addr: "127.0.0.1:0", serverName: "archive-test", authenticate: () => true,
    handshake: { hello: async () => ({ characters: singleCharacter ? [{ name: "ada" }] : [] }), history: async (selectedCharacter) => ({ messages: [], previousSegment: null, config: {}, selectedCharacter, selectedThread: null, revision: 0 }) },
  });
  const commands: CommandRoute[] = [];
  await server.bind();
  const served = server.serve();
  let count = 0;
  const routing = (async () => { for await (const route of server.routes()) if (route.kind === "command") { commands.push(route); count += 1; } })();
  const transfers = new ArchiveTransfers(server, () => true, limits);
  cleanups.push(async () => { await transfers.close(); server.stop(); await Promise.all([served, routing]); });
  const next = async () => { await until(() => commands.length > 0, "the archive transfer to settle"); const command = commands.shift(); if (command === undefined) throw new Error("Missing archive command"); return command; };
  const finish = async (route: CommandRoute, scenario = "completed", contents: Uint8Array = new TextEncoder().encode("download archive")) => {
    const name = route.cmd.name;
    let data: unknown;
    if (name === "export_character") {
      const output = exportOutput(route);
      await writeFile(output, contents);
      data = { character: parseOperationInput(name, route.cmd.args).character, archive: output, bytes: contents.length, live: true, call_diagnostics: "included", external_memory: "rebuild_from_archived_segments" };
    } else if (name === "import_character") {
      const args = parseOperationInput(name, route.cmd.args);
      data = { character: "ada", archive: args.archive, imported: true, external_memory: "queued_for_rebuild_when_retain_is_enabled" };
    } else throw new Error(`Unexpected command ${name}`);
    const rid = route.meta.rid;
    if (rid === null) throw new Error("Missing archive request ID");
    const send = (message: Parameters<typeof server.sessionRouter.sendToSession>[1]) => server.sessionRouter.sendToSession(route.meta.session.sessionId, message);
    await send({ type: "command_output", rid: "unrelated", name, data: {} });
    if (scenario !== "missing") await send({ type: "command_output", rid, name: scenario === "wrong-name" ? "status" : name, data: scenario === "invalid" ? {} : data });
    if (scenario === "duplicate") await send({ type: "command_output", rid, name, data });
    await send({ type: "request_finished", rid, outcome: scenario === "failed" ? "failed" : scenario === "cancelled" ? "cancelled" : "completed", ...(scenario === "failed" ? { error: { code: "invalid_request" as const, message: "Refusing to overwrite existing character" } } : {}) });
  };
  return { server, transfers, next, finish, count: () => count };
}

test("download refuses substituted links and changed files and releases its download claim", async () => {
  const f = await archiveFixture(); const a = owner();
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); await f.finish(route);
  await until(() => f.transfers.get(a.session, info.id).downloadable, "the archive transfer to settle");
  const path = exportOutput(route);
  const target = join(dirname(path), "private.txt"); await writeFile(target, "private contents");
  await rm(path); await symlink(target, path);
  expect(await outcomeOf(f.transfers.download(a.session, info.id, upload()))).toThrow();
  await rm(path); await writeFile(path, "changed");
  expect(await outcomeOf(f.transfers.download(a.session, info.id, upload()))).toThrow("Archive changed");
  await writeFile(path, "download archive"); await chmod(path, 0o600);
  expect(await (await f.transfers.download(a.session, info.id, upload())).text()).toBe("download archive");
});

test("uploads enforce declared and streamed byte limits, valid filenames, content type and nonempty complete bodies", async () => {
  const f = await archiveFixture({ uploadBytes: 16 }); const a = owner();
  for (const request of [upload("", {}), upload("short", { "content-length": "10" }), upload("x", { "content-type": "text/plain" }), upload("x", { "x-shore-filename": "%ZZ" }), upload("x", { "x-shore-filename": "%00bad" })]) {
    expect(await outcomeOf(f.transfers.upload(a.session, request))).toThrow();
  }
  expect(await outcomeOf(f.transfers.upload(a.session, upload("x", { "content-length": "17" })))).toThrow("size limit");
  expect(await outcomeOf(f.transfers.upload(a.session, upload(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(7)); controller.close(); } }))))).toThrow("size limit");
  await until(() => f.transfers.list(a.session).archives.length === 0, "the archive transfer to settle");
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
});

test("HTTP archive endpoints authenticate and enforce origin before attaching a bounded worker alongside a browser", async () => {
  const f = await archiveFixture();
  const web = startWebServer({ server: f.server, authenticate: (token) => token === "archive-token", config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 }, archiveLimits: { uploadBytes: 8192 } });
  cleanups.push(() => web.stop()); web.activate();
  const post = (path: string, cookie = "", body: NonNullable<RequestInit["body"]> = "{}", headers: Record<string, string> = {}) => fetch(`${web.origin}/api${path}`, { method: "POST", body, headers: { cookie, origin: web.origin, "content-type": "application/json", ...headers } });
  const login = async () => {
    const response = await post("/login", "", JSON.stringify({ token: "archive-token" }));
    expect(response.status).toBe(200); const cookie = response.headers.get("set-cookie")?.split(";").at(0);
    if (cookie === undefined) throw new Error("Missing archive session cookie"); return cookie;
  };
  for (const path of ["/archives", "/archives/export", "/archives/list", `/archives/${crypto.randomUUID()}/download`]) expect((await post(path)).status).toBe(401);
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
  const cookie = await login(); const other = await login();
  expect((await post("/archives/export", cookie, '{"character":"ada"}', { origin: "https://outside.example" })).status).toBe(403);
  expect((await post("/archives/export", cookie, '{"character":"ada","output":"/private/file"}')).status).toBe(400);
  const response = await post("/archives", cookie, "local archive bytes", { "content-type": "application/octet-stream", "x-shore-filename": "picked.tar.gz" });
  expect(response.status).toBe(200); const info: unknown = await response.json();
  if (!validWebArchiveInfo(info)) throw new Error("Invalid archive info");
  for (const action of ["status", "import", "download", "remove"]) expect((await post(`/archives/${info.id}/${action}`, other)).status).toBe(404);
  const listing: unknown = await (await post("/archives/list", cookie)).json();
  expect(validWebArchiveList(listing)).toBe(true);
  expect((await post("/archives", cookie, "x".repeat(8193), { "content-type": "application/octet-stream" })).status).toBe(413);
  const browser = new BrowserSocket(web.origin, cookie, WEB_SUBPROTOCOL);
  cleanups.push(() => browser.close()); await browser.attach();
  expect((await post(`/archives/${info.id}/import`, cookie)).status).toBe(202);
  const route = await f.next();
  expect(f.server.sessionRouter.sessions()).toHaveLength(2);
  expect((await post("/archives/export", cookie, '{"character":"ada"}')).status).toBe(429);
  expect((await post(`/archives/${info.id}/remove`, cookie)).status).toBe(409);
  await f.finish(route);
  await until(() => f.server.sessionRouter.sessions().length === 1, "the archive transfer to settle");
  expect((await (await post(`/archives/${info.id}/status`, cookie)).json() as { phase: string }).phase).toBe("imported");
  expect((await post(`/archives/${info.id}/import`, cookie)).status).toBe(200);
  expect(f.count()).toBe(1);
  expect((await post("/logout", cookie)).status).toBe(204);
  expect((await post(`/archives/${info.id}/status`, cookie)).status).toBe(401);
});

async function workspace(): Promise<{ root: string; dir: string; data: string }> {
  const root = await mkdtemp(testTmp("shore-picture-delivery-"));
  const dir = join(root, "workspace");
  await mkdir(join(dir, "art"), { recursive: true });
  await writeFile(join(dir, "art", "2026-01-01-lighthouse.png"), await sizedImage(64, 48));
  return { root, dir, data: join(root, "data") };
}

test("signed-in pages can load a sent picture without an Origin header, and nobody else can", async () => {
  const { data, dir } = await workspace();
  const bytes = await readFile(join(dir, "art", "2026-01-01-lighthouse.png"));
  const kept = join(sentPicturesDir(data, "qifei"), `${"a".repeat(64)}.png`);
  await mkdir(sentPicturesDir(data, "qifei"), { recursive: true });
  await writeFile(kept, bytes);
  const swp = new Server({
    addr: "127.0.0.1:0", serverName: "picture-test", authenticate: (token) => tokenMatches("token", token),
    handshake: { hello: async () => ({ characters: [] }), history: async () => ({ messages: [], previousSegment: null, config: {}, selectedCharacter: null, selectedThread: "main", revision: 0 }) },
  });
  await swp.bind();
  const served = swp.serve();
  const web = startWebServer({
    server: swp, authenticate: (token) => tokenMatches("token", token),
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" },
    picture: (file) => findSentPicture(data, file),
  });
  web.activate();
  cleanups.push(async () => { await web.stop(); swp.stop(); await served; });
  const login = await fetch(`${web.origin}/api/login`, { method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ token: "token" }) });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const picture = (file: string, headers?: Record<string, string>) => fetch(`${web.origin}/api/pictures/${file}`, { headers: headers ?? { cookie } });

  const shown = await picture(basename(kept));
  expect(shown.status).toBe(200);
  expect(shown.headers.get("content-type")).toBe("image/png");
  expect(shown.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(Buffer.from(await shown.arrayBuffer())).toEqual(bytes);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await picture(basename(kept), {})).status).toBe(401);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await picture(`${"b".repeat(64)}.png`)).status).toBe(404);
  expect((await picture("..%2F..%2Fshore.db")).status).toBe(404);
});
