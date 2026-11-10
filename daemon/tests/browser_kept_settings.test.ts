import { afterEach, expect, test } from "bun:test";
import { daemonSettings, KeptSettings, type SettingsKeeper } from "../src/browser/kept_settings.ts";
import { outcomeOf } from "./support/outcome.ts";

const KEYS = { everywhere: ["shore.theme", "shore.vim-mode"], perBrowser: ["shore.notify"] };

function browser(stored: Record<string, string> = {}) {
  const values = new Map(Object.entries(stored));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function daemon(kept: Record<string, string> = {}) {
  const state = { kept: { ...kept }, saves: [] as Record<string, string>[], lists: 0, down: false, hold: undefined as Promise<void> | undefined };
  const keeper: SettingsKeeper = {
    list: async () => { state.lists += 1; if (state.down) throw new Error("daemon is down"); return await Promise.resolve({ ...state.kept }); },
    save: async (values) => {
      state.saves.push(values);
      await state.hold;
      if (state.down) throw new Error("daemon is down");
      Object.assign(state.kept, values);
    },
  };
  return { state, keeper };
}

const settle = async () => { await Bun.sleep(1); };

test("a browser that has never seen the settings takes the daemon's, and says so once", async () => {
  const local = browser({ "shore.other": "mine" });
  const { state, keeper } = daemon({ "shore.theme": "fog", "shore.vim-mode": "true", "shore.notify": "true", "shore.other": "theirs", "shore.unknown": "x" });
  let changed = 0;
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => { changed += 1; });
  await kept.sync();
  expect(Object.fromEntries(local.values)).toEqual({ "shore.theme": "fog", "shore.vim-mode": "true", "shore.notify": "true", "shore.other": "mine" });
  expect([changed, state.saves]).toEqual([1, []]);
  await kept.sync();
  expect([changed, state.lists, state.saves], "nothing differs the second time").toEqual([1, 2, []]);
});

test("a setting changed elsewhere replaces this browser's, except the ones each browser chooses for itself", async () => {
  const local = browser({ "shore.theme": "default", "shore.notify": "false" });
  const { state, keeper } = daemon({ "shore.theme": "fog", "shore.notify": "true" });
  let changed = 0;
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => { changed += 1; });
  await kept.sync();
  expect(Object.fromEntries(local.values)).toEqual({ "shore.theme": "fog", "shore.notify": "false" });
  expect([changed, state.saves, state.kept]).toEqual([1, [], { "shore.theme": "fog", "shore.notify": "true" }]);
  local.values.set("shore.theme", "fog");
  state.kept["shore.notify"] = "false";
  await kept.sync();
  expect(changed, "a per-browser setting that already matches or differs is left alone").toBe(1);
});

test("what this browser has and the daemon lacks is handed to the daemon, in one save", async () => {
  const local = browser({ "shore.theme": "fog", "shore.notify": "true", "shore.other": "mine" });
  const { state, keeper } = daemon({ "shore.vim-mode": "true" });
  let changed = 0;
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => { changed += 1; });
  await kept.sync();
  expect(state.saves).toEqual([{ "shore.theme": "fog", "shore.notify": "true" }]);
  expect(local.values.get("shore.vim-mode")).toBe("true");
  expect(changed).toBe(1);
  const settled = new KeptSettings(browser({ "shore.theme": "fog" }), KEYS, daemon({ "shore.theme": "fog" }).keeper, () => true, () => { changed += 1; });
  await settled.sync();
  expect(changed, "matching settings change nothing").toBe(1);
});

test("a changed setting is stored here and sent to the daemon; settings the daemon doesn't keep stay here", async () => {
  const local = browser();
  const { state, keeper } = daemon();
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => {});
  kept.setItem("shore.theme", "fog");
  kept.setItem("shore.notify", "true");
  kept.setItem("shore.draft.v1.x", "words");
  kept.wrote("shore.vim-mode", "true");
  kept.wrote("shore.device-address", "box:7340");
  expect([kept.getItem("shore.theme"), kept.getItem("shore.draft.v1.x"), kept.getItem("shore.vim-mode"), kept.getItem("shore.nothing")]).toEqual(["fog", "words", null, null]);
  await settle();
  expect(state.kept).toEqual({ "shore.theme": "fog", "shore.notify": "true", "shore.vim-mode": "true" });
  expect(state.saves.every((save) => !("shore.draft.v1.x" in save) && !("shore.device-address" in save))).toBe(true);
  const sent = state.saves.length;
  await kept.sync();
  expect(state.saves.length, "nothing is sent twice").toBe(sent);
});

test("a setting this browser couldn't store isn't sent either", async () => {
  const { state, keeper } = daemon();
  const kept = new KeptSettings({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, KEYS, keeper, () => true, () => {});
  expect(() => { kept.setItem("shore.theme", "fog"); }).toThrow("quota");
  await settle();
  expect(state.saves).toEqual([]);
});

test("a change the daemon hasn't taken yet survives what the daemon still says, and is sent when the daemon is back", async () => {
  const local = browser({ "shore.theme": "default" });
  const { state, keeper } = daemon({ "shore.theme": "default", "shore.vim-mode": "false" });
  let changed = 0;
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => { changed += 1; });
  state.down = true;
  kept.setItem("shore.theme", "fog");
  await settle();
  expect(state.saves).toHaveLength(1);
  expect(await outcomeOf(kept.sync())).toThrow("daemon is down");
  await settle();
  state.down = false;
  const failedSaves = state.saves.length;
  await kept.sync();
  expect(local.values.get("shore.theme"), "the daemon's older value didn't replace the unsent change").toBe("fog");
  expect(local.values.get("shore.vim-mode")).toBe("false");
  expect(state.saves.slice(failedSaves)).toEqual([{ "shore.theme": "fog" }]);
  expect([state.kept["shore.theme"], changed]).toEqual(["fog", 1]);
});

