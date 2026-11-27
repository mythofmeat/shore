import { until, untilAsync } from "./support/until.ts";
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { type WebLoginCode } from "../src/protocol/WebLoginCode.ts";
import { type WebProblem } from "../src/protocol/WebProblem.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { DEVICES_FILE } from "../src/web/devices.ts";
import { BrowserSocket } from "./support/browser.ts";
import { browserConnection } from "./support/browser_connection.ts";
import { type ServerMessage } from "../src/protocol/ServerMessage.ts";
import { type WebSessionInfo } from "../src/protocol/WebSessionInfo.ts";
import { type HandshakeProvider } from "../src/swp/handshake.ts";
import { Server } from "../src/swp/server.ts";
import { isControlRoutedMessage, type ControlRoutedMessage, type RoutedMessage } from "../src/swp/session.ts";
import { WEB_CONTRACT, WEB_SUBPROTOCOL } from "../src/web/contract.ts";
import { LoginCodes, LoginFailures, WebSessions, type WebSession } from "../src/web/auth.ts";
import { checked, WEB_LIMITS } from "../src/web/policy.ts";
import { RequestHistory } from "../src/web/requests.ts";
import { validWebLoginCode } from "../src/web/contracts.ts";
import { startWebServer, statusProblem, type WebServerOptions } from "../src/web/server.ts";
import { outcomeOf } from "./support/outcome.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { WebRecovery, sessionDigest, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { ArchiveTransferError, ArchiveTransfers, type ArchiveTransferLimits } from "../src/web/archives.ts";
import { ArchiveSpool } from "../src/commands/archive_spool.ts";
import { type WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";
import { parseOperationInput } from "../src/operations/contracts.ts";
import { validWebArchiveInfo, validWebArchiveList } from "../src/web/contracts.ts";
import { findSentPicture, sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";
import { required } from "../src/util/required.ts";
import { handlesUnder } from "./support/handles.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOKEN = "web-transport-test-token";

function signedInData(dataDir?: string): string {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "shore-web-data-"));
  writeFileSync(join(dir, DEVICES_FILE), JSON.stringify({ version: 1, devices: [{ id: "test-cli", kind: "cli", name: "Test CLI", created_at: 0, digest: sessionDigest(TOKEN) }] }));
  return dir;
}

