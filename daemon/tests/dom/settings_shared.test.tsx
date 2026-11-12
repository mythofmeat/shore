import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, renderHook } from "./dom.ts";

const app = useApp();

async function shared() { return await import("../../src/browser/settings/shared.tsx"); }

describe("loading a settings page's data", () => {
  test("runs the action once connected, again on refresh or when its inputs change, and not when switched off", async () => {
    const { useOperation } = await shared();
    let calls = 0;
    app.answer((request) => { if (request["name"] !== "list_characters") return undefined; calls += 1; return { characters: [{ name: `c${String(calls)}` }] }; });
    const snapshot = app.state().workspace.getSnapshot();
    const hook = await renderHook(({ enabled, extra }: { enabled: boolean; extra: number }) => useOperation(snapshot, "list_characters", {}, [extra], enabled), { enabled: true, extra: 0 });
    await acting(() => Bun.sleep(5));
    expect(hook.current()).toMatchObject({ data: { characters: [{ name: "c1" }] }, error: "", loading: false });
    await acting(async () => { hook.current().refresh(); await Bun.sleep(5); });
    expect(hook.current().data).toEqual({ characters: [{ name: "c2" }] });
    await hook.rerender({ enabled: true, extra: 1 });
    await acting(() => Bun.sleep(5));
    expect(calls).toBe(3);
    await hook.rerender({ enabled: false, extra: 2 });
    await acting(() => Bun.sleep(5));
    expect(calls, "switched off").toBe(3);
    await acting(async () => { await hook.current().reload(); });
    expect([calls, hook.current().data]).toEqual([4, { characters: [{ name: "c4" }] }]);
    await hook.unmount();
  });

  test("waits for the connection, shows loading meanwhile, reports a failure, and drops an answer that comes after it is gone", async () => {
    const { useOperation } = await shared();
    const snapshot = app.state().workspace.getSnapshot();
    const offline = await renderHook(() => useOperation({ ...snapshot, status: "reconnecting" }, "list_characters", {}, []), undefined);
    await acting(() => Bun.sleep(5));
    expect(offline.current()).toMatchObject({ data: undefined, loading: false });
    await offline.unmount();

    app.answer((request) => request["name"] === "list_characters" ? HOLD : undefined);
    const waiting = await renderHook(() => useOperation(snapshot, "list_characters", {}, []), undefined);
    expect(waiting.current().loading).toBe(true);
    await waiting.unmount();
    app.answer((request) => { if (request["name"] === "list_characters") throw new Error("no characters for you"); return undefined; });
    const failing = await renderHook(() => useOperation(snapshot, "list_characters", {}, []), undefined);
    await acting(() => Bun.sleep(5));
    expect(failing.current()).toMatchObject({ error: "no characters for you", loading: false });
    app.answer((request) => request["name"] === "list_characters" ? { characters: [] } : undefined);
    await acting(async () => { await failing.current().reload(); });
    expect(failing.current().error, "a successful reload clears the error").toBe("");
    await failing.unmount();

    app.answer(() => HOLD);
    const before = app.socket().sent.length;
    const leaving = await renderHook(() => useOperation(snapshot, "list_characters", {}, []), undefined);
    const rid = app.sent(before).find((request) => request["name"] === "list_characters")?.["rid"];
    const renders = leaving.renders();
    await leaving.unmount();
    app.socket().receive({ type: "command_output", rid, name: "list_characters", data: { characters: [] } });
    app.socket().receive({ type: "request_finished", rid, outcome: "completed" });
    await acting(() => Bun.sleep(5));
    expect(leaving.renders()).toBe(renders);
  });

  test("an older answer that arrives after a newer request was made is dropped", async () => {
    const { useOperation } = await shared();
    const snapshot = app.state().workspace.getSnapshot();
    app.answer((request) => request["name"] === "list_characters" ? HOLD : undefined);
    const before = app.socket().sent.length;
    const hook = await renderHook(({ extra }: { extra: number }) => useOperation(snapshot, "list_characters", {}, [extra]), { extra: 0 });
    await hook.rerender({ extra: 1 });
    const [older, newer] = app.sent(before).filter((request) => request["name"] === "list_characters").map((request) => request["rid"]);
    const reply = (rid: unknown, name: string) => {
      app.socket().receive({ type: "command_output", rid, name: "list_characters", data: { characters: [{ name }] } });
      app.socket().receive({ type: "request_finished", rid, outcome: "completed" });
    };
    await acting(async () => { reply(newer, "newer"); await Bun.sleep(5); });
    await acting(async () => { reply(older, "older"); await Bun.sleep(5); });
    expect(hook.current().data).toEqual({ characters: [{ name: "newer" }] });
    await hook.unmount();
  });

  test("an action says what it did, or why it failed, and is busy meanwhile", async () => {
    const { useAction } = await shared();
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const hook = await renderHook(() => useAction(), undefined);
    let release: (text: string | undefined) => void = () => {};
    let outcome: Promise<boolean> = Promise.resolve(false);
    await acting(() => { outcome = hook.current().run(async () => await new Promise<string | undefined>((resolve) => { release = resolve; })); });
    expect(hook.current().busy).toBe(true);
    await acting(async () => { release("Done"); await outcome; });
    expect([hook.current().busy, await outcome]).toEqual([false, true]);
    await acting(async () => { expect(await hook.current().run(async () => { await Promise.resolve(); return undefined; })).toBe(true); });
    await acting(async () => { expect(await hook.current().run(async () => { await Promise.resolve(); throw new Error("nope"); })).toBe(false); });
    expect(shown.mock.calls).toEqual([["Done"], ["nope", "error"]]);
    expect(hook.current().busy).toBe(false);
  });
});

