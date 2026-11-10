import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { acting, blockStorage, renderHook, useDom } from "./dom.ts";

useDom("http://shore.test:7340/workspace/ada?x=1#settings/usage");

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

const COPY = "own";
async function routes() { return await import(`../../src/browser/app/route.ts?${COPY}`) as typeof import("../../src/browser/app/route.ts"); }

async function drain(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
}

describe("the page's route", () => {
  test("starts from the address, and follows navigation, recording each settings page and its history entry", async () => {
    const { navigate, subscribeRoute, useRoute } = await routes();
    const hook = await renderHook(() => useRoute(), undefined);
    expect(hook.current()).toEqual({ view: "settings", page: "usage" });
    let heard: string[] = [];
    const leave = subscribeRoute(() => { heard.push(location.hash); });
    const pushes = spyOn(history, "pushState");
    restores.push(() => { pushes.mockRestore(); });
    navigate({ view: "settings", page: "models" });
    expect(heard).toEqual(["#settings/models"]);
    expect(localStorage.getItem("shore.settings-page")).toBe("models");
    await acting(drain);
    expect(hook.current()).toEqual({ view: "settings", page: "models" });
    heard = [];
    navigate({ view: "settings", page: "models" });
    expect(heard).toEqual([]);
    expect(pushes).toHaveBeenCalledTimes(1);
    navigate({ view: "chat" });
    expect(heard).toEqual([""]);
    expect(pushes.mock.calls.at(-1)).toEqual([null, "", "/workspace/ada?x=1"]);
    await acting(drain);
    expect(hook.current()).toEqual({ view: "chat" });
    heard = [];
    navigate({ view: "chat" });
    expect(heard).toEqual([]);
    expect(pushes).toHaveBeenCalledTimes(2);
    leave();
    navigate({ view: "settings", page: "usage" });
    await acting(drain);
    expect(heard).toEqual([]);
    expect(hook.current()).toEqual({ view: "settings", page: "usage" });
    await hook.unmount();
  });

  test("knows the new route as soon as it navigates, before the page says the address changed", async () => {
    const { navigate, useRoute } = await routes();
    const { act } = await import("react");
    const hook = await renderHook(() => useRoute(), undefined);
    act(() => { navigate({ view: "settings", page: "models" }); });
    expect(hook.current()).toEqual({ view: "settings", page: "models" });
    act(() => { navigate({ view: "chat" }); });
    expect(hook.current()).toEqual({ view: "chat" });
    await acting(drain);
    await hook.unmount();
  });

  test("follows a change of address made outside it", async () => {
    const { navigate, useRoute } = await routes();
    await acting(() => { navigate({ view: "chat" }); });
    const hook = await renderHook(() => useRoute(), undefined);
    history.replaceState(null, "", "#settings/models");
    await acting(() => { dispatchEvent(new Event("hashchange")); });
    expect(hook.current()).toEqual({ view: "settings", page: "models" });
    await hook.unmount();
  });

  test("navigates even when storage is blocked", async () => {
    const { navigate } = await routes();
    restores.push(blockStorage());
    navigate({ view: "settings", page: "usage" });
    expect(location.hash).toBe("#settings/usage");
  });

  test("settings open on the page last used, or on models", async () => {
    const { navigate, openSettings } = await routes();
    navigate({ view: "chat" });
    localStorage.setItem("shore.settings-page", "usage");
    openSettings();
    expect(location.hash).toBe("#settings/usage");
    navigate({ view: "chat" });
    localStorage.setItem("shore.settings-page", "nowhere");
    openSettings();
    expect(location.hash).toBe("#settings/models");
    navigate({ view: "chat" });
    localStorage.setItem("shore.settings-page", "usage");
    restores.push(blockStorage());
    openSettings();
    expect(location.hash).toBe("#settings/models");
  });
});
