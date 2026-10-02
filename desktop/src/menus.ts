import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { externalUrl } from "./address.ts";

export type ContextParams = Pick<ContextMenuParams, "dictionarySuggestions" | "misspelledWord" | "linkURL" | "mediaType" | "srcURL" | "isEditable" | "editFlags" | "selectionText">;

export interface ContextActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  openExternal(url: string): void;
  copyText(text: string): void;
  copyImage(): void;
  saveImage(url: string): void;
}

export interface MenuActions {
  show(): void;
  changeAddress(): void;
  reload(): void;
  setCloseToTray(enabled: boolean): void;
  zoom(step: -1 | 0 | 1): void;
  quit(): void;
}

function closeToTrayItem(closeToTray: boolean, actions: MenuActions): MenuItemConstructorOptions {
  return { label: "Close to Tray", type: "checkbox", checked: closeToTray, click: (item) => { actions.setCloseToTray(item.checked); } };
}

export function contextMenuTemplate(params: ContextParams, actions: ContextActions): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  if (params.misspelledWord !== "") {
    groups.push([
      ...params.dictionarySuggestions.slice(0, 5).map((word): MenuItemConstructorOptions => ({ label: word, click: () => { actions.replaceMisspelling(word); } })),
      { label: "Add to Dictionary", click: () => { actions.addToDictionary(params.misspelledWord); } },
    ]);
  }
  if (params.linkURL !== "") {
    const external = externalUrl(params.linkURL);
    groups.push([
      ...(external === null ? [] : [{ label: "Open Link in Browser", click: () => { actions.openExternal(external); } }]),
      { label: "Copy Link Address", click: () => { actions.copyText(params.linkURL); } },
    ]);
  }
  if (params.mediaType === "image" && params.srcURL !== "") {
    groups.push([
      { label: "Copy Image", click: () => { actions.copyImage(); } },
      { label: "Save Image As…", click: () => { actions.saveImage(params.srcURL); } },
    ]);
  }
  if (params.isEditable) {
    const flags = params.editFlags;
    groups.push(
      [{ role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo }],
      [{ role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy }, { role: "paste", enabled: flags.canPaste }],
      [{ role: "selectAll", enabled: flags.canSelectAll }],
    );
  } else if (params.selectionText.trim() !== "") {
    groups.push([{ role: "copy" }]);
  }
  return groups.flatMap((group, index) => index === 0 ? group : [{ type: "separator" }, ...group]);
}

export function applicationMenuTemplate(closeToTray: boolean, actions: MenuActions, mac: boolean): MenuItemConstructorOptions[] {
  const changeAddress: MenuItemConstructorOptions = { label: "Change Daemon Address…", click: () => { actions.changeAddress(); } };
  const reload: MenuItemConstructorOptions = { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => { actions.reload(); } };
  const view: MenuItemConstructorOptions[] = [
    { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => { actions.zoom(0); } },
    { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => { actions.zoom(1); } },
    { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => { actions.zoom(-1); } },
    { type: "separator" },
    { role: "togglefullscreen" },
    { role: "toggleDevTools" },
  ];
  if (mac) {
    return [
      { role: "appMenu", submenu: [
        { role: "about" },
        { type: "separator" },
        changeAddress,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ] },
      { role: "fileMenu" },
      { role: "editMenu" },
      { label: "View", submenu: [reload, { type: "separator" }, ...view] },
      { role: "windowMenu" },
    ];
  }
  return [
    { label: "&Shore", submenu: [
      changeAddress,
      reload,
      { type: "separator" },
      closeToTrayItem(closeToTray, actions),
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { actions.quit(); } },
    ] },
    { role: "editMenu" },
    { label: "&View", submenu: view },
  ];
}

export function trayMenuTemplate(closeToTray: boolean, actions: MenuActions, mac: boolean): MenuItemConstructorOptions[] {
  const closing: MenuItemConstructorOptions[] = mac ? [] : [closeToTrayItem(closeToTray, actions), { type: "separator" }];
  return [
    { label: "Show Shore", click: () => { actions.show(); } },
    { label: "Change Daemon Address…", click: () => { actions.changeAddress(); } },
    { type: "separator" },
    ...closing,
    { label: "Quit Shore", click: () => { actions.quit(); } },
  ];
}
