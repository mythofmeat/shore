import { afterEach, expect, test } from "bun:test";
import { access, chmod, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArchiveTransfers, type ArchiveTransferLimits } from "../src/web/archives.ts";
import type { WebSession } from "../src/web/auth.ts";
import { Server } from "../src/swp/server.ts";
import type { RoutedMessage } from "../src/swp/session.ts";
import { parseOperationInput } from "../src/operations/contracts.ts";
import { defaultWebConfig } from "../src/config/app.ts";
import { startWebServer } from "../src/web/server.ts";
import { validWebArchiveInfo, validWebArchiveList } from "../src/web/contracts.ts";
import { BrowserSocket } from "./support/browser.ts";
import { WEB_SUBPROTOCOL } from "../src/web/contract.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type CommandRoute = Extract<RoutedMessage, { kind: "command" }>;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Archive transfer did not settle");
    await Bun.sleep(2);
  }
}

function owner() {
  const controller = new AbortController();
  const session: WebSession = { id: crypto.randomUUID(), expiresAt: Date.now() + 60_000, signal: controller.signal };
  return { session, controller };
}

function upload(body: NonNullable<RequestInit["body"]> = "archive bytes", headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/archives", { method: "POST", body, headers: { "content-type": "application/octet-stream", "x-shore-filename": "ada.tar.gz", ...headers }, ...(signal === undefined ? {} : { signal }) });
}

async function fixture(limits: Partial<ArchiveTransferLimits> = {}, singleCharacter = false) {
  const server = new Server({ addr: "127.0.0.1:0", serverName: "archive-test", authenticate: () => true,
    handshake: { hello: async () => ({ characters: singleCharacter ? [{ name: "ada" }] : [] }), history: async (selectedCharacter) => ({ messages: [], activeStart: 0, config: {}, selectedCharacter, selectedThread: null, revision: 0 }) },
  });
  const commands: CommandRoute[] = [];
  await server.bind();
  const served = server.serve();
  let count = 0;
  const routing = (async () => { for await (const route of server.routes()) if (route.kind === "command") { commands.push(route); count += 1; } })();
  const transfers = new ArchiveTransfers(server, () => true, limits);
  cleanups.push(async () => { await transfers.close(); server.stop(); await Promise.all([served, routing]); });
  const next = async () => { await until(() => commands.length > 0); const command = commands.shift(); if (command === undefined) throw new Error("Missing archive command"); return command; };
  const finish = async (route: CommandRoute, scenario = "completed", contents: Uint8Array = new TextEncoder().encode("download archive")) => {
    const name = route.cmd.name;
    let data: unknown;
    if (name === "export_character") {
      const args = parseOperationInput(name, route.cmd.args);
      await writeFile(args.output, contents);
      data = { character: args.character, archive: args.output, bytes: contents.length, live: true, call_diagnostics: "included", external_memory: "rebuild_from_archived_segments" };
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

test("archive workers request an unselected session while ordinary local peers still select a sole character", async () => {
  const f = await fixture({}, true); const a = owner();
  const ordinary = await f.server.attachLocal({ clientType: "test", clientName: "Ordinary local client" });
  expect(ordinary.history.selectedCharacter).toBe("ada"); await ordinary.detach();
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); expect(route.meta.session.selectedCharacter).toBeNull();
  await f.finish(route); await until(() => f.transfers.get(a.session, info.id).downloadable);
});

test("uploads belong to the sign-in, use private controlled paths and import once through the session dispatcher", async () => {
  const f = await fixture(); const a = owner(); const b = owner();
  const info = await f.transfers.upload(a.session, upload("exact uploaded bytes", { "x-shore-filename": encodeURIComponent("C:\\fakepath\\../../<img onerror=alert(1)>.tar.gz") }));
  expect(info.filename).toBe("<img onerror=alert(1)>.tar.gz");
  expect(info.phase).toBe("ready"); expect(info.bytes).toBe(20);
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
  expect(f.transfers.list(b.session).archives).toEqual([]);
  expect(() => f.transfers.get(b.session, info.id)).toThrow("missing or expired");
  expect(() => f.transfers.import(b.session, info.id)).toThrow("missing or expired");
  expect(f.transfers.remove(b.session, info.id)).rejects.toThrow("missing or expired");
  expect(f.transfers.download(b.session, info.id, upload())).rejects.toThrow("missing or expired");
  expect(f.transfers.import(a.session, info.id).phase).toBe("importing");
  expect(f.transfers.import(a.session, info.id).phase).toBe("importing");
  expect(f.transfers.remove(a.session, info.id)).rejects.toThrow("active transfer");
  const route = await f.next();
  const args = parseOperationInput("import_character", route.cmd.args);
  expect(args.archive).toMatch(/\/shore-web-archive-[^/]+\/archive\.tar\.gz$/);
  expect(args.archive).not.toContain(info.filename);
  expect(await readFile(args.archive, "utf8")).toBe("exact uploaded bytes");
  expect((await stat(args.archive)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(args.archive))).mode & 0o777).toBe(0o700);
  expect(route.meta).toMatchObject({ kind: "command", rid: `archive-${info.id}`, session: { clientType: "web", archiveLimits: { bytes: 256 * 1024 * 1024, entries: 20_000 } } });
  await f.finish(route);
  await until(() => f.transfers.get(a.session, info.id).phase === "imported" && f.transfers.activePeers === 0);
  expect(f.transfers.import(a.session, info.id).phase).toBe("imported");
  expect(f.count()).toBe(1);
  expect(f.transfers.get(a.session, info.id).result).toMatchObject({ name: "import_character", data: { character: "ada", imported: true } });
  expect(access(dirname(args.archive))).rejects.toThrow();
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
});

test.each(["invalid", "missing", "wrong-name", "duplicate", "cancelled", "failed"])("%s import response keeps a terminal outcome without replaying a mutation", async (scenario) => {
  const f = await fixture(); const a = owner();
  const info = await f.transfers.upload(a.session, upload());
  f.transfers.import(a.session, info.id);
  const route = await f.next(); await f.finish(route, scenario);
  const phase = scenario === "failed" ? "failed" : "uncertain";
  await until(() => f.transfers.get(a.session, info.id).phase === phase && f.transfers.activePeers === 0);
  expect(f.transfers.get(a.session, info.id).error?.length).toBeGreaterThan(0);
  expect(f.transfers.import(a.session, info.id).phase).toBe(phase);
  expect(f.count()).toBe(1);
  expect(access(parseOperationInput("import_character", route.cmd.args).archive)).rejects.toThrow();
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
});

test("a timed-out import is uncertain, releases its worker and is not repeated", async () => {
  const f = await fixture({ operationMs: 80 }); const a = owner();
  const info = await f.transfers.upload(a.session, upload());
  f.transfers.import(a.session, info.id); await f.next();
  expect(() => f.transfers.export(a.session, "ada")).toThrow("Another archive operation");
  await until(() => f.transfers.get(a.session, info.id).phase === "uncertain" && f.transfers.activePeers === 0);
  expect(f.transfers.import(a.session, info.id).phase).toBe("uncertain");
  expect(f.count()).toBe(1); expect(f.server.sessionRouter.sessions()).toHaveLength(0);
});

test("export downloads are owned attachments, retry after interruption and remove artifacts after completion", async () => {
  const f = await fixture(); const a = owner(); const b = owner();
  const bytes = new Uint8Array(200_000).fill(51);
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); await f.finish(route, "completed", bytes);
  await until(() => f.transfers.get(a.session, info.id).downloadable);
  expect(f.transfers.download(b.session, info.id, upload())).rejects.toThrow("missing or expired");
  const first = await f.transfers.download(a.session, info.id, upload());
  const reader = first.body?.getReader();
  if (reader === undefined) throw new Error("Missing download stream");
  const chunk: unknown = (await reader.read()).value;
  if (!(chunk instanceof Uint8Array)) throw new Error("Missing archive download bytes");
  expect(chunk.length).toBe(64 * 1024);
  expect(f.transfers.download(a.session, info.id, upload())).rejects.toThrow("not ready");
  expect(f.transfers.remove(a.session, info.id)).rejects.toThrow("active transfer");
  await reader.cancel();
  const response = await f.transfers.download(a.session, info.id, upload());
  expect(response.headers.get("content-type")).toBe("application/gzip");
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  expect(response.headers.get("content-disposition")).toContain("ada.shore.tar.gz");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  await until(() => f.transfers.list(a.session).archives.length === 0);
  expect(access(parseOperationInput("export_character", route.cmd.args).output)).rejects.toThrow();
});