async function fixture(options: Partial<Omit<WebServerOptions, "server">> = {}, provider?: HandshakeProvider) {
  let histories = 0;
  const swp = new Server({
    handshake: provider ?? {
      hello: async () => ({ characters: [{ name: "ada" }, { name: "bo" }] }),
      select: (character) => Promise.resolve({ character, thread: null }),
      history: async (selected, thread) => {
        histories += 1;
        return { messages: [], previousSegment: null, config: {}, selectedCharacter: selected, selectedThread: thread ?? "main", revision: 0 };
      },
    },
  });
  const routed: RoutedMessage[] = [];
  const controls: ControlRoutedMessage[] = [];
  const routing = (async () => {
    for await (const message of swp.routes()) {
      if (!isControlRoutedMessage(message)) routed.push(message);
      else if (message.kind !== "session_connected") controls.push(message);
    }
  })();
  const web = startWebServer({
    server: swp,
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" }, ...options,
    dataDir: signedInData(options.dataDir),
  });
  cleanups.push(async () => { await web.stop(); swp.stop(); await routing; });
  const api = (path: string, cookie = "", body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${web.origin}${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { origin: web.origin, "content-type": "application/json", cookie, ...headers },
      ...(options.config?.tls_cert === undefined ? {} : { tls: { ca: readFileSync(options.config.tls_cert) } }),
    });
  const code = async (): Promise<string> => {
    const created = await fetch(`${web.address}/api/login-code`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
      ...(options.config?.tls_cert === undefined ? {} : { tls: { ca: readFileSync(options.config.tls_cert) } }),
    });
    expect(created.status).toBe(200);
    return (await created.json() as WebLoginCode).code;
  };
  const login = async () => {
    const response = await api("/api/login", "", { code: await code() });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("No session cookie");
    return { cookie, response, info: await response.json() as WebSessionInfo };
  };
  const finish = async (session: number, message: ServerMessage) => {
    swp.sessionRouter.reportRequest(session, message);
    await swp.sessionRouter.sendToSession(session, message);
  };
  return { swp, web, routed, controls, api, code, login, finish, histories: () => histories };
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
      expect((await fetch(`${target}/api/login`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify({ code: "wrong" }) })).status).toBe(401);
      const login = await fetch(`${target}/api/login`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify({ code: await f.code() }) });
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
      const login = await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code: await f.code() }) });
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
    const picture = join(await mkdtemp(join(tmpdir(), "shore-picture-")), "p.png");
    await writeFile(picture, "png bytes");
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", public_origin: origin }, picture: (file) => file === "p.png" ? picture : undefined }); f.web.activate();
    const target = `http://127.0.0.1:${String(f.web.port)}`;
    const rewritten = await fetch(`${target}/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: await f.code() }) });
    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get("set-cookie")).toStartWith("__Host-shore_web_");
    for (const accessOrigin of [origin, target, "http://shore.test-tailnet.ts.net:17340"]) {
      const headers = { host: new URL(accessOrigin).host, origin: accessOrigin };
      const secure = accessOrigin.startsWith("https:");
      expect((await fetch(`${target}/workspace`, { headers })).status).toBe(200);
      expect((await fetch(`${target}/api/session`, { method: "POST", headers })).status).toBe(401);
      const login = await fetch(`${target}/api/login`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code: await f.code() }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")?.includes("Secure")).toBe(secure);
      expect(login.headers.get("set-cookie")?.startsWith("__Host-")).toBe(secure);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Missing browser cookie");
      expect((await fetch(`${target}/api/session`, { method: "POST", headers: { ...headers, cookie } })).status).toBe(200);
      expect((await fetch(`${target}/api/pictures/p.png`, { headers: { ...headers, cookie } })).status, "pictures read either cookie").toBe(200);
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
    for (const body of [{}, { code: 1 }, { password: 1 }, { token: TOKEN }, { code: TOKEN, extra: true }, { code: TOKEN, password: TOKEN }, [TOKEN]]) {
      const refused = await f.api("/api/login", "", body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code: "invalid_request", message: "Give the password, or a sign-in code" });
    }
    expect((await f.api("/api/login", "", { code: TOKEN }, { "content-type": "text/plain" })).status).toBe(400);
    const malformed = await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { origin: f.web.origin, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await f.api("/api/login", "", { code: "x".repeat(WEB_LIMITS.loginBytes) })).status).toBe(413);
    const chunked = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(WEB_LIMITS.loginBytes + 1)); controller.close(); } });
    expect((await fetch(`${f.web.origin}/api/login`, { method: "POST", headers: { origin: f.web.origin, "content-type": "application/json" }, body: chunked })).status).toBe(413);
    expect(f.histories()).toBe(0);
    expect((await f.api("/api/session")).status).toBe(401);
  });

  test("session storage and repeated failed sign-ins are bounded", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    const first = await f.login(); await f.login();
    expect((await f.api("/api/login", "", { code: await f.code() })).status).toBe(200);
    expect((await f.api("/api/session", first.cookie)).status).toBe(401);
    for (let i = 0; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) {
      const wrong = await f.api("/api/login", "", { code: "wrong" });
      expect(wrong.status).toBe(401);
      expect((await wrong.json() as WebProblem).message).toBe("That sign-in code has expired or was already used");
    }
    const held = await f.api("/api/login", "", { code: "wrong" });
    expect([held.status, (await held.json() as WebProblem).message]).toEqual([429, "Too many sign-in attempts; try again in a minute"]);
    expect((await f.api("/api/login", "", { code: await f.code() })).status).toBe(200);
    expect(f.histories()).toBe(0);
  });

  test("authentication and compatibility precede any history or peer attachment", async () => {
    const f = await fixture();
    expect((await f.api("/api/login", "", { code: TOKEN })).status).toBe(503);
    f.web.activate();
    expect((await f.api("/api/session")).status).toBe(401);
    expect((await f.api("/api/login", "", { code: "wrong" })).status).toBe(401);
    expect((await f.api("/api/login", "", { code: TOKEN })).status, "a CLI's credential is no sign-in code").toBe(401);
    const denied = connectBrowser(f.web.origin, "");
    expect(await outcomeOf(denied.opened)).toThrow("rejected");
    await denied.closed;
    expect(denied.messages).toEqual([]);
    const { cookie, response, info } = await f.login();
    expect(info).toMatchObject({ contract: WEB_CONTRACT, protocol: 4, max_pending_requests: 32 });
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
      expect((await f.api("/api/login", "", { code: TOKEN }, { origin })).status).toBe(403);
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
    const phone = await f.api("/api/login", "", { code: code.code });
    expect(phone.status).toBe(200);
    const phoneCookie = phone.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(phoneCookie).not.toBe(cookie);
    expect((await f.api("/api/session", phoneCookie)).status).toBe(200);
    expect((await f.api("/api/session", cookie)).status).toBe(200);
    expect((await f.api("/api/login", "", { code: code.code })).status).toBe(401);
    const next = await (await f.api("/api/login-code", phoneCookie)).json() as WebLoginCode;
    const laptop = browserConnection(f.web.origin);
    const late = browserConnection(f.web.origin);
    try {
      await laptop.client.signIn({ code: next.code }, "This link was used"); await until(() => laptop.client.status === "ready", "the transport to settle");
      expect(await outcomeOf(late.client.signIn({ code: next.code }, "This link was used"))).toThrow("This link was used");
      expect(late.client.status).toBe("signed_out");
      expect(late.client.detail).toBe("This link was used");
      expect(await outcomeOf(late.client.signIn({ code: "wrong" }, "This link was used"))).toThrow("This link was used");
    } finally { laptop.client.stop(); late.client.stop(); }
    const fromClient = await laptop.client.loginCode();
    expect((await f.api("/api/login", "", { code: fromClient.code })).status).toBe(200);
  });

  test("sign-in codes expire, and only the newest few stay usable", async () => {
    const f = await fixture({ loginCodeMs: 50 }); f.web.activate();
    const { cookie } = await f.login();
    const stale = await (await f.api("/api/login-code", cookie)).json() as WebLoginCode;
    await Bun.sleep(80);
    expect((await f.api("/api/login", "", { code: stale.code })).status).toBe(401);
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
  return { dataDir, cacheDir: join(root, "cache") };
}

function open(config: WebRecoveryOptions, url = origin, capacity = 4, lifetime = 60_000) {
  const recovery = new WebRecovery(config, url);
  const sessions = new WebSessions(url, capacity, lifetime, recovery);
  const server = new Server();
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
  expect(bytes.includes(cookieToken)).toBe(false);
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

test("changing the origin invalidates old credentials and transfers before serving", async () => {
  const config = await recoveryOptions(); const a = open(config); const signed = signIn(a.sessions);
  a.recovery.saveArchive(signed.session.id, saved("uncertain"));
  const artifacts = a.recovery.artifacts;
  await a.close(); await writeFile(join(artifacts, "crash-orphan"), "private bytes");
  const b = open(config, "https://shore.example");
  expect(b.sessions.read(signed.request)).toBeUndefined(); expect(b.recovery.archives()).toEqual([]);
  expect(await readdir(artifacts)).toEqual([]);
  await b.close();
  const c = open(config);
  expect(c.sessions.read(signed.request)).toBeUndefined();
});

type CommandRoute = Extract<RoutedMessage, { kind: "command" }>;

function owner() {
  const controller = new AbortController();
  const session: WebSession = { id: crypto.randomUUID(), name: "Browser", createdAt: Date.now(), lastUsedAt: Date.now(), expiresAt: Date.now() + 60_000, signal: controller.signal };
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
  const server = new Server({
    handshake: { hello: async () => ({ characters: singleCharacter ? [{ name: "ada" }] : [] }), history: async (selectedCharacter) => ({ messages: [], previousSegment: null, config: {}, selectedCharacter, selectedThread: null, revision: 0 }), select: async (character) => ({ character, thread: null }) },
  });
  const commands: CommandRoute[] = [];
  let count = 0;
  const routing = (async () => { for await (const route of server.routes()) if (route.kind === "command") { commands.push(route); count += 1; } })();
  const transfers = new ArchiveTransfers(server, () => true, limits);
  cleanups.push(async () => { await transfers.close(); server.stop(); await routing; });
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

test("a transfer is gone for its owner the moment their sign-in ends", async () => {
  const f = await archiveFixture(); const a = owner();
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); await f.finish(route);
  await until(() => f.transfers.get(a.session, info.id).downloadable, "the archive transfer to settle");
  const missing = (session: WebSession): unknown => {
    try {
      return f.transfers.get(session, info.id);
    } catch (e) {
      return e instanceof ArchiveTransferError ? [e.status, e.message] : e;
    }
  };
  expect(missing(owner().session)).toEqual([404, "Archive transfer is missing or expired"]);
  a.controller.abort();
  expect(missing(a.session)).toEqual([404, "Archive transfer is missing or expired"]);
  expect(f.transfers.list(a.session).archives).toEqual([]);
});

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
  const web = startWebServer({ server: f.server, dataDir: signedInData(), config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 }, archiveLimits: { uploadBytes: 8192 } });
  cleanups.push(() => web.stop()); web.activate();
  const post = (path: string, cookie = "", body: NonNullable<RequestInit["body"]> = "{}", headers: Record<string, string> = {}) => fetch(`${web.origin}/api${path}`, { method: "POST", body, headers: { cookie, origin: web.origin, "content-type": "application/json", ...headers } });
  const login = async () => {
    const { code } = await (await fetch(`${web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
    const response = await post("/login", "", JSON.stringify({ code }));
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

test("a refusal's code follows its status: signed out, not found and too many have their own, and anything else is an invalid request", async () => {
  const answers = await Promise.all([401, 404, 429, 409, 413].map(async (status) => { const answer = statusProblem(status, "why"); return [answer.status, await answer.json()]; }));
  expect(answers).toEqual([
    [401, { code: "unauthorized", message: "why" }], [404, { code: "not_found", message: "why" }], [429, { code: "too_many_requests", message: "why" }],
    [409, { code: "invalid_request", message: "why" }], [413, { code: "invalid_request", message: "why" }],
  ]);
});

test("an archive goes the whole way over HTTP: exported, downloaded, removed, with exact refusals for what it can't do", async () => {
  const f = await archiveFixture();
  const web = startWebServer({ server: f.server, dataDir: signedInData(), config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" }, archiveLimits: { uploadBytes: 8192 } });
  cleanups.push(() => web.stop()); web.activate();
  const post = (path: string, cookie: string, body: NonNullable<RequestInit["body"]> = "{}", headers: Record<string, string> = {}) => fetch(`${web.origin}/api${path}`, { method: "POST", body, headers: { cookie, origin: web.origin, "content-type": "application/json", ...headers } });
  const { code } = await (await fetch(`${web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
  const cookie = (await post("/login", "", JSON.stringify({ code }))).headers.get("set-cookie")?.split(";")[0] ?? "";
  const exporting = await post("/archives/export", cookie, '{"character":"ada"}');
  const info = await exporting.json() as { id: string; phase: string };
  expect([exporting.status, info.phase]).toEqual([202, "exporting"]);
  await f.finish(await f.next());
  await untilAsync(async () => ((await (await post(`/archives/${info.id}/status`, cookie)).json()) as { phase: string }).phase === "ready", "the export to be ready");
  const downloaded = await post(`/archives/${info.id}/download`, cookie);
  expect([downloaded.status, await downloaded.text()]).toEqual([200, "download archive"]);
  const uploaded = await (await post("/archives", cookie, "local archive bytes", { "content-type": "application/octet-stream", "x-shore-filename": "picked.tar.gz" })).json() as { id: string };
  const removed = await post(`/archives/${uploaded.id}/remove`, cookie);
  expect([removed.status, await removed.text()]).toEqual([204, ""]);
  const refusals: [Response, number, string, string][] = [
    [await post(`/archives/${uploaded.id}/status`, cookie), 404, "not_found", "Archive transfer is missing or expired"],
    [await post(`/archives/${uploaded.id}/sideways`, cookie), 404, "not_found", "Unknown archive transfer endpoint"],
    [await post("/archives", cookie, "x".repeat(8193), { "content-type": "application/octet-stream" }), 413, "invalid_request", "Archive exceeds the upload size limit"],
    [await post("/archives/export", cookie, JSON.stringify({ character: "x".repeat(5000) })), 413, "invalid_request", "Request body is too large"],
  ];
  for (const [answer, status, problemCode, message] of refusals) expect([answer.status, await answer.json()]).toEqual([status, { code: problemCode, message }]);
  const broken = spyOn(ArchiveTransfers.prototype, "list").mockImplementation(() => { throw new Error("the records are gone"); });
  try {
    const failed = await post("/archives/list", cookie);
    expect([failed.status, await failed.json()]).toEqual([400, { code: "invalid_request", message: "Archive transfer could not be completed" }]);
  } finally { broken.mockRestore(); }
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

function recoveringServer(recovery: WebRecoveryOptions, port: number, sessionLifetimeMs = 60_000, drainTimeoutMs?: number) {
  const swp = new Server({ handshake: { hello: async () => ({ characters: [{ name: "ada" }] }), history: async (selectedCharacter) => ({ messages: [], previousSegment: null, config: {}, selectedCharacter, selectedThread: "main", revision: 0 }), select: async (character) => ({ character, thread: null }) } });
  const web = startWebServer({ server: swp, dataDir: signedInData(), config: { ...defaultWebConfig(), enabled: true, bind_addr: `127.0.0.1:${String(port)}` }, recovery, sessionLifetimeMs, ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }) });
  web.activate();
  return { swp, web, post: (path: string, cookie: string, body: NonNullable<RequestInit["body"]> = "{}", headers: Record<string, string> = {}) => fetch(`${web.origin}/api${path}`, { method: "POST", body, headers: { cookie, origin: web.origin, "content-type": "application/json", ...headers } }) };
}

test("a daemon that restarts keeps its browsers signed in and remembers their archive transfers", async () => {
  const recovery = await recoveryOptions();
  const port = await freePort();
  const first = recoveringServer(recovery, port);
  const { code } = await (await fetch(`${first.web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
  const cookie = (await first.post("/login", "", JSON.stringify({ code }))).headers.get("set-cookie")?.split(";")[0] ?? "";
  const uploaded = await (await first.post("/archives", cookie, "local archive bytes", { "content-type": "application/octet-stream", "x-shore-filename": "picked.tar.gz" })).json() as { id: string };
  await first.web.stop(); first.swp.stop();
  const second = recoveringServer(recovery, port);
  cleanups.push(async () => { await second.web.stop(); second.swp.stop(); });
  expect((await second.post("/session", cookie)).status).toBe(200);
  const listed = await (await second.post("/archives/list", cookie)).json() as { archives: { id: string; phase: string }[] };
  expect(listed.archives.map((archive) => [archive.id, archive.phase])).toEqual([[uploaded.id, "failed"]]);
});

test("a listener that fails to start lets go of its port, its stored sign-ins and its recovery store, and says why", async () => {
  const recovery = await recoveryOptions();
  const port = await freePort();
  const first = recoveringServer(recovery, port, 300);
  const { code } = await (await fetch(`${first.web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
  expect((await first.post("/login", "", JSON.stringify({ code }))).status).toBe(200);
  await first.web.stop(); first.swp.stop();
  const restoring = spyOn(ArchiveTransfers.prototype, "restore").mockImplementation(() => { throw new Error("the archive records are unreadable"); });
  try {
    expect(() => recoveringServer(recovery, port, 300)).toThrow("the archive records are unreadable");
  } finally { restoring.mockRestore(); }
  await Bun.sleep(400);
  expect([handlesUnder(recovery.dataDir), handlesUnder(recovery.cacheDir)]).toEqual([0, 0]);
  const again = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("free") });
  expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe("free");
  await again.stop(true);
});

test("a sign-in store names its cookie after its origin, secures it for HTTPS, and keeps from before only what fits, is well formed and hasn't run out", async () => {
  const named = (url: string) => `shore_web_${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
  const plain = new WebSessions("http://127.0.0.1:7430", 4, 60_000);
  const secure = new WebSessions("https://shore.example", 4, 60_000);
  cleanups.push(() => { plain.close(); secure.close(); });
  expect(plain.cookie(required(plain.create())).split("=", 1)[0]).toBe(named("http://127.0.0.1:7430"));
  const secured = secure.cookie(required(secure.create()));
  expect([secured.split("=", 1)[0], secured.includes("; Secure")]).toEqual([`__Host-${named("https://shore.example")}`, true]);
  const config = await recoveryOptions();
  const recovery = new WebRecovery(config, origin);
  cleanups.push(() => { recovery.close(); });
  const now = Date.now() + 10_000;
  const keep = (id: string, expiresAt: number) => { recovery.saveSession({ id, expires_at: expiresAt, name: "Browser", created_at: now, last_used_at: now }); };
  keep("d".repeat(64), now); keep("not a digest", now + 500); keep("a".repeat(64), now + 1_000); keep("b".repeat(64), now + 2_000); keep("c".repeat(64), now + 3_000); keep("e".repeat(64), Number.MAX_SAFE_INTEGER + 2);
  setSystemTime(new Date(now));
  try {
    const restored = new WebSessions(origin, 2, 60_000, recovery);
    cleanups.push(() => { restored.close(); });
    expect([restored.list().map((session) => session.id), recovery.sessions().map((session) => session.id)]).toEqual([["a".repeat(64), "b".repeat(64)], ["a".repeat(64), "b".repeat(64)]]);
  } finally { setSystemTime(); }
});

test("an archive whose outcome the daemon can't vouch for says so, and one the daemon refused says why", async () => {
  const f = await archiveFixture(); const a = owner();
  const outcomes: [string, string, string][] = [];
  for (const scenario of ["failed", "cancelled", "missing", "duplicate", "wrong-name"]) {
    const info = await f.transfers.upload(a.session, upload());
    f.transfers.import(a.session, info.id);
    await f.finish(await f.next(), scenario);
    await until(() => !["importing"].includes(f.transfers.get(a.session, info.id).phase), "the import to settle");
    const settled = f.transfers.get(a.session, info.id);
    outcomes.push([scenario, settled.phase, settled.error ?? ""]);
    if (settled.phase !== "uncertain") await f.transfers.remove(a.session, info.id);
  }
  expect(outcomes).toEqual([
    ["failed", "failed", "Refusing to overwrite existing character"],
    ["cancelled", "uncertain", "Archive outcome could not be confirmed; inspect the character list before trying again"],
    ["missing", "uncertain", "Archive outcome could not be confirmed; inspect the character list before trying again"],
    ["duplicate", "uncertain", "Unexpected archive response"],
    ["wrong-name", "uncertain", "Unexpected archive response"],
  ]);
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
    handshake: { hello: async () => ({ characters: [] }), history: async () => ({ messages: [], previousSegment: null, config: {}, selectedCharacter: null, selectedThread: "main", revision: 0 }), select: async (character) => ({ character, thread: null }) },
  });
  const web = startWebServer({
    server: swp, dataDir: signedInData(),
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" },
    picture: (file) => findSentPicture(data, file),
  });
  web.activate();
  cleanups.push(async () => { await web.stop(); swp.stop(); });
  const { code } = await (await fetch(`${web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
  const login = await fetch(`${web.origin}/api/login`, { method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const picture = (file: string, headers?: Record<string, string>) => fetch(`${web.origin}/api/pictures/${file}`, { headers: headers ?? { cookie } });

  const shown = await picture(basename(kept));
  expect(shown.status).toBe(200);
  const headed = await fetch(`${web.origin}/api/pictures/${basename(kept)}`, { method: "HEAD", headers: { cookie } });
  expect([headed.status, headed.headers.get("content-type"), await headed.text()]).toEqual([200, "image/png", ""]);
  expect(shown.headers.get("content-type")).toBe("image/png");
  expect(shown.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(Buffer.from(await shown.arrayBuffer())).toEqual(bytes);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await picture(basename(kept), {})).status).toBe(401);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await picture(`${"b".repeat(64)}.png`)).status).toBe(404);
  expect((await picture("..%2F..%2Fshore.db")).status).toBe(404);

  const video = `${"c".repeat(64)}.mp4`;
  await writeFile(join(sentPicturesDir(data, "qifei"), video), "0123456789");
  const whole = await picture(video);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  expect(whole.headers.get("content-security-policy")).toContain("media-src 'self'");
  const probe = await picture(video, { cookie, range: "bytes=0-1" });
  expect(probe.status).toBe(206);
  expect(probe.headers.get("content-range")).toBe("bytes 0-1/10");
  expect(probe.headers.get("content-type")).toBe("video/mp4");
  expect(await probe.text()).toBe("01");
  expect((await picture(video, { range: "bytes=0-1" })).status).toBe(401);
});

describe("what the page itself is served", () => {
  test("the page and its assets come with their type, assets are cached for good, the page is not, and a HEAD has no body", async () => {
    const f = await fixture(); f.web.activate();
    const page = await fetch(`${f.web.origin}/workspace/ada/story`);
    const html = await page.text();
    expect([page.status, page.headers.get("content-type"), page.headers.get("cache-control")]).toEqual([200, "text/html; charset=utf-8", "no-store"]);
    const script = required(/src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]);
    const asset = await fetch(`${f.web.origin}${script}`);
    expect([asset.status, asset.headers.get("content-type"), asset.headers.get("cache-control"), (await asset.text()).length > 0]).toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable", true]);
    const headed = await fetch(`${f.web.origin}/`, { method: "HEAD" });
    expect([headed.status, headed.headers.get("content-type"), await headed.text()]).toEqual([200, "text/html; charset=utf-8", ""]);
  });

});

describe("the daemon's password", () => {
  const PASSWORD = "correct horse";
  const said = async (response: Response) => [response.status, response.status === 204 ? null : await response.json()];
  const cli = (f: Awaited<ReturnType<typeof fixture>>, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${f.web.address}/api/sign-in`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const state = async (f: Awaited<ReturnType<typeof fixture>>) => await (await fetch(`${f.web.address}/api/sign-in`)).json();

  test("is chosen on a first visit by whoever comes, once, and only a long enough one", async () => {
    const f = await fixture(); f.web.activate();
    expect(await state(f)).toEqual({ password_set: false });
    expect(await said(await f.api("/api/login", "", { password: PASSWORD }))).toEqual([403, { code: "forbidden", message: "This daemon has no password yet. Choose one first." }]);
    expect(await said(await cli(f, { name: "desk", password: PASSWORD }))).toEqual([403, { code: "forbidden", message: "This daemon has no password yet. Choose one first." }]);
    for (const body of [{}, { password: 8 }, { password: PASSWORD, extra: true }, { current: PASSWORD }]) {
      expect(await said(await f.api("/api/password", "", body))).toEqual([400, { code: "invalid_request", message: "Send the new password, and the current one if the daemon has one" }]);
    }
    expect(await said(await f.api("/api/password", "", { password: "seven c" }))).toEqual([400, { code: "invalid_request", message: "Choose a password of at least 8 characters" }]);
    expect(await state(f)).toEqual({ password_set: false });
    expect(await said(await f.api("/api/password", "", { password: PASSWORD }))).toEqual([204, null]);
    expect(await state(f)).toEqual({ password_set: true });
    expect(await said(await f.api("/api/password", "", { password: "someone else's" }))).toEqual([403, { code: "forbidden", message: "This daemon already has a password. Give the current one to change it." }]);
    expect(await said(await f.api("/api/login", "", { password: "someone else's" }))).toEqual([401, { code: "unauthorized", message: "That password isn’t right" }]);
    expect(f.histories()).toBe(0);
  });

  test("signs a browser in, and signs a CLI in as a device of its own", async () => {
    const f = await fixture(); f.web.activate();
    await f.api("/api/password", "", { password: PASSWORD });
    const login = await f.api("/api/login", "", { password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect((await f.api("/api/session", cookie)).status).toBe(200);

    expect(await said(await cli(f, { name: "desk", password: "nope nope" }))).toEqual([401, { code: "unauthorized", message: "That password isn’t right" }]);
    expect(await said(await cli(f, { name: "  ", password: PASSWORD }))).toEqual([400, { code: "invalid_request", message: "Give the device a name of 1 to 64 characters, without control characters" }]);
    for (const body of [{ name: "desk" }, { name: "desk", password: PASSWORD, secret: "s" }, "not an object"]) {
      expect(await said(await cli(f, body))).toEqual([400, { code: "invalid_request", message: "Name this device and give the daemon’s password" }]);
    }
    const signed = await cli(f, { name: " desk ", password: PASSWORD });
    expect(signed.status).toBe(200);
    const { token } = await signed.json() as { token: string };
    expect(token).toMatch(/^shore_[A-Za-z0-9_-]{43}$/);
    const hello = await fetch(`${f.web.address}/api/hello`, { headers: { authorization: `Bearer ${token}` } });
    expect(hello.status).toBe(200);
    const listed = await (await f.api("/api/devices/list", cookie)).json() as { devices: { kind: string; name: string }[] };
    expect(listed.devices.filter((device) => device.kind === "cli").map((device) => device.name)).toEqual(["Test CLI", "desk"]);
  });

  test("changes only with the current one, and then the old one no longer works", async () => {
    const f = await fixture(); f.web.activate();
    await f.api("/api/password", "", { password: PASSWORD });
    const { cookie } = await f.login();
    expect(await said(await f.api("/api/password", "", { current: "not it at all", password: "battery staple" }))).toEqual([401, { code: "unauthorized", message: "That password isn’t right" }]);
    expect(await said(await f.api("/api/password", "", { current: PASSWORD, password: "short" }))).toEqual([400, { code: "invalid_request", message: "Choose a password of at least 8 characters" }]);
    expect(await said(await f.api("/api/password", "", { current: PASSWORD, password: "battery staple" }))).toEqual([204, null]);
    expect((await f.api("/api/login", "", { password: PASSWORD })).status).toBe(401);
    expect((await f.api("/api/login", "", { password: "battery staple" })).status).toBe(200);
    expect((await cli(f, { name: "desk", password: "battery staple" })).status).toBe(200);
    expect((await f.api("/api/session", cookie)).status, "a browser already in stays in").toBe(200);
  });

  test("is guessed at most so often a minute from one place, whichever door the guesses come through", async () => {
    const f = await fixture(); f.web.activate();
    await f.api("/api/password", "", { password: PASSWORD });
    for (let i = 0; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) {
      const door = [() => f.api("/api/login", "", { password: `wrong ${String(i)}` }), () => cli(f, { name: "desk", password: `wrong ${String(i)}` }), () => f.api("/api/password", "", { current: `wrong ${String(i)}`, password: "battery staple" })][i % 3];
      expect((await required(door)()).status).toBe(401);
    }
    const held = { code: "too_many_requests", message: "Too many sign-in attempts; try again in a minute" };
    expect(await said(await f.api("/api/login", "", { password: PASSWORD })), "not even the right one").toEqual([429, held]);
    expect(await said(await cli(f, { name: "desk", password: PASSWORD }))).toEqual([429, held]);
    expect(await said(await f.api("/api/password", "", { current: PASSWORD, password: "battery staple" }))).toEqual([429, held]);
  }, 20_000);

  test("a right password forgives the wrong ones before it", async () => {
    const f = await fixture(); f.web.activate();
    await f.api("/api/password", "", { password: PASSWORD });
    for (let i = 1; i < WEB_LIMITS.loginAttemptsPerMinute; i += 1) expect((await cli(f, { name: "desk", password: "wrong one" })).status).toBe(401);
    expect((await cli(f, { name: "desk", password: PASSWORD })).status).toBe(200);
    const after = [await cli(f, { name: "desk", password: "wrong one" }), await cli(f, { name: "desk", password: "wrong one" })];
    expect(after.map((answer) => answer.status), "the count started again").toEqual([401, 401]);
  }, 20_000);

  test("is refused to another site's page, and shares its limit on sign-ins under way with the browser's door", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    for (const site of ["cross-site", "same-site"]) {
      expect(await said(await cli(f, { password: PASSWORD }, { "sec-fetch-site": site }))).toEqual([403, { code: "forbidden", message: "Another site’s page can’t use this daemon" }]);
      expect(await said(await fetch(`${f.web.address}/api/password`, { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "content-type": "application/json", "sec-fetch-site": site } }))).toEqual([403, { code: "forbidden", message: "Another site’s page can’t use this daemon" }]);
    }
    expect(await state(f)).toEqual({ password_set: false });
    const holding = new AbortController();
    const held = fetch(`${f.web.origin}/api/login`, {
      method: "POST", signal: holding.signal, headers: { origin: f.web.origin, "content-type": "application/json" },
      body: new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode('{"pass')); } }), duplex: "half",
    }).catch(() => undefined);
    await Bun.sleep(50);
    expect(await said(await f.api("/api/password", "", { password: PASSWORD }))).toEqual([429, { code: "too_many_requests", message: "Too many sign-in attempts; try again in a minute" }]);
    holding.abort();
    await held;
    await untilAsync(async () => (await f.api("/api/password", "", { password: PASSWORD })).status === 204, "the held sign-in to end its count");
    expect((await fetch(`${f.web.address}/api/password`, { method: "POST", body: "x".repeat(WEB_LIMITS.loginBytes + 1), headers: { "content-type": "application/json" } })).status).toBe(413);
  });

  test("a password file Shore didn't write says to delete it, and deleting it lets a new one be chosen", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "shore-web-password-"));
    await writeFile(join(dataDir, "password"), "written by hand\n");
    const f = await fixture({ dataDir }); f.web.activate();
    const problem = [503, { code: "unavailable", message: `${join(dataDir, "password")} doesn’t hold a password Shore set. Delete it, then choose the password again.` }];
    expect(await said(await f.api("/api/login", "", { password: "written by hand" }))).toEqual(problem);
    expect(await said(await cli(f, { name: "desk", password: "written by hand" }))).toEqual(problem);
    await rm(join(dataDir, "password"));
    expect(await state(f)).toEqual({ password_set: false });
    expect((await f.api("/api/password", "", { password: PASSWORD })).status).toBe(204);
    expect((await f.api("/api/login", "", { password: PASSWORD })).status).toBe(200);
  });
});

describe("signing a browser in", () => {
  test("too many failed attempts from one place are refused for a minute from the first, and a success forgets them", () => {
    const failures = new LoginFailures(2, 2);
    expect(failures.refused("a", 0)).toBe(false);
    failures.failed("a", 0);
    failures.failed("a", 10_000);
    expect([failures.refused("a", 59_999), failures.refused("b", 59_999)]).toEqual([true, false]);
    expect(failures.refused("a", 60_000)).toBe(false);
    failures.failed("a", 60_000);
    failures.succeeded("a");
    failures.failed("a", 60_001);
    expect(failures.refused("a", 60_002)).toBe(false);
  });

  test("keeps failures for a bounded number of places, letting the oldest go first", () => {
    const failures = new LoginFailures(1);
    for (let place = 0; place < 4096; place += 1) failures.failed(`place ${String(place)}`, 0);
    expect([failures.refused("place 0", 1), failures.refused("place 4095", 1)]).toEqual([true, true]);
    failures.failed("place 4096", 1);
    expect([failures.refused("place 0", 2), failures.refused("place 1", 2), failures.refused("place 4096", 2)]).toEqual([false, true, true]);
    failures.failed("place 1", 3);
    expect(failures.refused("place 2", 4), "a place already counted takes nobody's room").toBe(true);
  });

  test("a response the daemon makes is checked against its contract before it goes out", () => {
    expect(checked(validWebLoginCode, { code: "c", expires_at: 1 }, "code")).toEqual({ code: "c", expires_at: 1 });
    expect(() => checked(validWebLoginCode, { code: 1 }, "browser sign-in code response")).toThrow("Invalid browser sign-in code response");
  });

  test("signing in again from a browser already signed in ends its old sign-in, and renewing hands the cookie back", async () => {
    const f = await fixture(); f.web.activate();
    const first = await f.login();
    const again = await f.api("/api/login", first.cookie, { code: await f.code() });
    const second = again.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect((await f.api("/api/session", first.cookie)).status).toBe(401);
    const renewed = await f.api("/api/session", second);
    expect([renewed.status, renewed.headers.get("set-cookie")?.split(";", 1)[0]]).toEqual([200, second]);
  });

  test("a browser that signs in starts its count of failed attempts over", async () => {
    const f = await fixture(); f.web.activate();
    const wrong = async () => (await f.api("/api/login", "", { code: "wrong" })).status;
    for (let tried = 1; tried < WEB_LIMITS.loginAttemptsPerMinute; tried += 1) expect(await wrong()).toBe(401);
    expect((await f.api("/api/login", "", { code: await f.code() })).status).toBe(200);
    expect([await wrong(), await wrong()]).toEqual([401, 401]);
  });

  test("a sign-in still arriving when the daemon stops is told the daemon is stopping", async () => {
    const f = await fixture(); f.web.activate();
    const token = await f.code();
    let rest = (): void => {};
    const body = new ReadableStream<Uint8Array>({ start(output) {
      output.enqueue(new TextEncoder().encode('{"code":'));
      rest = () => { output.enqueue(new TextEncoder().encode(JSON.stringify(token) + "}")); output.close(); };
    } });
    const answer = fetch(`${f.web.origin}/api/login`, { method: "POST", body, duplex: "half", headers: { origin: f.web.origin, "content-type": "application/json" } });
    await Bun.sleep(50);
    const stopping = f.web.stop();
    rest();
    const refused = await answer;
    expect([refused.status, await refused.json()]).toEqual([503, { code: "unavailable", message: "The daemon is stopping" }]);
    await stopping;
  });

  test("only as many sign-ins can be under way at once as the daemon takes connections, and each one ends its count", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    expect((await f.api("/api/login", "", { code: "wrong" })).status).toBe(401);
    const holding = new AbortController();
    const held = fetch(`${f.web.origin}/api/login`, {
      method: "POST", signal: holding.signal, headers: { origin: f.web.origin, "content-type": "application/json" },
      body: new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode('{"tok')); } }), duplex: "half",
    }).catch(() => undefined);
    await Bun.sleep(50);
    const refused = await f.api("/api/login", "", { code: "wrong" });
    expect([refused.status, await refused.json()]).toEqual([429, { code: "too_many_requests", message: "Too many sign-in attempts; try again in a minute" }]);
    holding.abort();
    await held;
    await untilAsync(async () => (await f.api("/api/login", "", { code: "wrong" })).status === 401, "the held sign-in to end its count");
  });
});

