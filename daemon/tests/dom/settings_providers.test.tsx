import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };
const CHECKED = "2026-11-28T02:31:00Z";
const RESETS = "2026-12-02T02:59:00Z";
const FETCHED = "2026-11-27T21:23:00Z";
const NO_CACHE = { present: false, models: 0, visible: 0, hidden: 0, fetched_at: null };
const limit = (cost: number, period: string, spent: number, reached = false) => ({ cost_usd: cost, period, spent_usd: spent, at_limit: reached, resets_at: RESETS });

const key = (name: string, extra: Record<string, unknown> = {}) => ({
  name, kind: "api_key", enabled: true, standing: "works", detail: null, hint: "…-key", env: null, checked_at: null, pinned: false, in_use: false, warn_on_fallback: false,
  limit: null, usage: null, windows: [], ...extra,
});
const login = (name: string, extra: Record<string, unknown> = {}) => key(name, { kind: "login", hint: name, plan: "pro", ...extra });
const window = (label: string, used: number, extra: Record<string, unknown> = {}) => ({ window: label, label, percent_used: used, resets_at: null, limit: 1, limit_set: false, at_limit: false, ...extra });
const provider = (name: string, extra: Record<string, unknown> = {}) => ({
  name, enabled: true, sdk: "openai", base_url: null, discovery_enabled: false, keys: [], ignore_models: [], subscription: false, no_auth: false,
  selection: "order", pinned: null, credentials: [], cache: NO_CACHE, ...extra,
});
const claude = (credentials: unknown[], extra: Record<string, unknown> = {}) => provider("claude_agent", { sdk: "claude_agent", selection: "room", credential_kind: "login", credentials, ...extra });

let providers: unknown[] = [];
const changed = (args: Record<string, unknown>, message: string) => ({ provider: providers.find((item) => (item as { name: string }).name === args["provider"]), message, file: "/srv/shore/config.toml" });
const lists = () => app.socket().sent.filter((request) => request["name"] === "list_providers").length;

function serve(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  app.answer((request) => {
    const name = String(request["name"]);
    const own = overrides[name];
    if (own !== undefined) return own(request["args"] as Record<string, unknown>);
    if (name === "list_providers") return { providers };
    if (name === "provider_presets") return { presets: [], sdks: ["openai", "anthropic", "claude_agent"] };
    return undefined;
  });
}

async function toastSpy() {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  return () => shown.mock.calls.map(([text, tone]) => [text, tone ?? "info"]);
}

async function page() {
  const { ProvidersPage } = await import("../../src/browser/settings/Providers.tsx");
  const view = await mount(<ProvidersPage state={app.state().workspace.getSnapshot()} />);
  await settle();
  return view;
}

async function formats() { return await import("../../src/browser/settings/shared.tsx"); }

const card = (root: ParentNode, name: string) => {
  const found = [...root.querySelectorAll(".provider")].find((item) => item.querySelector(".provider-title .setting-label")?.textContent === name);
  if (found === undefined) throw new Error(`no provider ${name}`);
  return found;
};
const row = (root: ParentNode, name: string) => {
  const found = [...root.querySelectorAll("li.credential")].find((item) => item.querySelector(".credential-title .mono")?.textContent === name);
  if (found === undefined) throw new Error(`no credential ${name}`);
  return found;
};
const pill = (part: Element) => {
  const found = part.querySelector(".status-pill");
  return [found?.textContent, found?.classList[1] ?? null];
};
const head = (part: Element) => [part.querySelector(".provider-title .setting-description")?.textContent, ...pill(part.querySelector(".provider-head") ?? part), part.classList.contains("disabled")];
const facts = (part: Element) => [...part.querySelectorAll(":scope > .kv .kv-row")].map((item) => [item.querySelector("dt")?.textContent, item.querySelector("dd")?.textContent]);
const footer = (part: Element) => [...part.querySelectorAll(":scope > .actions-row button")].map((item) => item.textContent);
const listName = (part: Element) => part.querySelector(".credential-list")?.getAttribute("aria-label") ?? null;
const shown = (part: Element) => [
  [...part.querySelectorAll(".credential-title .tag")].map((item) => item.textContent),
  [...part.querySelectorAll(".credential-main > .setting-description")].map((item) => item.textContent),
  ...pill(part),
  [...part.querySelectorAll(".actions-row button")].map((item) => item.getAttribute("aria-label") ?? item.textContent),
  part.classList.contains("disabled"),
];
const dialog = (root: ParentNode) => root.querySelector("dialog");
const dialogTitle = (root: ParentNode) => dialog(root)?.querySelector("h2")?.textContent ?? null;
const named = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);

