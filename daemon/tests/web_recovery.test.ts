import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebRecovery, sessionDigest, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { WebSessions } from "../src/web/auth.ts";
import { ArchiveTransfers } from "../src/web/archives.ts";
import { Server } from "../src/swp/server.ts";
import type { WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const origin = "http://127.0.0.1:7430";

async function options(): Promise<WebRecoveryOptions> {
  const root = await mkdtemp(join(tmpdir(), "shore-web-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
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
  const config = await options(); const a = open(config);
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
  const config = await options(); const a = open(config); const signed = signIn(a.sessions);
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
