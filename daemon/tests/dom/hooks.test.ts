import { afterEach, describe, expect, test } from "bun:test";

import { acting, blockStorage, renderHook, useDom } from "./dom.ts";

useDom();

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  localStorage.clear();
  document.body.replaceChildren();
});

async function hooks() { return await import("../../src/browser/ui/hooks.ts"); }

describe("reading and writing the browser's storage", () => {
  test("reads what was stored, and nothing when storage is blocked", async () => {
    const { readStored, writeStored } = await import("../../src/browser/stored.ts");
    expect(readStored("shore.x")).toBeNull();
    writeStored("shore.x", "1");
    expect(localStorage.getItem("shore.x")).toBe("1");
    expect(readStored("shore.x")).toBe("1");
    restores.push(blockStorage());
    expect(readStored("shore.x")).toBeNull();
    expect(() => { writeStored("shore.x", "2"); }).not.toThrow();
  });
});

describe("a media query", () => {
  test("follows whether the query matches, listening only while it is used and only to the query in use", async () => {
    const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => {
      const list = lists.get(query) ?? { matches: false, listeners: new Set<() => void>() };
      lists.set(query, list);
      return {
        get matches() { return list.matches; },
        addEventListener: (_type: string, listener: () => void) => { list.listeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { list.listeners.delete(listener); },
      };
    }) as unknown as typeof matchMedia;
    restores.push(() => { globalThis.matchMedia = original; });
    const { useMediaQuery } = await hooks();
    const narrow: string = "(max-width: 600px)";
    const hook = await renderHook(useMediaQuery, narrow);
    expect(hook.current()).toBe(false);
    const list = lists.get(narrow);
    expect(list?.listeners.size).toBe(1);
    await acting(() => { if (list !== undefined) list.matches = true; for (const listener of list?.listeners ?? []) listener(); });
    expect(hook.current()).toBe(true);
    await hook.rerender("(prefers-color-scheme: dark)");
    expect(hook.current()).toBe(false);
    expect(list?.listeners.size).toBe(0);
    expect(lists.get("(prefers-color-scheme: dark)")?.listeners.size).toBe(1);
    await hook.unmount();
    expect(lists.get("(prefers-color-scheme: dark)")?.listeners.size).toBe(0);
  });
});

describe("stored settings", () => {
  test("a flag starts from storage or its default, and is written when changed", async () => {
    const { useStoredFlag } = await hooks();
    const fresh = await renderHook(({ key, fallback }: { key: string; fallback: boolean }) => useStoredFlag(key, fallback), { key: "shore.flag", fallback: true });
    expect(fresh.current()[0]).toBe(true);
    await acting(() => { fresh.current()[1](false); });
    expect(fresh.current()[0]).toBe(false);
    expect(localStorage.getItem("shore.flag")).toBe("false");
    localStorage.setItem("shore.on", "true");
    localStorage.setItem("shore.off", "nonsense");
    expect((await renderHook(({ key }: { key: string }) => useStoredFlag(key, false), { key: "shore.on" })).current()[0]).toBe(true);
    expect((await renderHook(({ key }: { key: string }) => useStoredFlag(key, true), { key: "shore.off" })).current()[0]).toBe(false);
  });

  test("a flag keeps working when storage is blocked", async () => {
    const { useStoredFlag } = await hooks();
    restores.push(blockStorage());
    const hook = await renderHook(({ key }: { key: string }) => useStoredFlag(key, true), { key: "shore.flag" });
    expect(hook.current()[0]).toBe(true);
    await acting(() => { hook.current()[1](false); });
    expect(hook.current()[0]).toBe(false);
  });

  test("text starts from storage or its default, asked for only when needed, and is written when changed", async () => {
    const { useStoredText } = await hooks();
    let asked = 0;
    const fallback = () => { asked += 1; return "default"; };
    const fresh = await renderHook(({ key }: { key: string }) => useStoredText(key, fallback), { key: "shore.text" });
    expect(fresh.current()[0]).toBe("default");
    expect(asked).toBe(1);
    await acting(() => { fresh.current()[1]("chosen"); });
    expect(fresh.current()[0]).toBe("chosen");
    expect(localStorage.getItem("shore.text")).toBe("chosen");
    const stored = await renderHook(({ key }: { key: string }) => useStoredText(key, fallback), { key: "shore.text" });
    expect(stored.current()[0]).toBe("chosen");
    expect(asked).toBe(1);
  });
});

