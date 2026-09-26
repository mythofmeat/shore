import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebRecovery, type WebRecoveryOptions } from "../src/web/recovery.ts";
import { WebSessions } from "../src/web/auth.ts";
import { RequestHistory, REQUEST_HISTORY_LIMITS } from "../src/web/requests.ts";
import type { WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";
import type { SessionMeta } from "../src/swp/session.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const origin = "http://127.0.0.1:7430";
const selection: SessionMeta = { clientId: 1, sessionId: 1, clientType: "web", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "side" };
const edit = (rid = crypto.randomUUID()) => ({ type: "command" as const, name: "edit", rid, args: { ref: "1", content: "private-input-must-not-be-retained" } });
const idOf = (id: string | undefined): string => { if (id === undefined) throw new Error("Missing request ID"); return id; };

async function options(): Promise<WebRecoveryOptions> {
  const root = await mkdtemp(join(tmpdir(), "shore-request-history-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data"); await mkdir(dataDir);
  return { dataDir, cacheDir: join(root, "cache"), token: "private-request-token" };
}

function open(config?: WebRecoveryOptions, lifetime = 60_000) {
  const recovery = config === undefined ? undefined : new WebRecovery(config, origin);
  const sessions = new WebSessions(origin, 16, lifetime, recovery);
  const history = new RequestHistory(recovery); history.restore(sessions);
  const session = sessions.create(); if (session === undefined) throw new Error("Missing sign-in");
  const cookie = sessions.cookie(session);
  let closed = false;
  const close = () => { if (closed) return; closed = true; sessions.close(); recovery?.close(); };
  cleanups.push(close);
  return { recovery, sessions, history, session, cookie, close };
}

test("mutation admission records selection without retaining arguments, credentials or read-only requests", async () => {
  const f = open(await options());
  expect(f.history.begin(f.session, selection, { ...edit(), name: "status", args: {} })).toBeUndefined();
  expect(f.history.begin(f.session, selection, { ...edit(), name: "config", args: { key: "chat.model" } })).toBeUndefined();
  expect(f.history.begin(f.session, selection, { ...edit(), name: "switch_character", args: { name: "bo" } })).toBeUndefined();
  expect(f.history.begin(f.session, selection, { ...edit(), name: "nonexistent" })).toBeUndefined();
  const request = edit(); const id = idOf(f.history.begin(f.session, selection, request));
  expect(f.history.list(f.session).requests).toHaveLength(1);
  expect(f.history.list(f.session).requests[0]).toMatchObject({ id, rid: request.rid, operation: "edit", character: "ada", thread: "side", phase: "running", expires_at: f.session.expiresAt });
  const dbPath = join(dirname(f.recovery?.artifacts ?? ""), "recovery.sqlite");
  const bytes = await readFile(dbPath);
  expect(bytes.includes(request.args.content)).toBe(false); expect(bytes.includes("private-request-token")).toBe(false);
  expect(bytes.includes(f.cookie.split(";", 1)[0]?.split("=")[1] ?? "missing")).toBe(false);
});

test("messages and regeneration are tracked with the same lifecycle", () => {
  const f = open();
  for (const type of ["message", "regen"] as const) {
    const request = type === "message" ? { type, rid: crypto.randomUUID(), text: "private user text", images: [], stream: true } : { type, rid: crypto.randomUUID(), guidance: "private guidance", stream: true };
    idOf(f.history.begin(f.session, selection, request));
    f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" });
  }
  expect(f.history.list(f.session).requests.map((request) => request.operation).sort()).toEqual(["message", "regen"]);
  expect(f.history.list(f.session).requests.every((request) => request.phase === "completed")).toBe(true);
  expect(JSON.stringify(f.history.list(f.session))).not.toContain("private guidance");
});

test("results are correlated, bounded, typed and detached from caller mutations", () => {
  const f = open(); const request = edit(); const id = idOf(f.history.begin(f.session, selection, request));
  const data = { ref: "1", edited: true, future_detail: "kept" };
  f.history.settle(selection.sessionId, { type: "command_output", rid: "unrelated", name: "edit", data });
  expect(f.history.list(f.session).requests[0]?.result).toBeUndefined();
  f.history.settle(selection.sessionId, { type: "command_output", rid: request.rid, name: "edit", data });
  f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" });
  f.history.interrupt(f.session, id);
  const listed = f.history.list(f.session); expect(listed.requests[0]).toMatchObject({ phase: "completed", result: { name: "edit", data } });
  data.future_detail = "changed";
  expect(f.history.list(f.session).requests[0]?.result?.data).toMatchObject({ future_detail: "kept" });
  listed.requests.splice(0);
  expect(f.history.list(f.session).requests).toHaveLength(1);
});

test.each(["oversized", "invalid", "wrong-name", "duplicate"])("%s results are explicitly omitted, never retained as trustworthy output", (scenario) => {
  const f = open(); const request = edit(); idOf(f.history.begin(f.session, selection, request));
  const data = scenario === "invalid" ? { ref: "1" } : { ref: "1", edited: true, detail: scenario === "oversized" ? "x".repeat(REQUEST_HISTORY_LIMITS.resultBytes) : "small" };
  f.history.settle(selection.sessionId, { type: "command_output", rid: request.rid, name: scenario === "wrong-name" ? "get" : "edit", data });
  if (scenario === "duplicate") f.history.settle(selection.sessionId, { type: "command_output", rid: request.rid, name: "edit", data });
  f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" });
  expect(f.history.list(f.session).requests[0]).toMatchObject({ phase: "completed", result_omitted: true });
  expect(f.history.list(f.session).requests[0]?.result).toBeUndefined();
});

test("restart preserves outcomes and original expiry, and changes unfinished work to uncertainty without replay", async () => {
  const config = await options(); const a = open(config);
  const phases = ["running", "uncertain", "completed", "failed", "cancelled", "superseded"] as const;
  for (const phase of phases) {
    const request = edit(); const id = idOf(a.history.begin(a.session, selection, request));
    if (phase === "uncertain") a.history.interrupt(a.session, id);
    else if (phase !== "running") a.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: phase, ...(phase === "failed" ? { error: { code: "invalid_request", message: "failure" } } : {}) });
  }
  const before = a.history.list(a.session).requests; a.close();
  const b = open(config); const owner = b.sessions.read(new Request(origin, { headers: { cookie: a.cookie } }));
  if (owner === undefined) throw new Error("Session did not recover");
  expect(b.history.list(owner).requests).toEqual(before.map((request) => ({ ...request, phase: request.phase === "running" ? "uncertain" : request.phase })));
  expect(b.history.list(b.session).requests).toEqual([]);
  expect(() => b.history.acknowledge(b.session, idOf(before[0]?.id))).toThrow("missing or expired");
  expect(b.recovery?.requests().every((record) => record.info.phase !== "running")).toBe(true);
});