describe("a browser's request history over HTTP", () => {
  test("lists what the browser asked, dismisses an outcome once it is over, and says why it can't otherwise", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const listed = await f.api("/api/requests/list", cookie);
    const history = await listed.json() as { requests: unknown[]; max_records: number; max_result_bytes: number };
    expect([listed.status, history.requests, typeof history.max_records, typeof history.max_result_bytes]).toEqual([200, [], "number", "number"]);
    const unknown = await f.api("/api/requests/nothing-here", cookie);
    expect([unknown.status, await unknown.json()]).toEqual([404, { code: "not_found", message: "Unknown request history endpoint" }]);
    const missing = await f.api(`/api/requests/${crypto.randomUUID()}/acknowledge`, cookie);
    expect([missing.status, await missing.json()]).toEqual([404, { code: "not_found", message: "Request outcome missing or expired" }]);
    const browser = connectBrowser(f.web.origin, cookie);
    await browser.attach();
    const rid = crypto.randomUUID();
    browser.send({ type: "message", rid, text: "hello" });
    await until(() => f.routed.some((route) => route.kind === "engine" && route.meta.rid === rid), "the request to reach the daemon");
    const record = required((await (await f.api("/api/requests/list", cookie)).json() as { requests: { id: string; rid: string }[] }).requests.find((entry) => entry.rid === rid));
    const running = await f.api(`/api/requests/${record.id}/acknowledge`, cookie);
    expect([running.status, await running.json()]).toEqual([409, { code: "invalid_request", message: "Wait for this request to finish before dismissing it" }]);
    const route = required(f.routed.find((entry) => entry.kind === "engine" && entry.meta.rid === rid));
    if (route.kind !== "engine") throw new Error("not a message");
    await f.finish(route.meta.session.sessionId, { type: "request_finished", rid, outcome: "completed" });
    await browser.frame("request_finished", rid);
    const done = await f.api(`/api/requests/${record.id}/acknowledge`, cookie);
    expect([done.status, await done.text()]).toEqual([204, ""]);
    const broken = spyOn(RequestHistory.prototype, "acknowledge").mockImplementation(() => { throw new Error("the disk is gone"); });
    try {
      const unavailable = await f.api(`/api/requests/${record.id}/acknowledge`, cookie);
      expect([unavailable.status, await unavailable.json()]).toEqual([503, { code: "unavailable", message: "Request recovery storage is unavailable; retain unreviewed outcomes and try again" }]);
    } finally { broken.mockRestore(); }
    const fetched = await fetch(`${f.web.origin}/api/requests/list`, { headers: { origin: f.web.origin, cookie } });
    expect([fetched.status, await fetched.json()]).toEqual([404, { code: "not_found", message: "Unknown browser endpoint" }]);
  });
});