describe("stored settings changed from outside the page", () => {
  test("a flag and a text follow what is stored once the page is told it changed, until they are no longer shown", async () => {
    const { useStoredFlag, useStoredText } = await hooks();
    const { storedChanged } = await import("../../src/browser/stored.ts");
    const flag = await renderHook(({ key }: { key: string }) => useStoredFlag(key, false), { key: "shore.flag" });
    const text = await renderHook(({ key }: { key: string }) => useStoredText(key, () => "default"), { key: "shore.text" });
    localStorage.setItem("shore.flag", "true");
    localStorage.setItem("shore.text", "elsewhere");
    expect([flag.current()[0], text.current()[0]], "storage alone says nothing").toEqual([false, "default"]);
    await acting(() => { storedChanged(); });
    expect([flag.current()[0], text.current()[0]]).toEqual([true, "elsewhere"]);
    localStorage.setItem("shore.flag", "false");
    await acting(() => { storedChanged(); });
    expect(flag.current()[0]).toBe(false);
    localStorage.clear();
    await acting(() => { storedChanged(); });
    expect([flag.current()[0], text.current()[0]], "a setting nobody stored keeps its value").toEqual([false, "elsewhere"]);
    localStorage.setItem("shore.other-flag", "true");
    localStorage.setItem("shore.other-text", "other");
    await flag.rerender({ key: "shore.other-flag" });
    await text.rerender({ key: "shore.other-text" });
    await acting(() => { storedChanged(); });
    expect([flag.current()[0], text.current()[0]], "it follows the key it is given now").toEqual([true, "other"]);
    const renders = [flag.renders(), text.renders()];
    await flag.unmount();
    await text.unmount();
    localStorage.setItem("shore.other-flag", "false");
    storedChanged();
    expect([flag.renders(), text.renders()]).toEqual(renders);
  });

  test("whoever asked to hear about changed settings hears each one until they leave", async () => {
    const { storedChanged, subscribeStored } = await import("../../src/browser/stored.ts");
    let heard = 0;
    const leave = subscribeStored(() => { heard += 1; });
    storedChanged();
    storedChanged();
    leave();
    storedChanged();
    expect(heard).toBe(2);
  });

  test("a written setting is passed to whoever follows writes, even when the browser refuses to store it", async () => {
    const { followStoredWrites, writeStored } = await import("../../src/browser/stored.ts");
    const seen: string[][] = [];
    followStoredWrites((key, value) => { seen.push([key, value]); });
    restores.push(() => { followStoredWrites(() => {}); });
    writeStored("shore.x", "1");
    restores.push(blockStorage());
    writeStored("shore.y", "2");
    expect(seen).toEqual([["shore.x", "1"], ["shore.y", "2"]]);
  });
});

describe("closing with Escape", () => {
  test("runs the action on Escape while active, unless something else handled it or a dialog is open", async () => {
    const { useEscape } = await hooks();
    let closed = 0;
    const action = () => { closed += 1; };
    const hook = await renderHook(({ active }: { active: boolean }) => { useEscape(active, action); return active; }, { active: true });
    const press = (key: string, prevent = false) => {
      const event = new KeyboardEvent("keydown", { key, cancelable: true });
      if (prevent) event.preventDefault();
      dispatchEvent(event);
    };
    press("Enter");
    press("Escape", true);
    expect(closed).toBe(0);
    press("Escape");
    expect(closed).toBe(1);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    press("Escape");
    expect(closed).toBe(1);
    dialog.remove();
    await hook.rerender({ active: false });
    press("Escape");
    expect(closed).toBe(1);
    await hook.rerender({ active: true });
    press("Escape");
    expect(closed).toBe(2);
    await hook.unmount();
    press("Escape");
    expect(closed).toBe(2);
  });
});