type MenuEntry = "—" | (string | boolean | null | undefined)[];

async function menu(part: Element, name: string): Promise<MenuEntry[]> {
  const trigger = button(part, `Actions for ${name}`);
  await click(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  const items = [...list?.children ?? []].map((item) => item.getAttribute("role") === "separator" ? "—" : [
    item.querySelector(".menu-label")?.textContent, item.querySelector(".menu-description")?.textContent ?? null, (item as HTMLButtonElement).disabled, item.classList.contains("danger"),
  ]);
  await click(trigger);
  return items;
}

async function choose(part: Element, name: string, label: string) {
  await click(button(part, `Actions for ${name}`));
  const item = [...document.querySelectorAll("[role=menuitem]")].find((each) => each.querySelector(".menu-label")?.textContent === label);
  if (item === undefined) throw new Error(`no menu item ${label}`);
  await click(item);
  await settle();
}

async function release(name: string, data: unknown) {
  const held = app.socket().sent.filter((request) => request["name"] === name).at(-1);
  await acting(() => {
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name, data });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
  });
  await settle();
}

async function submit(root: ParentNode) {
  await acting(async () => { dialog(root)?.querySelector("form")?.requestSubmit(); await Bun.sleep(5); });
}

describe("the providers page", () => {
  test("says of each provider whether it can be used, what it picks, how it finds models and what each key or login is doing", async () => {
    const { formatCost, formatNumber, formatTime } = await formats();
    providers = [
      provider("fixture", {
        base_url: "http://models.test/v1", discovery_enabled: true, ignore_models: ["vendor/*"], cache: { present: true, models: 3, visible: 2, hidden: 1, fetched_at: FETCHED },
        credentials: [
          key("default", { kind: "env", env: "FIXTURE_KEY", standing: "not_checked", in_use: true }),
          key("spare", { usage: { cost_usd: 1.5, calls: 1234, since: CHECKED }, limit: limit(5, "month", 1.5), checked_at: CHECKED }),
        ],
      }),
      claude([
        login("work", { pinned: true, in_use: true, windows: [window("session", 0.27, { resets_at: RESETS }), window("weekly", 0.84, { limit: 0.9, limit_set: true, at_limit: true })] }),
        login("home", { standing: "over_quota", detail: "weekly limit reached", enabled: false, plan: undefined, hint: "home@example.com" }),
      ], { pinned: "work", selection_detail: "pinned to work", discovery_enabled: true }),
      provider("local", { no_auth: true, sdk: "anthropic" }),
      provider("off", { enabled: false, discovery_enabled: true, credentials: [key("main")] }),
      provider("missing", { credentials: [key("ci", { kind: "env", env: "CI_KEY", hint: null, standing: "missing", detail: "CI_KEY is not set on the daemon" })] }),
      provider("rejected", { credentials: [key("bad", { standing: "invalid", detail: "rejected: HTTP 401" }), key("old", { standing: "invalid", detail: "REJECTED" })] }),
      provider("idle", { credentials: [key("parked", { enabled: false, detail: "ok" })] }),
      provider("credit", { credentials: [key("spent", { standing: "over_quota", detail: "out of credit", limit: limit(5, "day", 5, true) })] }),
      claude([login("gone", { standing: "signed_out", detail: "the saved sign-in expired", plan: undefined })], { name: "lapsed" }),
    ];
    serve();
    const view = await page();
    expect(dialog(view.host), "nothing is open yet").toBeNull();
    const cards = ["fixture", "claude_agent", "local", "off", "missing", "rejected", "idle", "credit", "lapsed"].map((name) => card(view.host, name));
    expect(cards.map(head)).toEqual([
      ["openai · http://models.test/v1", "Ready", "ok", false], ["claude_agent", "Ready", "ok", false], ["anthropic", "Ready", "ok", false], ["openai", "Disabled", "off", true],
      ["openai", "No working key", "warn", false], ["openai", "No working key", "warn", false], ["openai", "No working key", "warn", false], ["openai", "Ready", "ok", false], ["claude_agent", "Not signed in", "warn", false],
    ]);
    const [fixture, agent, local, off, , , , , lapsed] = cards as [Element, Element, Element, Element, Element, Element, Element, Element, Element];
    expect([facts(fixture), facts(agent), facts(local), facts(off), facts(lapsed)]).toEqual([
      [["Uses", "The first key that works, in this order"], ["Model discovery", `2 models (1 hidden), refreshed ${formatTime(FETCHED)}`], ["Ignored models", "vendor/*"]],
      [["Uses", "Only work"], ["Right now", "pinned to work"], ["Model discovery", "On, not refreshed yet"]],
      [["Uses", "No key"], ["Model discovery", "Off"]],
      [["Uses", "The first key that works, in this order"], ["Model discovery", "On, not refreshed yet"]],
      [["Uses", "A login with room, preferring the week that resets soonest"], ["Model discovery", "Off"]],
    ]);
    expect(cards.map(listName)).toEqual(["fixture keys", "claude_agent logins", null, "off keys", "missing keys", "rejected keys", "idle keys", "credit keys", "lapsed logins"]);
    expect([footer(fixture), footer(agent), footer(local), footer(off), footer(lapsed)]).toEqual([
      ["Add key", "Show models", "Refresh models"], ["Sign in a login", "Show models", "Refresh models"], ["Show models"], ["Add key", "Show models"], ["Sign in a login", "Show models"],
    ]);

    expect([
      shown(row(fixture, "default")), shown(row(fixture, "spare")), shown(row(agent, "work")), shown(row(agent, "home")), shown(row(view.host, "ci")),
      shown(row(view.host, "bad")), shown(row(view.host, "old")), shown(row(view.host, "parked")), shown(row(view.host, "spent")), shown(row(lapsed, "gone")),
    ]).toEqual([
      [["In use"], ["$FIXTURE_KEY …-key", ""], "Not checked yet", "off", ["Test", "Actions for default"], false],
      [[], ["Saved on the daemon …-key", `${formatCost(1.5)} in the last 30 days, ${formatNumber(1234)} calls · Limit ${formatCost(5)} a month: ${formatCost(1.5)} spent · Checked ${formatTime(CHECKED)}`], "Works", "ok", ["Test", "Actions for spare"], false],
      [["In use", "Pinned"], ["Claude login · pro", `Session 27%, resets ${formatTime(RESETS)}`, "Week 84%, limit 90%, reached", ""], "Works", "ok", ["Check", "Actions for work"], false],
      [["Disabled"], ["Claude login · home@example.com", ""], "At a limit", "warn", ["Check", "Actions for home"], true],
      [[], ["$CI_KEY", "CI_KEY is not set on the daemon", ""], "Missing", "warn", ["Test", "Actions for ci"], false],
      [[], ["Saved on the daemon …-key", "rejected: HTTP 401", ""], "Rejected", "warn", ["Test", "Actions for bad"], false],
      [[], ["Saved on the daemon …-key", ""], "Rejected", "warn", ["Test", "Actions for old"], false],
      [["Disabled"], ["Saved on the daemon …-key", ""], "Works", "ok", ["Test", "Actions for parked"], true],
      [[], ["Saved on the daemon …-key", "out of credit", `Limit ${formatCost(5)} a day: ${formatCost(5)} spent, at the limit`], "Over quota", "warn", ["Test", "Actions for spent"], false],
      [[], ["Claude login", "the saved sign-in expired", ""], "Signed out", "warn", ["Sign in", "Actions for gone"], false],
    ]);
    await view.unmount();
  });

  test("a key's menu pins, unpins, reorders, disables and enables it, and opens its limit, rename, replace and remove dialogs", async () => {
    providers = [provider("fixture", { credentials: [key("first", { kind: "env", env: "FIRST_KEY" }), key("second", { pinned: true, limit: limit(5, "day", 0) }), key("third", { enabled: false })] })];
    const toasts = await toastSpy();
    serve({
      select_credential: (args) => changed(args, args["credential"] === null ? "picks automatically" : `uses only ${(args["credential"] as string)}`),
      order_credentials: (args) => changed(args, `order ${(args["order"] as string[]).join(",")}`),
      update_credential: (args) => changed(args, `${(args["credential"] as string)} ${args["enabled"] === true ? "on" : args["enabled"] === false ? "off" : "changed"}`),
      remove_credential: (args) => changed(args, `removed ${(args["credential"] as string)}`),
    });
    const view = await page();
    const fixture = card(view.host, "fixture");
    const [first, second, third] = ["first", "second", "third"].map((name) => row(fixture, name)) as [Element, Element, Element];
    expect([await menu(first, "first"), await menu(second, "second"), await menu(third, "third")]).toEqual([
      [["Use only this key", null, false, false], ["Move up", null, true, false], ["Move down", null, false, false], "—", ["Disable", null, false, false], ["Set a spending limit…", null, false, false], ["Rename…", null, false, false], "—", ["Remove…", null, false, true]],
      [["Pick keys automatically", "First that works, in order", false, false], ["Move up", null, false, false], ["Move down", null, false, false], "—", ["Disable", null, false, false], ["Change spending limit…", null, false, false], ["Rename…", null, false, false], ["Replace key…", null, false, false], "—", ["Remove…", null, false, true]],
      [["Use only this key", null, true, false], ["Move up", null, false, false], ["Move down", null, true, false], "—", ["Enable", null, false, false], ["Set a spending limit…", null, false, false], ["Rename…", null, false, false], ["Replace key…", null, false, false], "—", ["Remove…", null, false, true]],
    ]);

    const since = app.socket().sent.length;
    const listed = lists();
    await choose(first, "first", "Use only this key");
    await choose(second, "second", "Pick keys automatically");
    await choose(first, "first", "Move down");
    await choose(third, "third", "Move up");
    await choose(second, "second", "Disable");
    await choose(third, "third", "Enable");
    expect([named(since, "select_credential"), named(since, "order_credentials"), named(since, "update_credential")]).toEqual([
      [{ provider: "fixture", credential: "first" }, { provider: "fixture", credential: null }],
      [{ provider: "fixture", order: ["second", "first", "third"] }, { provider: "fixture", order: ["first", "third", "second"] }],
      [{ provider: "fixture", credential: "second", enabled: false }, { provider: "fixture", credential: "third", enabled: true }],
    ]);
    expect([lists() - listed, toasts()]).toEqual([6, [["uses only first", "info"], ["picks automatically", "info"], ["order second,first,third", "info"], ["order first,third,second", "info"], ["second off", "info"], ["third on", "info"]]]);

    for (const [part, name, item, title] of [
      [second, "second", "Change spending limit…", "Spending limit for second"], [first, "first", "Set a spending limit…", "Spending limit for first"], [second, "second", "Rename…", "Rename second"],
      [second, "second", "Replace key…", "Replace fixture key second"],
    ] as const) {
      await choose(part, name, item);
      expect(dialogTitle(view.host)).toBe(title);
      await click(button(dialog(view.host) ?? view.host, "Cancel"));
      expect(dialog(view.host)).toBeNull();
    }

    for (const [part, name, action, text] of [
      [first, "first", "Remove key", "fixture stops reading $FIRST_KEY; the variable itself stays set."], [second, "second", "Remove key", "fixture stops using this key and the daemon deletes its saved copy."],
    ] as const) {
      await choose(part, name, "Remove…");
      expect([dialogTitle(view.host), dialog(view.host)?.querySelector(".form-text")?.textContent, dialog(view.host)?.querySelector("button[type=submit]")?.textContent]).toEqual([`Remove ${name}?`, text, action]);
      const before = lists();
      await submit(view.host);
      expect([dialog(view.host), named(since, "remove_credential").at(-1), lists() - before, toasts().at(-1)]).toEqual([null, { provider: "fixture", credential: name }, 1, [`removed ${name}`, "info"]]);
    }
    await view.unmount();
  });

  test("a key's Test button says it is working until the provider answers", async () => {
    providers = [provider("fixture", { credentials: [key("spare")] })];
    const toasts = await toastSpy();
    serve({ test_credential: () => HOLD });
    const view = await page();
    const spare = row(view.host, "spare");
    const since = app.socket().sent.length;
    await click(button(spare, "Test"));
    expect([button(spare, "Working…").disabled, named(since, "test_credential")]).toEqual([true, [{ provider: "fixture", credential: "spare" }]]);
    const listed = lists();
    await release("test_credential", { provider: "fixture", credential: "spare", ok: true, standing: "works", detail: "2 models", model_count: 2 });
    expect([button(spare, "Test").disabled, toasts(), lists() - listed]).toEqual([false, [["spare: 2 models", "info"]], 1]);
    await view.unmount();
  });

  test("a login's menu pins and unpins it, takes it out of use and back, and opens its limits, sign-in, rename and remove dialogs", async () => {
    providers = [claude([
      login("work", { pinned: true, in_use: true }), login("home"), login("spare", { enabled: false }), login("gone", { standing: "signed_out" }), login("subscription", { enabled: false }),
    ], { pinned: "work" })];
    const toasts = await toastSpy();
    serve({
      select_credential: (args) => changed(args, args["credential"] === null ? "picks automatically" : `uses only ${(args["credential"] as string)}`),
      update_credential: (args) => changed(args, `${(args["credential"] as string)} ${args["enabled"] === true ? "on" : "off"}`),
      test_credential: (args) => ({ provider: "claude_agent", credential: args["credential"], ok: true, standing: "works", detail: "signed in", model_count: null }),
      remove_credential: (args) => changed(args, `removed ${(args["credential"] as string)}`),
    });
    const view = await page();
    const agent = card(view.host, "claude_agent");
    const [work, home, spare, gone, subscription] = ["work", "home", "spare", "gone", "subscription"].map((name) => row(agent, name)) as [Element, Element, Element, Element, Element];
    const end = (enabled: boolean): MenuEntry[] => ["—", [enabled ? "Disable" : "Enable", null, false, false]];
    const tail: MenuEntry[] = ["—", ["Remove…", null, false, true]];
    expect([await menu(work, "work"), await menu(home, "home"), await menu(spare, "spare"), await menu(gone, "gone"), await menu(subscription, "subscription")]).toEqual([
      [["Pick logins automatically", "One with room, whose week resets soonest", false, false], ["Set limits…", null, false, false], ["Sign in again…", null, false, false], ["Rename…", null, false, false], ...end(true), ...tail],
      [["Use only this login", null, false, false], ["Set limits…", null, false, false], ["Sign in again…", null, false, false], ["Rename…", null, false, false], ...end(true), ...tail],
      [["Use only this login", null, true, false], ["Set limits…", null, false, false], ["Sign in again…", null, false, false], ["Rename…", null, false, false], ...end(false), ...tail],
      [["Use only this login", null, true, false], ["Set limits…", null, false, false], ["Sign in again…", null, false, false], ["Rename…", null, false, false], ...end(true), ...tail],
      [["Use only this login", null, true, false], ["Set limits…", null, false, false], ["Sign in again…", null, false, false], ...end(false)],
    ]);

    const since = app.socket().sent.length;
    const listed = lists();
    await choose(work, "work", "Pick logins automatically");
    await choose(home, "home", "Use only this login");
    await choose(home, "home", "Disable");
    await choose(spare, "spare", "Enable");
    await click(button(home, "Check"));
    await settle();
    expect([named(since, "select_credential"), named(since, "update_credential"), named(since, "test_credential"), lists() - listed, toasts()]).toEqual([
      [{ provider: "claude_agent", credential: null }, { provider: "claude_agent", credential: "home" }],
      [{ provider: "claude_agent", credential: "home", enabled: false }, { provider: "claude_agent", credential: "spare", enabled: true }],
      [{ provider: "claude_agent", credential: "home" }], 5,
      [["picks automatically", "info"], ["uses only home", "info"], ["home off", "info"], ["spare on", "info"], ["home: signed in", "info"]],
    ]);

    for (const [part, name, item, title] of [[work, "work", "Set limits…", "Limits for work"], [home, "home", "Sign in again…", "Sign home in again"], [home, "home", "Rename…", "Rename home"]] as const) {
      await choose(part, name, item);
      expect(dialogTitle(view.host)).toBe(title);
      await click(button(dialog(view.host) ?? view.host, "Cancel"));
      expect(dialog(view.host)).toBeNull();
    }
    await click(button(gone, "Sign in"));
    expect(dialogTitle(view.host)).toBe("Sign gone in again");
    await click(button(dialog(view.host) ?? view.host, "Cancel"));

    await choose(home, "home", "Remove…");
    expect([dialogTitle(view.host), dialog(view.host)?.querySelector(".form-text")?.textContent, dialog(view.host)?.querySelector("button[type=submit]")?.textContent]).toEqual([
      "Remove home?", "claude_agent stops using this login. The daemon deletes its saved sign-in and moves the rest of its folder aside.", "Remove login",
    ]);
    await submit(view.host);
    expect([dialog(view.host), named(since, "remove_credential"), toasts().at(-1)]).toEqual([null, [{ provider: "claude_agent", credential: "home" }], ["removed home", "info"]]);
    await view.unmount();
  });

  test("a provider's own controls show its models, refresh them, change its settings, turn it off and on, add a key or login, and remove it", async () => {
    providers = [
      provider("fixture", { discovery_enabled: true, credentials: [key("spare")] }),
      provider("off", { enabled: false }),
      claude([login("work")]),
    ];
    const toasts = await toastSpy();
    let refreshing = false;
    serve({
      refresh_provider_models: () => refreshing ? HOLD : { provider: "fixture", model_count: 7, fetched_at: FETCHED, cache_path: "/srv/shore/models.json" },
      update_provider: (args) => changed(args, `${(args["provider"] as string)} ${args["enabled"] === true ? "on" : "off"}`),
      remove_provider: (args) => ({ provider: args["provider"], keys_removed: 0, limits_removed: 0, file: "/srv/shore/config.toml" }),
    });
    const view = await page();
    const fixture = card(view.host, "fixture");
    const off = card(view.host, "off");
    const agent = card(view.host, "claude_agent");
    const models = () => {
      const toggle = [...fixture.querySelectorAll(":scope > .actions-row button")].find((item) => item.hasAttribute("aria-expanded"));
      return [toggle?.textContent, toggle?.getAttribute("aria-expanded"), fixture.querySelector(".provider-models") !== null];
    };
    expect(models()).toEqual(["Show models", "false", false]);
    await click(button(fixture, "Show models"));
    expect(models()).toEqual(["Hide models", "true", true]);
    await click(button(fixture, "Hide models"));
    expect(models()).toEqual(["Show models", "false", false]);

    const since = app.socket().sent.length;
    let listed = lists();
    await click(button(fixture, "Refresh models"));
    await settle();
    expect([named(since, "refresh_provider_models"), lists() - listed, toasts().at(-1)]).toEqual([[{ provider: "fixture" }], 1, ["Found 7 models on fixture", "info"]]);
    refreshing = true;
    await click(button(fixture, "Refresh models"));
    expect(button(fixture, "Refreshing…").disabled).toBe(true);
    await release("refresh_provider_models", { provider: "fixture", model_count: 8, fetched_at: FETCHED, cache_path: "/srv/shore/models.json" });
    expect([button(fixture, "Refresh models").disabled, toasts().at(-1)]).toEqual([false, ["Found 8 models on fixture", "info"]]);

    expect([await menu(fixture, "fixture"), await menu(off, "off")]).toEqual([
      [["Settings…", null, false, false], ["Disable", null, false, false], "—", ["Remove…", null, false, true]],
      [["Settings…", null, false, false], ["Enable", null, false, false], "—", ["Remove…", null, false, true]],
    ]);
    await click(document.body);
    listed = lists();
    await choose(agent, "claude_agent", "Disable");
    await choose(off, "off", "Enable");
    expect([named(since, "update_provider"), lists() - listed, toasts().slice(-2)]).toEqual([
      [{ provider: "claude_agent", enabled: false }, { provider: "off", enabled: true }], 2, [["claude_agent off", "info"], ["off on", "info"]],
    ]);

    await choose(agent, "claude_agent", "Settings…");
    expect(dialogTitle(view.host)).toBe("claude_agent settings");
    await click(button(dialog(view.host) ?? view.host, "Cancel"));
    expect(dialog(view.host)).toBeNull();
    for (const [part, label, title] of [[agent, "Sign in a login", "Sign in a Claude login"], [off, "Add key", "Add a key to off"]] as const) {
      await click(button(part, label));
      expect(dialogTitle(view.host)).toBe(title);
      await click(button(dialog(view.host) ?? view.host, "Cancel"));
      expect(dialog(view.host)).toBeNull();
    }

    await choose(off, "off", "Remove…");
    expect([dialogTitle(view.host), dialog(view.host)?.querySelector("button[type=submit]")?.textContent]).toEqual(["Remove off?", "Remove provider"]);
    listed = lists();
    await submit(view.host);
    expect([dialog(view.host), named(since, "remove_provider"), lists() - listed, toasts().at(-1)]).toEqual([null, [{ provider: "off" }], 1, ["Removed off", "info"]]);
    await view.unmount();
  });
});