test("running records cannot be dismissed; acknowledgement, sign-out and expiry remove durable outcomes", async () => {
  const config = await options(); const f = open(config);
  const first = edit(); const id = idOf(f.history.begin(f.session, selection, first));
  expect(() => f.history.acknowledge(f.session, id)).toThrow("Wait for this request");
  f.history.interrupt(f.session, id); f.history.acknowledge(f.session, id);
  expect(f.recovery?.requests()).toEqual([]);
  f.history.begin(f.session, selection, edit()); f.sessions.revoke(f.session);
  expect(f.recovery?.requests()).toEqual([]);
  expect(() => f.history.list(f.session)).toThrow("Sign in again");
  expect(() => f.history.begin(f.session, selection, edit())).toThrow("Sign in again");
  const short = open(undefined, 10); short.history.begin(short.session, selection, edit());
  await Bun.sleep(15); expect(() => short.history.list(short.session)).toThrow("Sign in again");
});

test("rotation invalidates request outcomes along with their sessions", async () => {
  const config = await options(); const a = open(config); a.history.begin(a.session, selection, edit()); a.close();
  const b = open({ ...config, token: "rotated" });
  expect(b.recovery?.requests()).toEqual([]);
  expect(b.sessions.read(new Request(origin, { headers: { cookie: a.cookie } }))).toBeUndefined();
});

test("retained request IDs cannot be admitted twice, including after interruption", () => {
  const f = open(); const request = edit(); const id = idOf(f.history.begin(f.session, selection, request));
  expect(() => f.history.begin(f.session, selection, request)).toThrow("already has an outcome");
  f.history.interrupt(f.session, id);
  expect(() => f.history.begin(f.session, selection, request)).toThrow("already has an outcome");
});