test("download refuses substituted links and changed files and releases its download claim", async () => {
  const f = await fixture(); const a = owner();
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); await f.finish(route);
  await until(() => f.transfers.get(a.session, info.id).downloadable);
  const path = parseOperationInput("export_character", route.cmd.args).output;
  const target = join(dirname(path), "private.txt"); await writeFile(target, "private contents");
  await rm(path); await symlink(target, path);
  expect(f.transfers.download(a.session, info.id, upload())).rejects.toThrow();
  await rm(path); await writeFile(path, "changed");
  expect(f.transfers.download(a.session, info.id, upload())).rejects.toThrow("Archive changed");
  await writeFile(path, "download archive"); await chmod(path, 0o600);
  expect(await (await f.transfers.download(a.session, info.id, upload())).text()).toBe("download archive");
});

test("uploads enforce declared and streamed byte limits, valid filenames, content type and nonempty complete bodies", async () => {
  const f = await fixture({ uploadBytes: 16 }); const a = owner();
  for (const request of [upload("", {}), upload("short", { "content-length": "10" }), upload("x", { "content-type": "text/plain" }), upload("x", { "x-shore-filename": "%ZZ" }), upload("x", { "x-shore-filename": "%00bad" })]) {
    expect(f.transfers.upload(a.session, request)).rejects.toThrow();
  }
  expect(f.transfers.upload(a.session, upload("x", { "content-length": "17" }))).rejects.toThrow("size limit");
  expect(f.transfers.upload(a.session, upload(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(7)); controller.close(); } })))).rejects.toThrow("size limit");
  await until(() => f.transfers.list(a.session).archives.length === 0);
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
});

