import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readdirSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSentPicture, sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { LoginCodes, WebSessions, type WebSession } from "../src/web/auth.ts";
import { required } from "../src/util/required.ts";
import { pageOrigin, readSmallJson, WebBodyTooLarge } from "../src/web/policy.ts";
import { sessionDigest, WebRecovery } from "../src/web/recovery.ts";
import { rejectionOf } from "./support/outcome.ts";

const ORIGIN = "http://127.0.0.1:7650";

afterEach(() => setSystemTime());

function cookieOf(sessions: WebSessions, session: WebSession): string {
  return sessions.cookie(session).split(";", 1)[0] ?? "";
}

function requestWith(cookie: string): Request {
  return new Request(`${ORIGIN}/api/session`, { headers: { cookie } });
}

describe("a browser session", () => {
  test("renews only for the browser holding its cookie, and the renewal outlives the original expiry", () => {
    jest.useFakeTimers();
    try {
      const sessions = new WebSessions(ORIGIN, 4, 60);
      const mine = sessions.create();
      const theirs = sessions.create();
      if (mine === undefined || theirs === undefined) throw new Error("no session");
      const cookie = cookieOf(sessions, mine);

      expect(() => sessions.renew(mine, requestWith(cookieOf(sessions, theirs)))).toThrow("Only the browser holding a sign-in can renew it");
      expect(() => sessions.renew(mine, requestWith(""))).toThrow("Only the browser holding a sign-in can renew it");

      jest.advanceTimersByTime(40);
      const renewed = sessions.renew(mine, requestWith(cookie));
      expect(renewed).toContain("Expires=");
      jest.advanceTimersByTime(40);
      expect(sessions.read(requestWith(cookie))?.id).toBe(mine.id);
      expect(mine.signal.aborted).toBe(false);

      jest.advanceTimersByTime(60);
      expect(mine.signal.aborted).toBe(true);
      expect(() => sessions.renew(mine, requestWith(cookie))).toThrow("Only the browser holding a sign-in can renew it");
      sessions.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a renewal is saved, so it survives a restart", () => {
    const saved: Array<[string, number]> = [];
    const recovery = { sessions: () => [], saveSession: () => {}, revokeSession: () => {}, renewSession: (id: string, at: number) => saved.push([id, at]) };
    const sessions = new WebSessions(ORIGIN, 4, 60_000, recovery as never);
    const session = sessions.create();
    if (session === undefined) throw new Error("no session");
    sessions.renew(session, requestWith(cookieOf(sessions, session)));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[0]).toBe(session.id);
    expect(saved[0]?.[1]).toBeGreaterThanOrEqual(session.expiresAt);
    sessions.close();
  });

  test("is refused once it has expired, even when its timer has not fired", () => {
    const sessions = new WebSessions(ORIGIN, 4, 60_000);
    const session = sessions.create();
    if (session === undefined) throw new Error("no session");
    const cookie = cookieOf(sessions, session);
    expect(sessions.read(requestWith(cookie))?.id).toBe(session.id);

    setSystemTime(new Date(session.expiresAt));
    expect(sessions.read(requestWith(cookie))).toBeUndefined();
    expect(session.signal.aborted).toBe(true);
    sessions.close();
  });

  test("a cookie that is not a well-formed token reads as no session", () => {
    const sessions = new WebSessions(ORIGIN, 4, 60_000);
    const session = sessions.create();
    if (session === undefined) throw new Error("no session");
    const [name] = cookieOf(sessions, session).split("=", 1);
    expect(sessions.read(requestWith(`${String(name)}=short`))).toBeUndefined();
    expect(sessions.read(requestWith(`${String(name)}=${"!".repeat(43)}`))).toBeUndefined();
    expect(sessions.read(requestWith("unrelated=1"))).toBeUndefined();
    sessions.close();
  });

  test("the oldest session gives way at capacity, and no capacity means no sessions", () => {
    const one = new WebSessions(ORIGIN, 1, 60_000);
    const first = one.create();
    const second = one.create();
    if (first === undefined || second === undefined) throw new Error("no session");
    expect(first.signal.aborted).toBe(true);
    expect(one.get(first.id)).toBeUndefined();
    expect(one.get(second.id)?.id).toBe(second.id);
    one.close();
    expect(one.create()).toBeUndefined();

    expect(new WebSessions(ORIGIN, 0, 60_000).create()).toBeUndefined();
  });
});

