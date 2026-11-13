import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shoreLog } from "../src/log.ts";
import { type WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";
import { type WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";
import { Server } from "../src/swp/server.ts";
import { ArchiveTransfers } from "../src/web/archives.ts";
import { WebSessions } from "../src/web/auth.ts";
import { WebRecovery, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { RequestHistory } from "../src/web/requests.ts";

const origin = "http://127.0.0.1:7430";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function recoveryOptions(): Promise<WebRecoveryOptions> {
  const root = await mkdtemp(join(tmpdir(), "shore-web-recovery-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  return { dataDir, cacheDir: join(root, "cache"), token: "private-recovery-daemon-token" };
}

function start(config: WebRecoveryOptions) {
  const recovery = new WebRecovery(config, origin);
  const sessions = new WebSessions(origin, 4, 60_000, recovery);
  const server = new Server({ addr: "127.0.0.1:0", serverName: "recovery", authenticate: () => true });
  const transfers = new ArchiveTransfers(server, () => true, {}, recovery);
  transfers.restore(sessions);
  const requests = new RequestHistory(recovery);
  requests.restore(sessions);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await transfers.close(); sessions.close(); recovery.close(); };
  cleanups.push(close);
  return { recovery, sessions, transfers, requests, close, path: join(dirname(recovery.artifacts), "recovery.sqlite") };
}

function signIn(sessions: WebSessions) {
  const session = sessions.create();
  if (session === undefined) throw new Error("Missing test sign-in");
  return { session, request: new Request(origin, { headers: { cookie: sessions.cookie(session) } }) };
}

function request(label: string, extra: Record<string, unknown> = {}): WebRequestInfo {
  return {
    id: crypto.randomUUID(), rid: `rid-${label}`, operation: "clear", label, character: "ada", thread: "main",
    started_at: 1_000, expires_at: Date.now() + 60_000, phase: "completed", result_omitted: false, ...extra,
  };
}

function archive(extra: Record<string, unknown> = {}): WebArchiveInfo {
  return { id: crypto.randomUUID(), filename: "test.tar.gz", bytes: 12, expires_at: Date.now() + 60_000, phase: "imported", downloadable: false, ...extra };
}

function insert(path: string, table: "requests" | "archives", owner: string, rows: (string | { id: string })[]): void {
  const db = new Database(path);
  try {
    for (const info of rows) {
      if (typeof info === "string") db.query(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(crypto.randomUUID(), owner, info);
      else db.query(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(info.id, owner, JSON.stringify(info));
    }
  } finally {
    db.close();
  }
}

function saved(path: string, table: "requests" | "archives"): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
  } finally {
    db.close();
  }
}

test("a daemon starts on saved web UI requests an older daemon wrote: one whose result no longer fits is kept without it, and unreadable ones are dropped", async () => {
  const config = await recoveryOptions();
  const before = start(config);
  const signed = signIn(before.sessions);
  const good = request("good");
  const stale = request("stale", { result: { name: "clear", data: { no_longer: "a field" } } });
  before.recovery.saveRequest(signed.session.id, good);
  await before.close();
  insert(before.path, "requests", signed.session.id, [
    stale,
    "{ not json",
    "null",
    JSON.stringify({ ...request("no rid"), rid: undefined }),
    JSON.stringify(request("bad id", { id: "not-an-id" })),
    JSON.stringify(request("unsafe expiry", { expires_at: 2 ** 60 })),
  ]);

  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    const after = start(config);
    const session = after.sessions.read(signed.request);
    if (session === undefined) throw new Error("The sign-in did not survive the restart");
    expect(after.requests.list(session).requests.toSorted((a, b) => a.label.localeCompare(b.label))).toEqual([
      good,
      request("stale", { id: stale.id, expires_at: stale.expires_at, result_omitted: true }),
    ]);
    expect(saved(after.path, "requests")).toBe(2);
    expect(warned.mock.calls).toEqual([["shore: saved web UI requests from an older daemon: 1 kept without their result, 5 dropped as unreadable"]]);
    await after.close();

    warned.mockClear();
    const again = start(config);
    const still = again.sessions.read(signed.request);
    if (still === undefined) throw new Error("The sign-in did not survive the second restart");
    expect(again.requests.list(still).requests).toHaveLength(2);
    expect(warned.mock.calls).toEqual([]);
  } finally {
    warned.mockRestore();
  }
});

test("a daemon starts on saved archive jobs an older daemon wrote: one whose result no longer fits is kept without it, and unreadable ones are dropped", async () => {
  const config = await recoveryOptions();
  const before = start(config);
  const signed = signIn(before.sessions);
  const good = archive();
  const stale = archive({ result: { no_longer: "a field" } });
  before.recovery.saveArchive(signed.session.id, good);
  await before.close();
  insert(before.path, "archives", signed.session.id, [stale]);

  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    const trimmed = start(config);
    const session = trimmed.sessions.read(signed.request);
    if (session === undefined) throw new Error("The sign-in did not survive the restart");
    expect(trimmed.transfers.get(session, good.id)).toEqual(good);
    expect(trimmed.transfers.get(session, stale.id)).toEqual(archive({ id: stale.id, expires_at: stale.expires_at }));
    expect(warned.mock.calls).toEqual([["shore: saved web UI archives from an older daemon: 1 kept without their result, 0 dropped as unreadable"]]);
    await trimmed.close();

    warned.mockClear();
    insert(trimmed.path, "archives", signed.session.id, ["{ not json", JSON.stringify(archive({ id: "not-an-id" }))]);
    const dropped = start(config);
    const still = dropped.sessions.read(signed.request);
    if (still === undefined) throw new Error("The sign-in did not survive the second restart");
    expect(dropped.transfers.list(still).archives.map((info) => info.id).toSorted()).toEqual([good.id, stale.id].toSorted());
    expect(saved(dropped.path, "archives")).toBe(2);
    expect(warned.mock.calls).toEqual([["shore: saved web UI archives from an older daemon: 0 kept without their result, 2 dropped as unreadable"]]);
  } finally {
    warned.mockRestore();
  }
});
