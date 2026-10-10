import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.ts";

declare const location: { readonly protocol: string };
declare function dispatchEvent(event: Event): boolean;

if (location.protocol === "file:") {
  const bridge: DesktopBridge = {
    connect: (address) => ipcRenderer.invoke("shell:connect", address) as Promise<string | null>,
    retry: () => { ipcRenderer.send("shell:retry"); },
    edit: () => { ipcRenderer.send("shell:edit"); },
  };
  contextBridge.exposeInMainWorld("shoreDesktop", bridge);
} else {
  contextBridge.executeInMainWorld({
    func: (raise: () => void) => {
      const scope = globalThis as unknown as { focus(): void };
      const focus = scope.focus.bind(scope);
      scope.focus = () => { raise(); focus(); };
    },
    args: [() => { ipcRenderer.send("page:focus"); }],
  });
  // Chromium's notifications never reach the screen on macOS (see notify.ts), so the page's go to the main process.
  if (process.platform === "darwin") {
    contextBridge.executeInMainWorld({
      func: (notify: (title: string, body: string) => void) => {
        class AppleScriptNotification {
          static readonly permission = "granted";
          static requestPermission(): Promise<string> { return Promise.resolve("granted"); }
          onclick: (() => void) | null = null;
          constructor(title: string, options?: { body?: string }) { notify(String(title), String(options?.body ?? "")); }
          close(): void {}
        }
        Object.defineProperty(globalThis, "Notification", { value: AppleScriptNotification, configurable: true, writable: true });
      },
      args: [(title: string, body: string) => { ipcRenderer.send("page:notify", title, body); }],
    });
  }
  addEventListener("shore:quote-ready", () => { ipcRenderer.send("page:quote-ready"); });
  ipcRenderer.on("page:quote", () => { dispatchEvent(new Event("shore:quote-selection")); });
}