describe("a request body", () => {
  const post = (body: string, headers: Record<string, string>) =>
    new Request(`${ORIGIN}/api/login`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  test("is refused past the limit, whether it declares its length or not", async () => {
    expect(await rejectionOf(readSmallJson(post("{}", { "content-length": "65" }), 64))).toBeInstanceOf(WebBodyTooLarge);
    expect(await rejectionOf(readSmallJson(post("{}", { "content-length": "-1" }), 64))).toBeInstanceOf(WebBodyTooLarge);
    const streamed = new Request(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"a":"${"x".repeat(80)}"}`)); c.close(); } }),
    });
    expect(await rejectionOf(readSmallJson(streamed, 64))).toBeInstanceOf(WebBodyTooLarge);
  });

  test("a small body is read without a declared length, and a missing one is refused", async () => {
    const undeclared = new Request(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); } }),
    });
    expect(await readSmallJson(undeclared, 64)).toEqual({ ok: true });
    const empty = new Request(`${ORIGIN}/api/login`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(String(await rejectionOf(readSmallJson(empty, 64)))).toContain("Expected a JSON body");
  });

  test("a body that isn't bytes is refused, an over-long one is cancelled, and the body is let go either way", async () => {
    const streamed = (chunks: unknown[], cancelled: string[] = []) => new Request(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: new ReadableStream({
        pull(c) { const next = chunks.shift(); if (next === undefined) c.close(); else c.enqueue(next); },
        cancel() { cancelled.push("cancelled"); },
      }),
    });
    expect(String(await rejectionOf(readSmallJson(streamed(["{}"]), 64)))).toContain("Expected a byte stream");
    const cancelled: string[] = [];
    const long = streamed([new TextEncoder().encode(`{"a":"${"x".repeat(40)}`), new TextEncoder().encode(`${"x".repeat(40)}"}`), new TextEncoder().encode("never read")], cancelled);
    expect(await rejectionOf(readSmallJson(long, 64))).toBeInstanceOf(WebBodyTooLarge);
    expect(cancelled).toEqual(["cancelled"]);
    expect(long.body?.locked).toBe(false);
    const fine = streamed([new TextEncoder().encode('{"ok":true}')]);
    expect(await readSmallJson(fine, 64)).toEqual({ ok: true });
    expect(fine.body?.locked).toBe(false);
  });

  test("at the limit and of the right type, it is read", async () => {
    const body = `{"a":"${"x".repeat(56)}"}`;
    expect(body).toHaveLength(64);
    expect(await readSmallJson(post(body, { "content-length": "64" }), 64)).toEqual({ a: "x".repeat(56) });
    expect(String(await rejectionOf(readSmallJson(post("{}", { "content-type": "text/plain" }), 64)))).toContain("Expected application/json");
  });
});

describe("the page a request comes from", () => {
  const from = (origin: string | undefined, site?: string) =>
    new Request(`${ORIGIN}/api/login`, { headers: { ...(origin === undefined ? {} : { origin }), ...(site === undefined ? {} : { "sec-fetch-site": site }) } });

  test("must be this daemon's own origin, exactly", () => {
    expect(pageOrigin(from(ORIGIN), undefined)).toEqual({ origin: ORIGIN });
    expect(pageOrigin(from(undefined), undefined)).toHaveProperty("refused");
    expect(pageOrigin(from(ORIGIN, "cross-site"), undefined)).toHaveProperty("refused");
    expect(pageOrigin(from(`${ORIGIN}/elsewhere`), undefined)).toHaveProperty("refused");
    expect(pageOrigin(from("ftp://127.0.0.1:7650"), undefined)).toHaveProperty("refused");
    expect(pageOrigin(from("http://127.0.0.1:7651"), undefined)).toHaveProperty("refused");
    expect(pageOrigin(from("https://shore.example"), "https://shore.example")).toEqual({ origin: "https://shore.example" });
  });
});

describe("what the daemon keeps on disk for browsers", () => {
  test("the recovery store is private to the daemon's user and refuses anything but a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-sign-in-"));
    const options = { cacheDir: join(root, "cache"), dataDir: root, token: "t" };
    const directory = join(options.cacheDir, "web", sessionDigest(root));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "recovery.sqlite"), "");
    chmodSync(join(directory, "recovery.sqlite"), 0o644);

    new WebRecovery(options, ORIGIN).close();
    expect(statSync(join(options.cacheDir, "web")).mode & 0o777).toBe(0o700);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "recovery.sqlite")).mode & 0o777).toBe(0o600);

    const fifo = mkdtempSync(join(tmpdir(), "shore-sign-in-fifo-"));
    const fifoDir = join(fifo, "cache", "web", sessionDigest(fifo));
    mkdirSync(fifoDir, { recursive: true });
    Bun.spawnSync(["mkfifo", join(fifoDir, "recovery.sqlite")]);
    expect(() => new WebRecovery({ cacheDir: join(fifo, "cache"), dataDir: fifo, token: "t" }, ORIGIN)).toThrow("regular database file");
  });

  test("browser sessions outlive a restart unless they have expired, or the origin changed", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-sign-in-restart-"));
    const options = { cacheDir: join(root, "cache"), dataDir: root, token: "t" };
    const first = new WebRecovery(options, ORIGIN);
    first.saveSession("live", Date.now() + 60_000);
    first.saveSession("stale", Date.now() - 1);
    first.close();
    const second = new WebRecovery(options, ORIGIN);
    expect(second.sessions().map((session) => session.id)).toEqual(["live"]);
    second.close();
    const moved = new WebRecovery(options, "https://elsewhere.example");
    expect(moved.sessions()).toEqual([]);
    moved.close();
  });

  test("a store written by an earlier daemon keeps its sessions while the origin and token stay the same", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-sign-in-upgrade-"));
    const options = { cacheDir: join(root, "cache"), dataDir: root, token: "t" };
    new WebRecovery(options, ORIGIN).close();
    const db = new Database(join(options.cacheDir, "web", sessionDigest(root), "recovery.sqlite"));
    db.query("UPDATE identity SET fingerprint = ?").run(sessionDigest(JSON.stringify([1, ORIGIN, "t"])));
    db.query("INSERT INTO sessions VALUES (?, ?)").run("kept", Date.now() + 60_000);
    db.close();
    const upgraded = new WebRecovery(options, ORIGIN);
    expect(upgraded.sessions().map((session) => session.id)).toEqual(["kept"]);
    upgraded.close();
  });

  test("opening the recovery store leaves no file open, and a damaged one is refused and closed", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-sign-in-damaged-"));
    const options = { cacheDir: join(root, "cache"), dataDir: root, token: "t" };
    const descriptors = () => readdirSync("/proc/self/fd").length;
    new WebRecovery(options, ORIGIN).close();
    const open = descriptors();
    new WebRecovery(options, ORIGIN).close();
    expect(descriptors()).toBe(open);
    writeFileSync(join(options.cacheDir, "web", sessionDigest(root), "recovery.sqlite"), "not a database ".repeat(100));
    expect(() => new WebRecovery(options, ORIGIN)).toThrow();
    expect(descriptors()).toBe(open);
  });

  test("a sent picture is found only by its content name, never by a path", () => {
    const data = mkdtempSync(join(tmpdir(), "shore-sign-in-pictures-"));
    const name = `${"a".repeat(64)}.png`;
    mkdirSync(sentPicturesDir(data, "ada"), { recursive: true });
    writeFileSync(join(sentPicturesDir(data, "ada"), name), "png");
    writeFileSync(join(data, "secret.png"), "secret");
    expect(findSentPicture(data, name)).toBe(join(sentPicturesDir(data, "ada"), name));
    expect(findSentPicture(data, "../../../secret.png")).toBeUndefined();
    expect(findSentPicture(data, `${"b".repeat(64)}.png`)).toBeUndefined();
    writeFileSync(join(sentPicturesDir(data, "ada"), "notes.txt"), "not a picture");
    expect(findSentPicture(data, "notes.txt"), "a file beside the pictures that isn't named by its content").toBeUndefined();
  });
});

describe("ending a sign-in and spending a code", () => {
  test("a revoked sign-in can't issue a cookie, leaves no timer behind, and revoking it again does nothing", () => {
    jest.useFakeTimers();
    try {
      const sessions = new WebSessions(ORIGIN, 4, 60_000);
      const session = required(sessions.create());
      expect(sessions.cookie(session)).toContain("shore_web_");
      sessions.revoke(session);
      expect(() => sessions.cookie(session)).toThrow("Only a new browser sign-in can issue a cookie");
      expect(jest.getTimerCount()).toBe(0);
      sessions.revoke(session);
      expect(session.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a code is spent by the moment it expires, and codes can be made even with no room kept for them", () => {
    setSystemTime(new Date("2026-11-10T00:00:00Z"));
    try {
      const codes = new LoginCodes(60_000, 4);
      const { code } = codes.create();
      setSystemTime(new Date(Date.parse("2026-11-10T00:00:00Z") + 60_000));
      expect(codes.redeem(code)).toBe(false);
      const fresh = codes.create();
      expect(codes.redeem(fresh.code)).toBe(true);
      expect(new LoginCodes(60_000, 0).create().code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      setSystemTime();
    }
  });
});
