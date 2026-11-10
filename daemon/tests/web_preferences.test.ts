import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWebConfig } from "../src/config/app.ts";
import { Server } from "../src/swp/server.ts";
import { PREFERENCE_LIMITS } from "../src/web/preferences.ts";
import { startWebServer } from "../src/web/server.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOKEN = "web-preferences-test-token";

async function daemon(dataDir?: string) {
  const web = startWebServer({
    server: new Server({ addr: "127.0.0.1:0", serverName: "preferences", authenticate: () => true }),
    authenticate: (token) => token === TOKEN,
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" },
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  web.activate();
  cleanups.push(async () => { await web.stop(); });
  const post = (path: string, cookie: string, body?: string, type = "application/json") =>
    fetch(`${web.origin}${path}`, { method: "POST", headers: { origin: web.origin, cookie, ...(body === undefined ? {} : { "content-type": type }) }, ...(body === undefined ? {} : { body }) });
  const login = await post("/api/login", "", JSON.stringify({ token: TOKEN }));
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const answer = async (response: Response) => [response.status, await response.json()];
  return {
    post, cookie, origin: web.origin,
    list: async (as = cookie) => await answer(await post("/api/preferences/list", as)),
    save: async (values: unknown, as = cookie) => await answer(await post("/api/preferences", as, JSON.stringify({ values }))),
    stop: async () => { await web.stop(); },
  };
}

test("settings one browser saves are what every signed-in browser reads, and a later save changes only what it names", async () => {
  const d = await daemon();
  expect(await d.list()).toEqual([200, { values: {} }]);
  expect(await d.save({ "shore.theme": "fog", "shore.vim-mode": "true" })).toEqual([200, { values: { "shore.theme": "fog", "shore.vim-mode": "true" } }]);
  const other = (await d.post("/api/login", "", JSON.stringify({ token: TOKEN }))).headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  expect(other).not.toBe(d.cookie);
  expect(await d.save({ "shore.theme": "default", "shore.view.v1.metadata": "on" }, other)).toEqual([200, { values: { "shore.theme": "default", "shore.vim-mode": "true", "shore.view.v1.metadata": "on" } }]);
  expect(await d.list()).toEqual([200, { values: { "shore.theme": "default", "shore.vim-mode": "true", "shore.view.v1.metadata": "on" } }]);
  const listed = await d.post("/api/preferences/list", d.cookie);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect((await d.post("/api/preferences", d.cookie, JSON.stringify({ values: {} }))).headers.get("cache-control")).toBe("no-store");
});

test("saved settings outlast a daemon restart, and a daemon given no data directory keeps them only while it runs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "shore-web-preferences-"));
  const first = await daemon(dataDir);
  await first.save({ "shore.font-size": "large" });
  await first.save({ "shore.enter-sends": "false" });
  await first.stop();
  const second = await daemon(dataDir);
  expect(await second.list()).toEqual([200, { values: { "shore.font-size": "large", "shore.enter-sends": "false" } }]);
  const unsaved = await daemon();
  expect(await unsaved.list()).toEqual([200, { values: {} }]);
});

test("only a signed-in browser reads or saves settings", async () => {
  const d = await daemon();
  await d.save({ "shore.theme": "fog" });
  expect(await d.list("")).toEqual([401, { code: "unauthorized", message: "Sign in to connect to the daemon" }]);
  expect(await d.save({ "shore.theme": "default" }, "")).toEqual([401, { code: "unauthorized", message: "Sign in to connect to the daemon" }]);
  for (const path of ["/api/preferences/list", "/api/preferences"]) {
    const got = await fetch(`${d.origin}${path}`, { headers: { origin: d.origin, cookie: d.cookie } });
    expect([got.status, await got.json()], path).toEqual([404, { code: "not_found", message: "Unknown browser endpoint" }]);
  }
  expect(await d.list()).toEqual([200, { values: { "shore.theme": "fog" } }]);
});

test("a save the daemon can't keep is refused whole, with the reason, and leaves what was kept", async () => {
  const d = await daemon();
  await d.save({ "shore.theme": "fog" });
  const refused = async (response: Response) => [response.status, await response.json()];
  for (const key of ["theme", "other.theme", "shore.", "shore.-x", "shore.Theme", "shore.the me", `shore.${"a".repeat(65)}`, "shore.theme\n"]) {
    expect(await d.save({ "shore.font-size": "large", [key]: "x" }), key).toEqual([400, { code: "invalid_request", message: `${key} is not a setting the web UI keeps` }]);
  }
  expect(await d.save({ [`shore.${"a".repeat(64)}`]: "x", "shore.9.a-b": "y" })).toMatchObject([200, {}]);
  expect(await d.save({ "shore.folders.collapsed": "é".repeat(PREFERENCE_LIMITS.valueBytes / 2) })).toMatchObject([200, {}]);
  expect(await d.save({ "shore.folders.collapsed": `${"é".repeat(PREFERENCE_LIMITS.valueBytes / 2)}a` })).toEqual([400, { code: "invalid_request", message: "shore.folders.collapsed is too long to keep" }]);
  const room = PREFERENCE_LIMITS.keys - 4;
  const many = Object.fromEntries(Array.from({ length: room + 1 }, (_, index) => [`shore.extra-${String(index)}`, "1"]));
  expect(await d.save(many)).toEqual([400, { code: "invalid_request", message: "Too many web UI settings to keep" }]);
  const { [`shore.extra-${String(room)}`]: _dropped, ...fitting } = many;
  expect((await d.save(fitting))[0]).toBe(200);
  expect(Object.keys(((await d.list())[1] as { values: object }).values)).toHaveLength(PREFERENCE_LIMITS.keys);
  expect((await d.save({ "shore.theme": "default" }))[0], "a kept setting can still change when the daemon is full").toBe(200);
  for (const body of [JSON.stringify({}), JSON.stringify({ values: { "shore.theme": 1 } }), JSON.stringify({ values: {}, more: 1 }), JSON.stringify({ values: [] })]) {
    expect(await refused(await d.post("/api/preferences", d.cookie, body)), body).toEqual([400, { code: "invalid_request", message: "Supply the settings to keep" }]);
  }
  expect(await refused(await d.post("/api/preferences", d.cookie, "{not json"))).toEqual([400, { code: "invalid_request", message: "Invalid settings request" }]);
  expect(await refused(await d.post("/api/preferences", d.cookie, JSON.stringify({ values: {} }), "text/plain"))).toEqual([400, { code: "invalid_request", message: "Invalid settings request" }]);
  const huge = JSON.stringify({ values: { "shore.theme": "x".repeat(PREFERENCE_LIMITS.bodyBytes) } });
  expect(await refused(await d.post("/api/preferences", d.cookie, huge))).toEqual([413, { code: "invalid_request", message: "Request body is too large" }]);
  expect(JSON.stringify({ values: { "shore.theme": "x".repeat(PREFERENCE_LIMITS.bodyBytes - 100) } }).length).toBeLessThan(PREFERENCE_LIMITS.bodyBytes);
  expect(await refused(await d.post("/api/preferences", d.cookie, JSON.stringify({ values: { "shore.theme": "x".repeat(PREFERENCE_LIMITS.bodyBytes - 100) } })))).toEqual([400, { code: "invalid_request", message: "shore.theme is too long to keep" }]);
  expect(((await d.list())[1] as { values: Record<string, string> }).values["shore.theme"]).toBe("default");
});

test("a daemon whose storage fails says the settings weren't saved and keeps serving the last ones", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "shore-web-preferences-"));
  const d = await daemon(dataDir);
  await d.save({ "shore.theme": "fog" });
  await rm(dataDir, { recursive: true });
  await writeFile(dataDir, "not a directory");
  expect(await d.save({ "shore.theme": "default" })).toEqual([503, { code: "unavailable", message: "The daemon couldn’t save these settings" }]);
  expect(await d.list()).toEqual([200, { values: { "shore.theme": "fog" } }]);
});