describe("small settings pieces", () => {
  test("ask for a character, show loading, errors or the content, and lay out sections and rows", async () => {
    const { Loading, NeedsCharacter } = await shared();
    const { SettingRow, SettingsSection } = await import("../../src/browser/settings/layout.tsx");
    const view = await mount(<>
      <NeedsCharacter />
      <Loading error="" ready={false}><p>content</p></Loading>
      <Loading error="broken" ready><p>content</p></Loading>
      <Loading error="" ready><p id="content">content</p></Loading>
      <SettingsSection title="Title" description="About it" actions={<button type="button">Act</button>}><p>inside</p></SettingsSection>
      <SettingsSection title="Bare"><SettingRow label="Plain" /><SettingRow label="Linked" htmlFor="field" description="Help"><input id="field" /></SettingRow></SettingsSection>
    </>);
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("Choose a character in the sidebar first; these settings belong to a character.");
    expect(view.host.querySelector(".settings-empty [role=status]")).not.toBeNull();
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("broken");
    expect(view.host.querySelector("#content")?.textContent).toBe("content");
    const [titled, bare] = [...view.host.querySelectorAll(".settings-section")];
    expect([titled?.querySelector("h2")?.textContent, titled?.querySelector(".settings-description")?.textContent, titled?.querySelector(".settings-section-head button")?.textContent]).toEqual(["Title", "About it", "Act"]);
    expect([bare?.querySelector(".settings-description"), bare?.querySelectorAll(".setting-row").length]).toEqual([null, 2]);
    const [plain, linked] = [...(bare?.querySelectorAll(".setting-row") ?? [])];
    expect([plain?.querySelector("div.setting-label")?.textContent, plain?.querySelector(".setting-control"), plain?.querySelector(".setting-description")]).toEqual(["Plain", null, null]);
    expect([linked?.querySelector("label")?.htmlFor, linked?.querySelector(".setting-description")?.textContent, linked?.querySelector(".setting-control input")?.id]).toEqual(["field", "Help", "field"]);
  });

  test("format numbers, costs and times, with a dash for nothing", async () => {
    const { formatCost, formatNumber, formatTime } = await shared();
    expect([formatNumber(null), formatNumber(undefined), formatNumber(1234)]).toEqual(["—", "—", (1234).toLocaleString()]);
    expect([formatCost(12.3456), formatCost(0.123456)]).toEqual([(12.3456).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }), (0.123456).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })]);
    expect(formatCost(1)).toBe((1).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect([formatTime(null), formatTime(undefined), formatTime("whenever")]).toEqual(["—", "—", "whenever"]);
    expect(formatTime("2026-11-10T05:00:00Z")).toBe(new Date("2026-11-10T05:00:00Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  });

  test("download text as a file through a link it lets go of afterwards", async () => {
    const { downloadText } = await shared();
    const made = spyOn(URL, "createObjectURL").mockReturnValue("blob:made");
    const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicked: [string, string][] = [];
    const clicks = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push([this.href, this.download]); });
    app.restores.push(() => { made.mockRestore(); revoked.mockRestore(); clicks.mockRestore(); });
    downloadText("notes.json", "{}", "application/json");
    const blob = made.mock.calls[0]?.[0] as Blob;
    expect([blob.type, await blob.text(), clicked]).toEqual(["application/json", "{}", [["blob:made", "notes.json"]]]);
    downloadText("notes.txt", "x");
    expect((made.mock.calls[1]?.[0] as Blob | undefined)?.type).toBe("text/plain");
    expect(revoked).not.toHaveBeenCalled();
    await Bun.sleep(1100);
    expect(revoked.mock.calls).toEqual([["blob:made"], ["blob:made"]]);
  });
});

