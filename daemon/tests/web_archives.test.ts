import { afterEach, expect, test } from "bun:test";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
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
import { outcomeOf } from "./support/outcome.ts";

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
    handshake: { hello: async () => ({ characters: singleCharacter ? [{ name: "ada" }] : [] }), history: async (selectedCharacter) => ({ messages: [], previousSegment: null, config: {}, selectedCharacter, selectedThread: null, revision: 0 }) },
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

test("download refuses substituted links and changed files and releases its download claim", async () => {
  const f = await fixture(); const a = owner();
  const info = f.transfers.export(a.session, "ada");
  const route = await f.next(); await f.finish(route);
  await until(() => f.transfers.get(a.session, info.id).downloadable);
  const path = parseOperationInput("export_character", route.cmd.args).output;
  const target = join(dirname(path), "private.txt"); await writeFile(target, "private contents");
  await rm(path); await symlink(target, path);
  expect(await outcomeOf(f.transfers.download(a.session, info.id, upload()))).toThrow();
  await rm(path); await writeFile(path, "changed");
  expect(await outcomeOf(f.transfers.download(a.session, info.id, upload()))).toThrow("Archive changed");
  await writeFile(path, "download archive"); await chmod(path, 0o600);
  expect(await (await f.transfers.download(a.session, info.id, upload())).text()).toBe("download archive");
});

test("uploads enforce declared and streamed byte limits, valid filenames, content type and nonempty complete bodies", async () => {
  const f = await fixture({ uploadBytes: 16 }); const a = owner();
  for (const request of [upload("", {}), upload("short", { "content-length": "10" }), upload("x", { "content-type": "text/plain" }), upload("x", { "x-shore-filename": "%ZZ" }), upload("x", { "x-shore-filename": "%00bad" })]) {
    expect(await outcomeOf(f.transfers.upload(a.session, request))).toThrow();
  }
  expect(await outcomeOf(f.transfers.upload(a.session, upload("x", { "content-length": "17" })))).toThrow("size limit");
  expect(await outcomeOf(f.transfers.upload(a.session, upload(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(7)); controller.close(); } }))))).toThrow("size limit");
  await until(() => f.transfers.list(a.session).archives.length === 0);
  expect(f.server.sessionRouter.sessions()).toHaveLength(0);
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