describe("a browser's socket", () => {
  test("is limited to the daemon's connections, answers in the page's protocol, needs an upgrade, and lets go when closed", async () => {
    const f = await fixture({ config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_connections: 1 } }); f.web.activate();
    const { cookie } = await f.login();
    const plain = await fetch(`${f.web.origin}/api/swp`, { headers: { origin: f.web.origin, cookie, "sec-websocket-protocol": WEB_SUBPROTOCOL } });
    expect([plain.status, await plain.json()]).toEqual([400, { code: "invalid_request", message: "Expected a WebSocket upgrade" }]);
    const browser = connectBrowser(f.web.origin, cookie);
    await browser.attach();
    expect(browser.socket.protocol).toBe(WEB_SUBPROTOCOL);
    const second = await fetch(`${f.web.origin}/api/swp`, { headers: { origin: f.web.origin, cookie, "sec-websocket-protocol": WEB_SUBPROTOCOL, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect([second.status, await second.json()]).toEqual([429, { code: "too_many_requests", message: "Browser connection limit reached" }]);
    await browser.close();
    await until(() => f.controls.some((control) => control.kind === "session_disconnected"), "the closed socket to let go");
  });
});

describe("a browser's socket, once it is in", () => {
  const sessionOf = (f: Awaited<ReturnType<typeof fixture>>) => required(f.swp.sessionRouter.sessions()[0])[0];
  const small = { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0", max_queued_bytes: 4096 };

  test("isn't timed out by its hello deadline once it has attached", async () => {
    const f = await fixture({ handshakeTimeoutMs: 100 }); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    await Bun.sleep(250);
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("that can't attach is told so and let go, and every socket is let go when the daemon stops", async () => {
    const f = await fixture({}, {
      hello: async () => { await Promise.resolve(); throw new Error("the characters can't be read"); },
      select: (character) => Promise.resolve({ character, thread: null }),
      history: () => Promise.reject(new Error("unused")),
    }); f.web.activate();
    const { cookie } = await f.login();
    const refused = connectBrowser(f.web.origin, cookie);
    await refused.opened;
    refused.send({ type: "hello", client_type: "web", client_name: "test-tab", capabilities: [], character: "ada", thread: "main" });
    expect(await refused.frame("error")).toEqual({ type: "error", code: "internal_error", message: "Could not attach the browser session" });
    expect([(await refused.closed).code, refused.closeDetail]).toEqual([1012, "1012 Session ended; reconnect to refresh history"]);
    const g = await fixture(); g.web.activate();
    const browser = connectBrowser(g.web.origin, (await g.login()).cookie);
    await browser.attach();
    g.swp.stop();
    expect((await browser.closed).code).toBe(1012);
  });

  test("gets a stream whole however far behind it is, but one that outgrows its queue is closed and told to reconnect", async () => {
    const f = await fixture({ config: small }); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    const session = sessionOf(f);
    for (let sent = 0; sent < 300; sent += 1) void f.swp.sessionRouter.sendToSession(session, { type: "stream_chunk", rid: "r", text: "ab", content_type: "text" });
    const streamed = () => browser.messages.filter((frame) => frame.type === "stream_chunk").map((frame) => frame.type === "stream_chunk" ? frame.text : "").join("");
    await until(() => streamed().length === 600, "the whole stream");
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
    for (let sent = 0; sent < 300; sent += 1) f.swp.broadcast({ type: "cache_warning", message: "x".repeat(1500), expected_tokens: sent });
    expect([(await browser.closed).code, browser.closeDetail]).toEqual([1013, "1013 Outgoing limit reached; reconnect to refresh history"]);
  });

  test("gets a history larger than its queue, at attach and any time after", async () => {
    const f = await fixture({ config: { ...small, max_queued_bytes: 1024 } }, {
      hello: async () => ({ characters: [{ name: "ada" }] }),
      select: (character) => Promise.resolve({ character, thread: null }),
      history: async (selected, thread) => ({ messages: [], previousSegment: null, config: { notes: "x".repeat(5000) }, selectedCharacter: selected, selectedThread: thread ?? "main", revision: 0 }),
    }); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    await f.swp.sessionRouter.sendToSession(sessionOf(f), { type: "history", messages: [], config: { notes: "y".repeat(5000) }, selected_character: "ada", selected_thread: "main", revision: 2 });
    await until(() => browser.messages.some((frame) => frame.type === "history" && frame.revision === 2), "the later history");
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("a request that finished while its browser was away is told to the next socket, once", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const first = connectBrowser(f.web.origin, cookie);
    await first.attach();
    const rid = crypto.randomUUID();
    first.send({ type: "message", rid, text: "hello" });
    await until(() => f.routed.some((route) => route.kind === "engine" && route.meta.rid === rid), "the request to reach the daemon");
    const session = sessionOf(f);
    await first.close();
    await until(() => f.swp.sessionRouter.sessions().length === 0, "the first socket to let go");
    await f.finish(session, { type: "request_finished", rid, outcome: "completed" });
    const second = connectBrowser(f.web.origin, cookie);
    await second.attach();
    expect(await second.frame("request_finished", rid)).toMatchObject({ rid, outcome: "completed" });
    await second.close();
    const third = connectBrowser(f.web.origin, cookie);
    await third.attach();
    await Bun.sleep(50);
    expect(third.messages.filter((frame) => frame.type === "request_finished")).toEqual([]);
  });

  test("counts a request of exactly its queue as fitting", async () => {
    const f = await fixture({ config: { ...small, max_queued_bytes: 1024 } }); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    const base = JSON.stringify({ type: "command", rid: "exact", name: "status", args: { pad: "" } });
    browser.socket.send(base.replace('"pad":""', `"pad":"${"x".repeat(1024 - base.length)}"`));
    await until(() => f.routed.some((route) => route.kind === "command" && route.meta.rid === "exact"), "a request the size of the queue to be taken");
  });

  test("takes 128 messages in its first second, its hello among them, and closes on the next", async () => {
    const f = await fixture(); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    for (let sent = 0; sent < 127; sent += 1) browser.send({ type: "command", rid: `r${String(sent)}`, name: "status", args: {} });
    await until(() => browser.messages.filter((frame) => frame.type === "error").length === 95, "the burst past the 32 pending requests to be refused");
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
    browser.send({ type: "command", rid: "one-too-many", name: "status", args: {} });
    expect([(await browser.closed).code, browser.closeDetail]).toEqual([1008, "1008 Request rate limit reached"]);
  });

  test("takes as many bytes in its first second, its hello among them, as one message may hold", async () => {
    const f = await fixture(); f.web.activate();
    const browser = connectBrowser(f.web.origin, (await f.login()).cookie);
    await browser.attach();
    const hello = JSON.stringify({ type: "hello", client_type: "web", client_name: "test-tab", capabilities: ["history-deltas"], character: "ada", thread: "main" });
    const base = JSON.stringify({ type: "command", rid: "huge", name: "status", args: { pad: "" } });
    browser.socket.send(base.replace('"pad":""', `"pad":"${"x".repeat(WEB_LIMITS.messageBytes - hello.length - base.length)}"`));
    await until(() => f.routed.some((route) => route.kind === "command" && route.meta.rid === "huge"), "the largest request there may be to be taken");
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("a request that fails inside the daemon", () => {
  test("a body too large is refused, and anything else is the daemon's own failure, for a browser and for a device alike", async () => {
    const f = await fixture(); f.web.activate();
    const { cookie } = await f.login();
    const big = { name: "x".repeat(70_000), operations: ["presence"] };
    const asBrowser = await f.api("/api/devices/automation", cookie, big);
    const asDevice = await fetch(`${f.web.address}/api/devices/automation`, { method: "POST", body: JSON.stringify(big), headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
    for (const answer of [asBrowser, asDevice]) expect([answer.status, await answer.json()]).toEqual([413, { code: "invalid_request", message: "Request body is too large" }]);
    const failing = spyOn(LoginCodes.prototype, "create").mockImplementation(() => { throw new Error("no randomness left"); });
    try {
      const browserCode = await f.api("/api/login-code", cookie);
      const deviceCode = await fetch(`${f.web.address}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      for (const answer of [browserCode, deviceCode]) expect([answer.status, await answer.json()]).toEqual([503, { code: "unavailable", message: "The daemon couldn’t complete this request" }]);
    } finally { failing.mockRestore(); }
    const reading = spyOn(WebSessions.prototype, "read").mockImplementation(() => { throw new Error("the cookie jar broke"); });
    try {
      const broken = await fetch(`${f.web.origin}/api/pictures/p.png`, { headers: { cookie } });
      expect([broken.status, await broken.json()]).toEqual([500, { code: "unavailable", message: "Browser transport error" }]);
    } finally { reading.mockRestore(); }
  });

  test("a daemon that keeps no transfers says so", async () => {
    const f = await fixture(); f.web.activate();
    const transfers = [
      await fetch(`${f.web.address}/api/transfers/${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      await fetch(`${f.web.address}/api/transfers`, { method: "POST", body: "x", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" } }),
    ];
    for (const answer of transfers) expect([answer.status, await answer.json()]).toEqual([503, { code: "unavailable", message: "This daemon keeps no archive transfers" }]);
  });
});

describe("what the listener asks of Bun", () => {
  function recordingServe() {
    const real = Bun.serve.bind(Bun);
    let given: Parameters<typeof Bun.serve>[0] | undefined;
    const held: string[] = [];
    const serve = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
      given = options;
      const server = real(options);
      const timeout = server.timeout.bind(server);
      Object.defineProperty(server, "timeout", { configurable: true, value: (request: Request, seconds: number) => { held.push(`${new URL(request.url).pathname} ${String(seconds)}`); timeout(request, seconds); } });
      return server;
    }) as typeof Bun.serve);
    cleanups.push(() => { serve.mockRestore(); });
    return { given: () => required(given), held };
  }

  test("idles HTTP out after ten seconds and sockets after a minute, pings sockets, doesn't compress them, closes one that won't drain, and resumes one that does", async () => {
    const recorded = recordingServe();
    const f = await fixture(); f.web.activate();
    const given = recorded.given() as { idleTimeout: number; websocket: { idleTimeout: number; sendPings: boolean; perMessageDeflate: boolean; closeOnBackpressureLimit: boolean; drain: (socket: unknown) => void } };
    expect([given.idleTimeout, given.websocket.idleTimeout, given.websocket.sendPings, given.websocket.perMessageDeflate, given.websocket.closeOnBackpressureLimit]).toEqual([10, 60, true, false, true]);
    let drained = 0;
    given.websocket.drain({ data: { drain: () => { drained += 1; } } });
    expect(drained).toBe(1);
  });

  test("keeps the connection open, however long it is quiet, for every operation, follower, transfer and archive", async () => {
    const recorded = recordingServe();
    const spool = new ArchiveSpool(join(await mkdtemp(join(tmpdir(), "shore-held-")), "transfers"));
    const f = await fixture({ transfers: spool }); f.web.activate();
    const spooled = await spool.reserve("test-cli");
    await writeFile(spooled.file, "archive");
    spool.publish(spooled, "download", 7);
    const bearer = { authorization: `Bearer ${TOKEN}` };
    await fetch(`${f.web.address}/api/op/no_such_operation_here`, { method: "POST", headers: bearer });
    await fetch(`${f.web.address}/api/op/status`, { method: "POST", headers: bearer, signal: AbortSignal.timeout(200) }).catch(() => undefined);
    const events = await fetch(`${f.web.address}/api/events`, { headers: bearer });
    await events.body?.cancel();
    await fetch(`${f.web.address}/api/transfers`, { method: "POST", body: "x", headers: { ...bearer, "content-type": "application/octet-stream" } });
    expect(await (await fetch(`${f.web.address}/api/transfers/${spooled.id}`, { headers: bearer })).text()).toBe("archive");
    const { cookie } = await f.login();
    await f.api("/api/archives", cookie, "archive bytes", { "content-type": "application/octet-stream", "x-shore-filename": "a.tar.gz" });
    await f.api(`/api/archives/${crypto.randomUUID()}/download`, cookie);
    expect(recorded.held).toEqual(["/api/op/status 0", "/api/events 0", "/api/transfers 0", `/api/transfers/${spooled.id} 0`, "/api/archives 0", expect.stringMatching(/^\/api\/archives\/[a-f0-9-]{36}\/download 0$/) as string]);
  });
});

describe("stopping the web listener", () => {
  test("a stopped listener leaves no browser sign-in waiting to run out on the store it closed", async () => {
    const recovery = await recoveryOptions();
    const listener = recoveringServer(recovery, await freePort(), 300);
    const { code } = await (await fetch(`${listener.web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
    expect((await listener.post("/login", "", JSON.stringify({ code }))).status).toBe(200);
    await listener.web.stop(); listener.swp.stop();
    await Bun.sleep(400);
    expect([handlesUnder(recovery.dataDir), handlesUnder(recovery.cacheDir)]).toEqual([0, 0]);
  });

  test("stopping closes the recovery store only once its browsers' unfinished requests are written down", async () => {
    const recovery = await recoveryOptions();
    const port = await freePort();
    const listener = recoveringServer(recovery, port, 60_000, 2_600);
    const { code } = await (await fetch(`${listener.web.origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json() as WebLoginCode;
    const cookie = (await listener.post("/login", "", JSON.stringify({ code }))).headers.get("set-cookie")?.split(";")[0] ?? "";
    const browser = connectBrowser(listener.web.origin, cookie);
    await browser.attach();
    const rid = crypto.randomUUID();
    browser.send({ type: "message", rid, text: "hello" });
    await untilAsync(async () => ((await (await listener.post("/requests/list", cookie)).json()) as { requests: unknown[] }).requests.length === 1, "the request to be recorded");
    await listener.web.stop(); listener.swp.stop();
    await Bun.sleep(1_000);
    const again = recoveringServer(recovery, port);
    cleanups.push(async () => { await again.web.stop(); again.swp.stop(); });
    const kept = await (await again.post("/requests/list", cookie)).json() as { requests: { rid: string; phase: string }[] };
    expect(kept.requests.map((request) => [request.rid, request.phase])).toEqual([[rid, "uncertain"]]);
  });

  test("stopping twice is one stop, and a device still following is let go once the grace is up", async () => {
    const f = await fixture(); f.web.activate();
    const events = await fetch(`${f.web.address}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const reader = required(events.body).getReader();
    await reader.read();
    const stopping = f.web.stop();
    expect(f.web.stop()).toBe(stopping);
    await stopping;
    const ended = await Promise.race([(async () => { try { for (let next = await reader.read(); !next.done; next = await reader.read()); } catch { return "cut off"; } return "ended"; })(), Bun.sleep(1_500).then(() => "still open")]);
    expect(ended).not.toBe("still open");
  });
});