describe("a value tree", () => {
  test("reads plain values in words, lists inline or as a list, and groups by labelled keys up to a depth", async () => {
    const { Tree } = await import("../../src/browser/settings/tree.tsx");
    const when = "2026-11-10T05:00:00Z";
    const view = await mount(<Tree value={{ nothing: null, missing: undefined, empty: "", path: "/a/b", plain: "x", stamp: when, odd: "2026-99-99T99:99", count: 1234, yes: true, no: false, none: [], words: ["a", 2, null], rows: [{ a: 1 }, [2]], hollow: {} }} />);
    const rows = [...view.host.querySelectorAll(":scope > dl > .kv-row")].map((row) => {
      const first = row.querySelector(":scope > dd")?.firstElementChild;
      return [row.querySelector("dt")?.textContent, row.querySelector(":scope > dd")?.textContent, first?.tagName === "SPAN" ? first.className : first?.tagName];
    });
    expect(rows).toEqual([
      ["Nothing", "—", ""], ["Missing", "—", ""], ["Empty", "(empty)", ""], ["Path", "/a/b", "mono"], ["Plain", "x", ""],
      ["Stamp", new Date(when).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }), ""], ["Odd", "2026-99-99T99:99", ""],
      ["Count", (1234).toLocaleString(), ""], ["Yes", "Yes", ""], ["No", "No", ""], ["None", "None", "muted"], ["Words", "a, 2, —", ""],
      ["Rows", "A12", "OL"], ["Hollow", "None", "muted"],
    ]);
    let deep: unknown = { leaf: 1 };
    for (let level = 0; level < 6; level += 1) deep = { inner: deep };
    const nested = await mount(<Tree value={deep} />);
    expect(nested.host.querySelector("span.mono")?.textContent).toBe('{"leaf":1}');
    expect(nested.host.querySelectorAll("dl")).toHaveLength(6);
  });
});

