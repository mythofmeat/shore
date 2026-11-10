import { describe, expect, spyOn, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();

const checked = (root: ParentNode, label: string) => root.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-checked");

describe("the appearance page", () => {
  test("chooses the theme and text size, showing which is on, and says when a choice could not be saved", async () => {
    const { AppearancePage } = await import("../../src/browser/settings/Appearance.tsx");
    const state = app.state();
    const view = await mount(<AppearancePage state={state.workspace.getSnapshot()} />);
    const themes = [...view.host.querySelectorAll("[aria-label=Theme] [role=radio]")];
    expect(themes.map((item) => [item.textContent?.startsWith(item.querySelector(".theme-name")?.textContent ?? "x"), item.getAttribute("aria-checked"), item.className, item.querySelector(".theme-swatch")?.getAttribute("data-theme")])).toEqual([
      [true, "true", "theme-card on", "default"], [true, "false", "theme-card ", "fog"],
    ]);
    await click(themes[1]);
    expect([state.themes.getSnapshot(), themes[1]?.getAttribute("aria-checked"), themes[1]?.className]).toEqual(["fog", "true", "theme-card on"]);
    const sizes = [...view.host.querySelectorAll("[aria-label='Text size'] [role=radio]")];
    expect(sizes.map((item) => item.textContent)).toEqual(["Small", "Default", "Large", "Larger"]);
    await click(sizes[3]);
    expect([state.fontSizes.getSnapshot(), sizes[3]?.getAttribute("aria-checked"), sizes[1]?.getAttribute("aria-checked")]).toEqual(["larger", "true", "false"]);
    expect(view.host.querySelectorAll("[role=alert]")).toHaveLength(0);
    const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    for (const store of [state.themes, state.fontSizes]) {
      const original = store.storage;
      Object.defineProperty(store, "storage", { configurable: true, value: failing });
      app.restores.push(() => { Object.defineProperty(store, "storage", { configurable: true, value: original }); store.select(store.getSnapshot() as never); });
    }
    await click(themes[0]);
    await click(sizes[1]);
    expect([...view.host.querySelectorAll("[role=alert]")].map((alert) => alert.textContent)).toEqual([state.themes.error, state.fontSizes.error]);
    expect(state.themes.error).toContain("will reset on reload");
    await view.unmount();
    localStorage.clear();
  });

  test("switches streaming and each part of a thread's display, and shows a display setting that could not be saved", async () => {
    const { AppearancePage } = await import("../../src/browser/settings/Appearance.tsx");
    const state = app.state();
    const view = await mount(<AppearancePage state={state.workspace.getSnapshot()} />);
    const labels = [...view.host.querySelectorAll("[role=switch]")].map((item) => item.getAttribute("aria-label"));
    expect(labels).toEqual(["Stream replies", "Timestamps", "Reasoning", "Tool calls and results", "Subagent activity", "Inline images", "Message metadata", "Compaction activity", "Notify when unfocused"]);
    expect([checked(view.host, "Stream replies"), checked(view.host, "Message metadata"), checked(view.host, "Timestamps")]).toEqual(["true", "false", "true"]);
    await click(view.host.querySelector("[aria-label='Stream replies']"));
    await click(view.host.querySelector("[aria-label='Message metadata']"));
    await click(view.host.querySelector("[aria-label='Timestamps']"));
    expect([localStorage.getItem(state.STREAM_KEY), state.display.getSnapshot().values.metadata, state.display.getSnapshot().values.timestamps]).toEqual(["false", "on", "off"]);
    expect([checked(view.host, "Stream replies"), checked(view.host, "Message metadata")]).toEqual(["false", "true"]);
    expect(view.host.querySelector(".settings-section:nth-of-type(3) [role=alert]")).toBeNull();
    const original = state.display.storage;
    Object.defineProperty(state.display, "storage", { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
    app.restores.push(() => { Object.defineProperty(state.display, "storage", { configurable: true, value: original }); state.display.save(); });
    await click(view.host.querySelector("[aria-label='Inline images']"));
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("Display preferences are not saved. Keep this tab open and retry saving.");
    await view.unmount();
    localStorage.clear();
  });

  test("turns notifications on and off, explaining what the browser allows", async () => {
    const { AppearancePage } = await import("../../src/browser/settings/Appearance.tsx");
    const state = app.state();
    const description = () => view.host.querySelector(".setting-row:has([aria-label='Notify when unfocused']) .setting-description")?.textContent ?? "";
    const base = "When this tab isn’t focused, show a desktop notification and a count in the tab title for new replies, heartbeat messages and errors.";
    const view = await mount(<AppearancePage state={state.workspace.getSnapshot()} />);
    expect(state.notifier.getSnapshot().permission, "no secure context in tests").toBe("unavailable");
    expect(description()).toBe(`${base} This browser only allows desktop notifications over HTTPS or localhost, so only the tab title count is shown.`);
    const enable = spyOn(state.notifier, "enable");
    const disable = spyOn(state.notifier, "disable");
    app.restores.push(() => { enable.mockRestore(); disable.mockRestore(); });
    await click(view.host.querySelector("[aria-label='Notify when unfocused']"));
    await acting(() => Bun.sleep(1));
    expect([enable.mock.calls.length, checked(view.host, "Notify when unfocused")]).toEqual([1, "true"]);
    await click(view.host.querySelector("[aria-label='Notify when unfocused']"));
    expect(disable.mock.calls.length).toBe(1);
    const permission = (value: string, enabled: boolean) => spyOn(state.notifier, "getSnapshot").mockReturnValue({ enabled, permission: value as never, unread: 0 });
    for (const [value, enabled, note] of [
      ["denied", false, " Notifications are blocked for this site in the browser’s settings, so only the tab title count is shown."],
      ["default", true, " The browser hasn’t allowed desktop notifications for this site yet, so only the tab title count is shown. Turn this off and on again to be asked."],
      ["default", false, ""],
      ["granted", true, ""],
    ] as const) {
      const snapshot = permission(value, enabled);
      const page = await mount(<AppearancePage state={state.workspace.getSnapshot()} />);
      expect(page.host.querySelector(".setting-row:has([aria-label='Notify when unfocused']) .setting-description")?.textContent, `${value} ${String(enabled)}`).toBe(`${base}${note}`);
      await page.unmount();
      snapshot.mockRestore();
    }
    await view.unmount();
    localStorage.clear();
  });
});

describe("the settings screen", () => {
  test("lists every page by group, marks the open one, and moves between them and back to the chat", async () => {
    const { Settings } = await import("../../src/browser/settings/Settings.tsx");
    const state = app.state();
    const view = await mount(<Settings state={state.workspace.getSnapshot()} page="keyboard" sidebarOpen toggleSidebar={() => {}} />);
    const groups = [...view.host.querySelectorAll(".settings-nav-group")];
    expect(groups.map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll("button")].map((item) => item.textContent)])).toEqual([
      ["Chat", ["Models", "Characters", "Appearance", "Keyboard shortcuts"]],
      ["Daemon", ["Providers", "Usage & budgets", "Configuration", "Devices"]],
      ["Advanced", ["Memory & segments", "Diagnostics", "Traces & call log", "Tool runner", "Character archives", "Debug"]],
    ]);
    const current = button(view.host, "Keyboard shortcuts");
    expect([current.className, current.getAttribute("aria-current"), button(view.host, "Models").hasAttribute("aria-current")]).toEqual(["settings-nav-item on", "page", false]);
    expect([view.host.querySelector("h1")?.textContent, view.host.querySelector("main")?.getAttribute("aria-label"), view.host.querySelector(".settings-topbar")]).toEqual(["Keyboard shortcuts", "Keyboard shortcuts", null]);
    await click(button(view.host, "Debug"));
    expect(location.hash).toBe("#settings/debug");
    await click(view.host.querySelector(".settings-nav-item.back"));
    expect(location.hash).toBe("");
    const logout = spyOn(state.workspace.connection, "signOut").mockResolvedValue();
    app.restores.push(() => { logout.mockRestore(); });
    await click(button(view.host, "Disconnect"));
    expect(logout).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("shows a top bar to bring the sidebar back, and on a narrow screen folds the pages into a menu under the page's name", async () => {
    const { Settings } = await import("../../src/browser/settings/Settings.tsx");
    const state = app.state();
    let toggled = 0;
    const view = await mount(<Settings state={state.workspace.getSnapshot()} page="keyboard" sidebarOpen={false} toggleSidebar={() => { toggled += 1; }} />);
    expect(view.host.querySelector(".topbar-title")?.textContent).toBe("Settings");
    await click(button(view.host, "Expand sidebar"));
    expect(toggled).toBe(1);
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({ matches: query === "(max-width: 700px)", addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof matchMedia;
    app.restores.push(() => { globalThis.matchMedia = original; });
    const narrow = await mount(<Settings state={state.workspace.getSnapshot()} page="keyboard" sidebarOpen toggleSidebar={() => { toggled += 1; }} />);
    expect([narrow.host.querySelector(".topbar-title")?.textContent, narrow.host.querySelector(".settings-nav-mobile summary")?.textContent]).toEqual(["Settings/Keyboard shortcuts", "Keyboard shortcuts"]);
    expect(narrow.host.querySelector("[aria-label='Open sidebar']"), "the sidebar is open").toBeNull();
    const closed = await mount(<Settings state={state.workspace.getSnapshot()} page="keyboard" sidebarOpen={false} toggleSidebar={() => { toggled += 1; }} />);
    await click(button(closed.host, "Open sidebar"));
    expect(toggled).toBe(2);
    const offline = await mount(<Settings state={{ ...state.workspace.getSnapshot(), status: "reconnecting" }} page="keyboard" sidebarOpen toggleSidebar={() => {}} />);
    expect(offline.host.querySelector(".banner")?.textContent).toContain("Reconnecting…");
  });
});
