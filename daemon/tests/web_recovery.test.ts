import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebRecovery, sessionDigest, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { WebSessions } from "../src/web/auth.ts";
import { ArchiveTransfers } from "../src/web/archives.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { startWebServer } from "../src/web/server.ts";
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

test("restart expires old sessions and transfers and honors a reduced session capacity", async () => {
  const config = await options(); const a = open(config); const first = signIn(a.sessions); const second = signIn(a.sessions);
  a.recovery.saveArchive(first.session.id, saved("uncertain", Date.now() - 1));
  a.recovery.saveSession("a".repeat(64), Date.now() - 1);
  a.recovery.saveArchive("a".repeat(64), saved("importing"));
  await a.close();
  const b = open(config, origin, 1);
  expect(b.sessions.read(first.request)).toBeDefined(); expect(b.sessions.read(second.request)).toBeUndefined();
  expect(b.sessions.create()).toBeUndefined(); expect(b.recovery.archives()).toEqual([]);
  expect(b.recovery.sessions()).toHaveLength(1);
});

test("an expired recovered sign-in cannot retain outcomes or renew its original lifetime", async () => {
  const config = await options(); const a = open(config); const signed = signIn(a.sessions);
  await a.close();
  const edit = new WebRecovery(config, origin);
  edit.revokeSession(signed.session.id); edit.saveSession(signed.session.id, Date.now() + 60);
  edit.saveArchive(signed.session.id, saved("imported")); edit.close();
  const b = open(config);
  await Bun.sleep(80);
  expect(b.sessions.read(signed.request)).toBeUndefined();
  expect(b.recovery.archives()).toEqual([]);
});

test("recovery retains final outcomes, converts incomplete imports to uncertainty and never dispatches again", async () => {
  const config = await options(); const a = open(config); const signed = signIn(a.sessions);
  const phases: WebArchiveInfo["phase"][] = ["uploading", "exporting", "ready", "importing", "imported", "uncertain", "failed"];
  const records = phases.map((phase) => saved(phase));
  for (const info of records) a.recovery.saveArchive(signed.session.id, info);
  await a.close();
  await mkdir(join(a.recovery.artifacts, "unrecorded-crash-orphan"));
  await writeFile(join(a.recovery.artifacts, "unrecorded-crash-orphan", "archive.tar.gz"), "private bytes");
  const b = open(config); const owner = b.sessions.read(signed.request);
  if (owner === undefined) throw new Error("No recovered owner");
  expect(await readdir(b.recovery.artifacts)).toEqual([]);
  expect(b.transfers.list(owner).archives.map((info) => info.phase)).toEqual(["failed", "failed", "failed", "uncertain", "imported", "uncertain", "failed"]);
  for (const record of records) {
    const recovered = b.transfers.get(owner, record.id);
    expect(recovered.expires_at).toBe(record.expires_at);
    expect(recovered.downloadable).toBe(false);
    expect(b.transfers.import(owner, record.id)).toEqual(recovered);
  }
  expect(b.transfers.activePeers).toBe(0); expect(b.server.sessionRouter.sessions()).toHaveLength(0);
  await b.close();
  const c = open(config); expect(c.recovery.archives().map((row) => row.info.phase)).not.toContain("importing");
});

test("saving the importing state must succeed before command dispatch", async () => {
  const config = await options(); const a = open(config); const signed = signIn(a.sessions);
  const upload = await a.transfers.upload(signed.session, new Request(origin, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "archive bytes" }));
  const db = new Database(join(dirname(a.recovery.artifacts), "recovery.sqlite"));
  try {
    db.run("CREATE TRIGGER reject_import BEFORE UPDATE ON archives BEGIN SELECT RAISE(FAIL, 'disk write rejected'); END;");
    expect(() => a.transfers.import(signed.session, upload.id)).toThrow("disk write rejected");
    expect(a.transfers.get(signed.session, upload.id).phase).toBe("ready");
    expect(a.transfers.activePeers).toBe(0); expect(a.server.sessionRouter.sessions()).toHaveLength(0);
  } finally { db.run("DROP TRIGGER reject_import"); db.close(); }
});

test("distinct data directories sharing a cache cannot clear each other's sessions or files", async () => {
  const config = await options(); const a = open(config); const signed = signIn(a.sessions);
  await writeFile(join(a.recovery.artifacts, "live-transfer"), "live");
  const dataDir = join(dirname(config.dataDir), "other-data"); await mkdir(dataDir);
  const b = open({ ...config, dataDir });
  expect(b.sessions.read(signed.request)).toBeUndefined();
  expect(b.recovery.artifacts).not.toBe(a.recovery.artifacts);
  expect(await readFile(join(a.recovery.artifacts, "live-transfer"), "utf8")).toBe("live");
});

test("orphan cleanup does not follow artifact symlinks and refuses symlinked recovery storage", async () => {
  const config = await options(); const a = open(config); const artifacts = a.recovery.artifacts;
  const outside = join(config.cacheDir, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "keep");
  await a.close(); await rm(artifacts, { recursive: true }); await symlink(outside, artifacts);
  const b = open(config); expect(await readdir(artifacts)).toEqual([]);
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
  await b.close();
  const external = join(outside, "private.sqlite"); const untouched = new Database(external);
  untouched.run("CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('keep');"); untouched.close();
  const before = await readFile(external);
  const db = join(dirname(artifacts), "recovery.sqlite"); await rm(db); await symlink(external, db);
  expect(() => new WebRecovery(config, origin)).toThrow();
  expect(await readFile(external)).toEqual(before);
});

test("recovery startup failures release the web port without accepting a session", async () => {
  const config = await options();
  await mkdir(config.cacheDir); await writeFile(join(config.cacheDir, "web"), "not a directory");
  const available = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = available.port; await available.stop(true);
  const server = new Server({ addr: "127.0.0.1:0", serverName: "test", authenticate: () => true });
  expect(() => startWebServer({ config: { ...defaultWebConfig(), enabled: true, bind_addr: `127.0.0.1:${String(port)}` }, server, authenticate: () => true, recovery: config })).toThrow();
  await rm(join(config.cacheDir, "web"));
  const web = startWebServer({ config: { ...defaultWebConfig(), enabled: true, bind_addr: `127.0.0.1:${String(port)}` }, server, authenticate: () => true, recovery: config });
  cleanups.push(() => web.stop()); web.activate();
  expect((await fetch(`${web.origin}/api/session`, { method: "POST", headers: { origin: web.origin } })).status).toBe(401);
  expect(await access(join(config.dataDir, "web")).then(() => true, () => false)).toBe(false);
});