describe("pages and banners", () => {
  test("the connection banner offers a reload after an upgrade, and a retry otherwise", async () => {
    const { ConnectionBanner } = await import("../../src/browser/app/banner.tsx");
    const snapshot = app.state().workspace.getSnapshot();
    const reconnects = spyOn(app.state().workspace.connection, "reconnect").mockImplementation(() => {});
    const reloads = spyOn(location, "reload").mockImplementation(() => {});
    app.restores.push(() => { reconnects.mockRestore(); reloads.mockRestore(); });
    const view = await mount(<ConnectionBanner state={{ ...snapshot, status: "ready" }} />);
    expect(view.host.innerHTML).toBe("");
    await view.update(<ConnectionBanner state={{ ...snapshot, status: "reload_required" }} />);
    expect(view.host.querySelector("[role=status]")?.textContent).toBe("Shore was updated. Reload");
    await click(button(view.host, "Reload"));
    expect(reloads).toHaveBeenCalledTimes(1);
    for (const [status, detail, text] of [["error", "Wrong origin", "Wrong origin"], ["error", "", "Can’t reach the daemon."], ["reconnecting", "ignored", "Reconnecting…"]] as const) {
      await view.update(<ConnectionBanner state={{ ...snapshot, status, detail }} />);
      expect(view.host.querySelector("[role=status]")?.textContent, status).toBe(`${text}Retry now`);
    }
    await click(button(view.host, "Retry now"));
    expect(reconnects).toHaveBeenCalledTimes(1);
  });

  test("the keyboard page lists the shortcuts as the switches set them, and keeps the switches", async () => {
    const { KeyboardPage } = await import("../../src/browser/settings/Keyboard.tsx");
    const { shortcutsFor, keyLabel } = await import("../../src/browser/app/shortcuts.ts");
    const snapshot = app.state().workspace.getSnapshot();
    const view = await mount(<KeyboardPage state={snapshot} />);
    const listed = () => [...view.host.querySelectorAll(".setting-control.keys")].map((keys) => [...keys.querySelectorAll("kbd")].map((key) => key.textContent).join("+"));
    expect(listed()).toEqual(shortcutsFor(true, false).map((item) => item.keys.map(keyLabel).join("+")));
    expect([...view.host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["Writing messages", "Anywhere", "Message box", "Thread"]);
    expect(view.host.querySelector(".settings-section-head .settings-description")?.textContent).toBe("Kept by the daemon, so every browser and device shows the same.");
    expect(view.host.textContent).toContain(`${keyLabel("Mod")}+Enter sends`);
    await click(view.host.querySelector("[aria-label='Enter sends']"));
    await click(view.host.querySelector("[aria-label='Vim mode']"));
    expect(listed()).toEqual(shortcutsFor(false, true).map((item) => item.keys.map(keyLabel).join("+")));
    expect([localStorage.getItem("shore.enter-sends"), localStorage.getItem("shore.vim-mode")]).toEqual(["false", "true"]);
    localStorage.clear();
  });

  test("the debug page needs a character, runs each control, and shows its last result", async () => {
    const { DebugPage } = await import("../../src/browser/settings/Debug.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const snapshot = app.state().workspace.getSnapshot();
    const view = await mount(<DebugPage state={{ ...snapshot, character: null }} />);
    expect(view.host.textContent).toContain("Choose a character");
    const dream = { character: "ada", enabled: true, queued: true, running: true };
    const results: Record<string, unknown> = {
      heartbeat_tick_now: { status: "scheduled", character: "ada" }, heartbeat_set_dormant: { status: "dormant", character: "ada" }, heartbeat_set_active: { status: "active", character: "ada" },
      dream, keepalive_ping_now: { status: "skipped", character: "ada", reason: "cold" }, session_activate: { character: "ada", registered: true, keepalive: { status: "off" }, own_time: null },
    };
    app.answer((request) => results[request["name"] as string]);
    await view.update(<DebugPage state={{ ...snapshot, character: "ada" }} />);
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("Manual controls for ada’s background activity. These act immediately.");
    for (const title of ["Start a wake", "Make dormant", "Make active", "Dream", "Ping", "Activate"]) {
      await click(button(view.host, title));
      await acting(() => Bun.sleep(5));
    }
    expect(view.host.querySelector(".settings-section:last-child h2")?.textContent).toBe("Last result: Activate");
    results["heartbeat_tick_now"] = { status: "scheduled", character: "ada", warning: "Nothing to do" };
    results["dream"] = { ...dream, running: false };
    await click(button(view.host, "Start a wake"));
    await acting(() => Bun.sleep(5));
    await click(button(view.host, "Dream"));
    await acting(() => Bun.sleep(5));
    expect(shown.mock.calls.map(([text]) => text)).toEqual(["Wake scheduled", "ada is dormant", "ada is active", "Already dreaming", "Keepalive skipped", "Session activated", "Nothing to do", "Dream queued"]);
  });
});
