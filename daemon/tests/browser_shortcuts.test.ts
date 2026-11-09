import { describe, expect, test } from "bun:test";

import { SHORTCUTS, adjacent, globalAction, keyLabel, nextUnread, paletteMatches, shortcutsFor, type KeyInput } from "../src/browser/app/shortcuts.ts";

const key = (pressed: string, modifiers: Partial<Omit<KeyInput, "key">> = {}): KeyInput =>
  ({ key: pressed, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

describe("the shortcut list", () => {
  test("says how to send for the way the box is set to send, and speaks of modes for vim", () => {
    expect(shortcutsFor(true)).toBe(SHORTCUTS);
    const modEnter = shortcutsFor(false);
    expect(modEnter.find((item) => item.where === "Message box" && item.keys.includes("Enter"))).toEqual({ keys: ["Mod", "Enter"], description: "Send (Enter for a new line)", where: "Message box" });
    expect(modEnter.filter((item) => item !== SHORTCUTS[modEnter.indexOf(item)]).length, "only the send line changes").toBe(1);
    const vim = shortcutsFor(true, true);
    expect(vim.filter((item) => item.where === "Message box").map((item) => item.description)).toEqual([
      "Send in insert mode (Shift+Enter for a new line)",
      "Edit your last message when the box is empty, in insert mode",
      "Previous or next response when the box is empty, in insert mode",
      "Switch to normal mode (Stop ends a response)",
    ]);
    expect(vim.filter((item) => item.where !== "Message box")).toEqual(SHORTCUTS.filter((item) => item.where !== "Message box"));
    expect(shortcutsFor(false, true).find((item) => item.keys.includes("Enter"))?.description).toBe("Send from any mode (Enter adds a new line in insert mode)");
  });

  test("names the modifier for this platform and every other key as written", () => {
    expect(keyLabel("Mod")).toBe("Ctrl");
    expect(keyLabel("Shift")).toBe("Shift");
    expect(keyLabel("?")).toBe("?");
  });
});

describe("keys that work anywhere", () => {
  test("each action has its own combination, and an extra modifier makes it something else", () => {
    const cases: [KeyInput, ReturnType<typeof globalAction>][] = [
      [key("k", { ctrlKey: true }), "palette"],
      [key("K", { ctrlKey: true }), "palette"],
      [key("k", { ctrlKey: true, shiftKey: true }), undefined],
      [key("k", { ctrlKey: true, altKey: true }), undefined],
      [key("k", { metaKey: true }), undefined],
      [key("/", { ctrlKey: true }), "focus"],
      [key("/", { ctrlKey: true, shiftKey: true }), "focus"],
      [key("/", { ctrlKey: true, altKey: true }), undefined],
      [key("O", { ctrlKey: true, shiftKey: true }), "new-thread"],
      [key("o", { ctrlKey: true, shiftKey: true }), "new-thread"],
      [key("o", { ctrlKey: true }), undefined],
      [key("\\", { ctrlKey: true }), "sidebar"],
      [key("\\", { ctrlKey: true, shiftKey: true }), undefined],
      [key(",", { ctrlKey: true }), "settings"],
      [key(",", { ctrlKey: true, shiftKey: true }), undefined],
      [key("ArrowUp", { altKey: true }), "previous-thread"],
      [key("ArrowUp", { altKey: true, ctrlKey: true }), undefined],
      [key("ArrowUp", { altKey: true, shiftKey: true }), undefined],
      [key("ArrowDown", { altKey: true }), "next-thread"],
      [key("ArrowDown", { altKey: true, ctrlKey: true }), undefined],
      [key("ArrowDown", { altKey: true, shiftKey: true }), "next-unread-thread"],
      [key("ArrowDown", { altKey: true, shiftKey: true, ctrlKey: true }), undefined],
      [key("ArrowDown"), undefined],
      [key("?"), "help"],
      [key("?", { ctrlKey: true }), undefined],
      [key("?", { altKey: true }), undefined],
      [key("a"), undefined],
    ];
    for (const [pressed, action] of cases) expect(globalAction(pressed, false), JSON.stringify(pressed)).toBe(action);
    expect(globalAction(key("?"), true), "a question mark while typing is just text").toBeUndefined();
    expect(globalAction(key("k", { ctrlKey: true }), true)).toBe("palette");
  });
});

describe("moving between threads", () => {
  const threads = [{ id: "main", unread: 0 }, { id: "a", unread: 2 }, { id: "b" }, { id: "c", unread: 1 }];

  test("the next unread thread is found going forward and around, never the current one", () => {
    expect(nextUnread(threads, "main")).toBe("a");
    expect(nextUnread(threads, "a")).toBe("c");
    expect(nextUnread(threads, "c")).toBe("a");
    expect(nextUnread(threads, "elsewhere"), "an unknown thread starts from the top").toBe("a");
    expect(nextUnread([{ id: "a", unread: 3 }], "a")).toBeUndefined();
    expect(nextUnread([{ id: "a" }, { id: "b", unread: 0 }], "a")).toBeUndefined();
    expect(nextUnread([], null)).toBeUndefined();
  });

  test("stepping wraps around both ends, and with nothing current starts from the edge", () => {
    const items = ["a", "b", "c"];
    expect(adjacent(items, "b", 1)).toBe("c");
    expect(adjacent(items, "c", 1)).toBe("a");
    expect(adjacent(items, "a", -1)).toBe("c");
    expect(adjacent(items, undefined, 1)).toBe("a");
    expect(adjacent(items, undefined, -1), "from before the start").toBe("b");
    expect(adjacent([], "a", 1)).toBeUndefined();
  });
});

describe("the command palette", () => {
  test("lists every command whose label or detail holds all the words typed, in any case", () => {
    const commands = [{ label: "New thread" }, { label: "Open settings", detail: "Appearance and keys" }, { label: "Rename thread", detail: "Give it a name" }];
    expect(paletteMatches(commands, "")).toEqual([0, 1, 2]);
    expect(paletteMatches(commands, "  THREAD ")).toEqual([0, 2]);
    expect(paletteMatches(commands, "thread name")).toEqual([2]);
    expect(paletteMatches(commands, "keys settings")).toEqual([1]);
    expect(paletteMatches(commands, "nothing")).toEqual([]);
  });
});