test("a setting changed again while its save is on the way is sent again with the newer value", async () => {
  const local = browser();
  const { state, keeper } = daemon();
  const kept = new KeptSettings(local, KEYS, keeper, () => true, () => {});
  let release = () => {};
  state.hold = new Promise((resolve) => { release = resolve; });
  kept.setItem("shore.theme", "fog");
  kept.setItem("shore.vim-mode", "true");
  await settle();
  kept.setItem("shore.theme", "default");
  state.hold = undefined;
  release();
  await settle();
  expect(state.saves).toEqual([{ "shore.theme": "fog", "shore.vim-mode": "true" }, { "shore.theme": "default" }]);
  expect(state.kept).toEqual({ "shore.theme": "default", "shore.vim-mode": "true" });
  await kept.sync();
  expect(state.saves).toHaveLength(2);
});

test("syncs and saves take turns, so a sync that started first finishes before a later change is sent", async () => {
  const local = browser();
  const order: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const kept = new KeptSettings(local, KEYS, {
    list: async () => { order.push("list"); await held; order.push("listed"); return { "shore.vim-mode": "true" }; },
    save: async (values) => { order.push(`save ${Object.keys(values).join(",")}`); await Promise.resolve(); },
  }, () => true, () => {});
  const syncing = kept.sync();
  await settle();
  kept.setItem("shore.theme", "fog");
  await settle();
  expect(order).toEqual(["list"]);
  release();
  await syncing;
  await settle();
  expect(order).toEqual(["list", "listed", "save shore.theme"]);
});

test("nothing is asked or sent while the page isn't connected, and what changed meanwhile is sent once it is", async () => {
  const local = browser({ "shore.vim-mode": "true" });
  const { state, keeper } = daemon({ "shore.theme": "fog" });
  let connected = false;
  let changed = 0;
  const kept = new KeptSettings(local, KEYS, keeper, () => connected, () => { changed += 1; });
  kept.setItem("shore.notify", "true");
  await kept.sync();
  expect([state.lists, state.saves, changed, local.values.get("shore.theme")]).toEqual([0, [], 0, undefined]);
  connected = true;
  await kept.sync();
  expect([state.lists, state.saves, changed, local.values.get("shore.theme")]).toEqual([1, [{ "shore.notify": "true", "shore.vim-mode": "true" }], 1, "fog"]);
  connected = false;
  kept.setItem("shore.theme", "default");
  await settle();
  expect(state.saves).toHaveLength(1);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answering(respond: (path: string, init: RequestInit) => Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (path: string, init: RequestInit = {}) => { calls.push({ path, init }); return await Promise.resolve(respond(path, init)); }) as unknown as typeof fetch;
  return calls;
}

test("the page asks its own daemon for the settings and posts the ones to keep, with its sign-in and a time limit", async () => {
  const calls = answering(() => Response.json({ values: { "shore.theme": "fog" } }));
  expect(await daemonSettings.list()).toEqual({ "shore.theme": "fog" });
  await daemonSettings.save({ "shore.vim-mode": "true" });
  expect(calls.map((call) => [call.path, call.init.method, call.init.credentials, call.init.redirect, call.init.cache, call.init.body, call.init.headers])).toEqual([
    ["/api/preferences/list", "POST", "same-origin", "error", "no-store", undefined, undefined],
    ["/api/preferences", "POST", "same-origin", "error", "no-store", JSON.stringify({ values: { "shore.vim-mode": "true" } }), { "content-type": "application/json" }],
  ]);
  expect(calls.every((call) => call.init.signal instanceof AbortSignal && !call.init.signal.aborted)).toBe(true);
});

test("the request gives up after ten seconds", async () => {
  const limits: number[] = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms: number) => { limits.push(ms); return original(ms); };
  try {
    answering(() => Response.json({ values: {} }));
    await daemonSettings.list();
  } finally { AbortSignal.timeout = original; }
  expect(limits).toEqual([10_000]);
});

test("a daemon that refuses, or answers with something else, is an error the page can show", async () => {
  answering(() => Response.json({ code: "unauthorized", message: "Sign in" }, { status: 401 }));
  expect(await outcomeOf(daemonSettings.list())).toThrow("The daemon didn’t take or return this page’s settings.");
  expect(await outcomeOf(daemonSettings.save({}))).toThrow("The daemon didn’t take or return this page’s settings.");
  await settle();
  answering(() => Response.json({ contract: "c1", protocol: 2 }));
  expect(await outcomeOf(daemonSettings.list())).toThrow("The daemon sent settings this page can’t read. Reload the page.");
  await settle();
  answering(() => Response.json({ values: { "shore.theme": 4 } }));
  expect(await outcomeOf(daemonSettings.list())).toThrow("The daemon sent settings this page can’t read. Reload the page.");
});
