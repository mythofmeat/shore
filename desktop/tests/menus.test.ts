import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { contextMenuTemplate, type ContextActions, type ContextParams } from "../src/menus.ts";

const FLAGS = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };
const PLAIN: ContextParams = { dictionarySuggestions: [], misspelledWord: "", linkURL: "", mediaType: "none", srcURL: "", isEditable: false, editFlags: FLAGS, selectionText: "" };

function recorder(): { calls: string[]; actions: ContextActions } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      replaceMisspelling: (word) => { calls.push(`replace ${word}`); },
      addToDictionary: (word) => { calls.push(`learn ${word}`); },
      openExternal: (url) => { calls.push(`open ${url}`); },
      copyText: (text) => { calls.push(`copy ${text}`); },
      copyImage: () => { calls.push("copy image"); },
      saveImage: (url) => { calls.push(`save ${url}`); },
      quote: () => { calls.push("quote"); },
    },
  };
}

function press(item: MenuItemConstructorOptions | undefined, checked = false): void {
  (item?.click as ((menuItem: { checked: boolean }) => void) | undefined)?.({ checked });
}

function find(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  return items.find((item) => item.label === label);
}

function shape(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => item.type === "separator" ? "---" : item.role ?? item.label ?? "?");
}

describe("contextMenuTemplate", () => {

  test("links open in the system browser or copy their address", () => {
    const { calls, actions } = recorder();
    const items = contextMenuTemplate({ ...PLAIN, linkURL: "https://example.com/page", selectionText: "page" }, actions);
    expect(shape(items)).toEqual(["Open Link in Browser", "Copy Link Address", "---", "copy"]);
    press(find(items, "Open Link in Browser"));
    press(find(items, "Copy Link Address"));
    expect(calls).toEqual(["open https://example.com/page", "copy https://example.com/page"]);
  });

  test("links the system shouldn't open can only be copied", () => {
    expect(shape(contextMenuTemplate({ ...PLAIN, linkURL: "javascript:void(0)" }, recorder().actions))).toEqual(["Copy Link Address"]);
  });
});