test("capacity preserves uncertain requests and evicts only old terminal records", () => {
  const f = open();
  for (let i = 0; i < REQUEST_HISTORY_LIMITS.perSession; i += 1) {
    const request = edit(); const id = idOf(f.history.begin(f.session, selection, request));
    if (i === 0) f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" });
    else f.history.interrupt(f.session, id);
  }
  expect(() => f.history.begin(f.session, selection, edit())).not.toThrow();
  const full = f.history.list(f.session).requests;
  expect(full).toHaveLength(REQUEST_HISTORY_LIMITS.perSession); expect(full.some((request) => request.phase === "completed")).toBe(false);
  expect(() => f.history.begin(f.session, selection, edit())).toThrow("Review and dismiss");
  expect(f.history.list(f.session).requests).toEqual(full);
});

test("global capacity cannot evict another owner's uncertain work", () => {
  const f = open();
  for (let owner = 0; owner < REQUEST_HISTORY_LIMITS.total / REQUEST_HISTORY_LIMITS.perSession; owner += 1) {
    const session = owner === 0 ? f.session : f.sessions.create(); if (session === undefined) throw new Error("Missing owner");
    for (let i = 0; i < REQUEST_HISTORY_LIMITS.perSession; i += 1) f.history.interrupt(session, idOf(f.history.begin(session, selection, edit())));
  }
  const last = f.sessions.create(); if (last === undefined) throw new Error("Missing last owner");
  expect(() => f.history.begin(last, selection, edit())).toThrow("Review and dismiss");
  expect(f.history.list(f.session).requests).toHaveLength(REQUEST_HISTORY_LIMITS.perSession);
});

test("failed admission and acknowledgement storage writes preserve prior state", async () => {
  const f = open(await options()); const db = new Database(join(dirname(f.recovery?.artifacts ?? ""), "recovery.sqlite"));
  try {
    db.run("CREATE TRIGGER reject_insert BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END;");
    expect(() => f.history.begin(f.session, selection, edit())).toThrow("storage unavailable"); expect(f.history.list(f.session).requests).toEqual([]);
    db.run("DROP TRIGGER reject_insert");
    const id = idOf(f.history.begin(f.session, selection, edit())); f.history.interrupt(f.session, id);
    db.run("CREATE TRIGGER reject_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END;");
    expect(() => f.history.acknowledge(f.session, id)).toThrow("storage unavailable");
    expect(f.history.list(f.session).requests).toHaveLength(1);
  } finally { db.run("DROP TRIGGER IF EXISTS reject_delete; DROP TRIGGER IF EXISTS reject_insert;"); db.close(); }
});

test("outcome persistence failure keeps the outcome in memory and leaves a recoverable uncertainty on disk", async () => {
  const config = await options(); const f = open(config); const request = edit(); idOf(f.history.begin(f.session, selection, request));
  const db = new Database(join(dirname(f.recovery?.artifacts ?? ""), "recovery.sqlite"));
  try {
    db.run("CREATE TRIGGER reject_write BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END;");
    expect(f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" })).toMatchObject({ owner: f.session.id });
    expect(f.history.list(f.session).requests[0]?.phase).toBe("completed");
    expect(f.recovery?.requests()[0]?.info.phase).toBe("running");
  } finally { db.run("DROP TRIGGER reject_write"); db.close(); }
  f.close(); const next = open(config);
  expect(next.recovery?.requests()[0]?.info.phase).toBe("uncertain");
});

test("the daemon's outcome resolves an uncertain request, but unrelated or later completions change nothing", () => {
  const f = open(); const request = edit(); const id = idOf(f.history.begin(f.session, selection, request));
  f.history.interrupt(f.session, id);
  expect(f.history.list(f.session).requests[0]?.phase).toBe("uncertain");
  expect(f.history.settle(selection.sessionId + 1, { type: "request_finished", rid: request.rid, outcome: "completed" })).toBeUndefined();
  expect(f.history.settle(selection.sessionId, { type: "request_finished", rid: "unrelated", outcome: "completed" })).toBeUndefined();
  expect(f.history.list(f.session).requests[0]?.phase).toBe("uncertain");
  const settled = f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "failed", error: { code: "provider_error", message: "overloaded" } });
  expect(settled).toEqual({ owner: f.session.id, finished: { type: "request_finished", rid: request.rid, outcome: "failed", error: { code: "provider_error", message: "overloaded" } } });
  const before: WebRequestInfo | undefined = f.history.list(f.session).requests[0];
  expect(before).toMatchObject({ phase: "failed", error: { message: "overloaded" } });
  expect(f.history.settle(selection.sessionId, { type: "request_finished", rid: request.rid, outcome: "completed" })).toBeUndefined();
  expect(f.history.list(f.session).requests[0]).toEqual(before);
});
