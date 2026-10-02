import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate, contextMenuTemplate, trayMenuTemplate, type ContextActions, type ContextParams, type MenuActions } from "../src/menus.ts";

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
  test("nothing under the pointer means no menu", () => {
    expect(contextMenuTemplate(PLAIN, recorder().actions)).toEqual([]);
  });

  test("selected text can be copied", () => {
    expect(shape(contextMenuTemplate({ ...PLAIN, selectionText: "hello" }, recorder().actions))).toEqual(["copy"]);
    expect(contextMenuTemplate({ ...PLAIN, selectionText: "  \n" }, recorder().actions)).toEqual([]);
  });

  test("text fields get the edit commands, enabled as Chromium reports", () => {
    const items = contextMenuTemplate({ ...PLAIN, isEditable: true, selectionText: "hi" }, recorder().actions);
    expect(shape(items)).toEqual(["undo", "redo", "---", "cut", "copy", "paste", "---", "selectAll"]);
    expect(items.find((item) => item.role === "redo")?.enabled).toBe(false);
    expect(items.find((item) => item.role === "paste")?.enabled).toBe(true);
  });

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

  test("images can be copied or saved", () => {
    const { calls, actions } = recorder();
    const items = contextMenuTemplate({ ...PLAIN, mediaType: "image", srcURL: "blob:http://meat:7340/1" }, actions);
    expect(shape(items)).toEqual(["Copy Image", "Save Image As…"]);
    press(find(items, "Copy Image"));
    press(find(items, "Save Image As…"));
    expect(calls).toEqual(["copy image", "save blob:http://meat:7340/1"]);
  });

  test("misspellings offer at most five suggestions and the dictionary", () => {
    const { calls, actions } = recorder();
    const items = contextMenuTemplate({ ...PLAIN, isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tech", "eh", "tea", "teeth"] }, actions);
    expect(shape(items).slice(0, 7)).toEqual(["the", "ten", "tech", "eh", "tea", "Add to Dictionary", "---"]);
    press(find(items, "the"));
    press(find(items, "Add to Dictionary"));
    expect(calls).toEqual(["replace the", "learn teh"]);
  });
});

function menuRecorder(): { calls: string[]; actions: MenuActions } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      show: () => { calls.push("show"); },
      changeAddress: () => { calls.push("address"); },
      reload: () => { calls.push("reload"); },
      setCloseToTray: (enabled) => { calls.push(`close to tray ${String(enabled)}`); },
      zoom: (step) => { calls.push(`zoom ${String(step)}`); },
      quit: () => { calls.push("quit"); },
    },
  };
}

function submenus(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [item]);
}

describe("applicationMenuTemplate", () => {
  test("reload, quit and zoom have the usual shortcuts", () => {
    const { calls, actions } = menuRecorder();
    const menu = applicationMenuTemplate(false, actions, false);
    const items = submenus(menu);
    expect(find(items, "Reload")?.accelerator).toBe("CmdOrCtrl+R");
    expect(find(items, "Quit")?.accelerator).toBe("CmdOrCtrl+Q");
    for (const label of ["Change Daemon Address…", "Reload", "Quit", "Zoom In", "Zoom Out", "Actual Size"]) press(find(items, label));
    expect(calls).toEqual(["address", "reload", "quit", "zoom 1", "zoom -1", "zoom 0"]);
    expect(menu.some((entry) => entry.role === "editMenu")).toBe(true);
  });

  test("macOS gets its standard menus, with Shore's commands in them", () => {
    const { calls, actions } = menuRecorder();
    const menu = applicationMenuTemplate(true, actions, true);
    expect(shape(menu)).toEqual(["appMenu", "fileMenu", "editMenu", "View", "windowMenu"]);
    expect(shape(submenus(menu.slice(0, 1)))).toEqual(["about", "---", "Change Daemon Address…", "---", "services", "---", "hide", "hideOthers", "unhide", "---", "quit"]);
    const view = submenus(menu.slice(3, 4));
    expect(shape(view)).toEqual(["Reload", "---", "Actual Size", "Zoom In", "Zoom Out", "---", "togglefullscreen", "toggleDevTools"]);
    expect(find(view, "Reload")?.accelerator).toBe("CmdOrCtrl+R");
    for (const label of ["Change Daemon Address…", "Reload", "Zoom In", "Zoom Out", "Actual Size"]) press(find(submenus(menu), label));
    expect(calls).toEqual(["address", "reload", "zoom 1", "zoom -1", "zoom 0"]);
  });
});

describe("Close to Tray", () => {
  test("both menus show the setting and change it", () => {
    for (const template of [applicationMenuTemplate, trayMenuTemplate]) {
      const { calls, actions } = menuRecorder();
      expect(find(submenus(template(true, actions, false)), "Close to Tray")?.checked).toBe(true);
      const item = find(submenus(template(false, actions, false)), "Close to Tray");
      expect(item?.checked).toBe(false);
      press(item, true);
      expect(calls).toEqual(["close to tray true"]);
    }
  });

  test("macOS has no setting to offer, since closing always keeps Shore in the Dock", () => {
    for (const template of [applicationMenuTemplate, trayMenuTemplate]) {
      expect(find(submenus(template(true, menuRecorder().actions, true)), "Close to Tray")).toBeUndefined();
    }
  });

  test("the tray menu can bring the window back and quit", () => {
    for (const mac of [false, true]) {
      const { calls, actions } = menuRecorder();
      const items = trayMenuTemplate(true, actions, mac);
      press(find(items, "Show Shore"));
      press(find(items, "Change Daemon Address…"));
      press(find(items, "Quit Shore"));
      expect(calls).toEqual(["show", "address", "quit"]);
    }
    expect(shape(trayMenuTemplate(true, menuRecorder().actions, true))).toEqual(["Show Shore", "Change Daemon Address…", "---", "Quit Shore"]);
  });
});