test("unfinished uploads cannot import, reserve capacity and release it on abort", async () => {
  const f = await fixture({ uploadBytes: 16, totalBytes: 16 }); const a = owner(); const controller = new AbortController();
  let cancelled = false;
  const pending = f.transfers.upload(a.session, upload(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }), {}, controller.signal));
  const outcome = pending.catch((error: unknown) => error);
  await until(() => f.transfers.list(a.session).archives.length === 1);
  const info = f.transfers.list(a.session).archives.at(0);
  if (info === undefined) throw new Error("Missing pending upload");
  expect(f.transfers.import(a.session, info.id).phase).toBe("uploading");
  expect(f.transfers.remove(a.session, info.id)).rejects.toThrow("active transfer");
  expect(f.transfers.upload(a.session, upload("next"))).rejects.toThrow("capacity");
  controller.abort(); expect(await outcome).toBeInstanceOf(Error); expect(cancelled).toBe(true);
  expect(f.transfers.list(a.session).archives).toEqual([]);
  expect((await f.transfers.upload(a.session, upload("next"))).phase).toBe("ready");
  expect(f.count()).toBe(0);
});

test.each(["expiry", "signout", "shutdown"])("%s removes completed artifacts and aborts active peers", async (reason) => {
  const f = await fixture(reason === "expiry" ? { lifetimeMs: 100 } : {}); const a = owner();
  const ready = f.transfers.export(a.session, "ada");
  const completed = await f.next(); await f.finish(completed);
  await until(() => f.transfers.get(a.session, ready.id).downloadable);
  const running = f.transfers.export(a.session, "ada");
  const pending = await f.next();
  if (reason === "signout") a.controller.abort();
  if (reason === "shutdown") await f.transfers.close();
  await until(() => f.transfers.list(a.session).archives.length === 0 && f.transfers.activePeers === 0);
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
  expect(() => f.transfers.get(a.session, running.id)).toThrow("missing or expired");
  for (const route of [completed, pending]) expect(access(dirname(parseOperationInput("export_character", route.cmd.args).output))).rejects.toThrow();
});

test("per-session and global artifact limits retain other owners and can be reclaimed", async () => {
  const f = await fixture({ perSession: 1, artifacts: 2 }); const a = owner(); const b = owner(); const c = owner();
  const first = await f.transfers.upload(a.session, upload());
  expect(f.transfers.upload(a.session, upload())).rejects.toThrow("capacity");
  await f.transfers.upload(b.session, upload());
  expect(f.transfers.upload(c.session, upload())).rejects.toThrow("capacity");
  await f.transfers.remove(a.session, first.id);
  expect((await f.transfers.upload(c.session, upload())).phase).toBe("ready");
  expect(f.transfers.list(b.session).archives).toHaveLength(1);
});

test("upload deadlines cancel a stalled body and exports exceeding download limits release their bytes", async () => {
  const f = await fixture({ uploadBytes: 16, totalBytes: 16, requestMs: 20 }); const a = owner();
  let cancelled = false;
  expect(f.transfers.upload(a.session, upload(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } })))).rejects.toThrow();
  await until(() => cancelled && f.transfers.list(a.session).archives.length === 0);
  const info = f.transfers.export(a.session, "ada"); const route = await f.next();
  await f.finish(route, "completed", new Uint8Array(17));
  await until(() => f.transfers.get(a.session, info.id).phase === "failed" && f.transfers.activePeers === 0);
  expect(f.transfers.get(a.session, info.id).error).toContain("download size limit");
  expect(f.transfers.get(a.session, info.id).downloadable).toBe(false);
  expect(access(dirname(parseOperationInput("export_character", route.cmd.args).output))).rejects.toThrow();
  expect((await f.transfers.upload(a.session, upload("reclaimed"))).phase).toBe("ready");
});

test("signout interrupts a download and shutdown waits for its file cleanup", async () => {
  const f = await fixture(); const a = owner();
  const info = f.transfers.export(a.session, "ada"); const route = await f.next();
  await f.finish(route, "completed", new Uint8Array(200_000));
  await until(() => f.transfers.get(a.session, info.id).downloadable);
  const response = await f.transfers.download(a.session, info.id, upload());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Missing download stream");
  await reader.read(); a.controller.abort();
  expect(reader.read()).rejects.toThrow("interrupted");
  await f.transfers.close();
  expect(f.transfers.list(a.session).archives).toEqual([]);
  expect(access(dirname(parseOperationInput("export_character", route.cmd.args).output))).rejects.toThrow();
});

test("HTTP archive endpoints authenticate and enforce origin before attaching a bounded worker alongside a browser", async () => {
  const f = await fixture();
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
  await until(() => f.server.sessionRouter.sessions().length === 1);
  expect((await (await post(`/archives/${info.id}/status`, cookie)).json() as { phase: string }).phase).toBe("imported");
  expect((await post(`/archives/${info.id}/import`, cookie)).status).toBe(200);
  expect(f.count()).toBe(1);
  expect((await post("/logout", cookie)).status).toBe(204);
  expect((await post(`/archives/${info.id}/status`, cookie)).status).toBe(401);
});
