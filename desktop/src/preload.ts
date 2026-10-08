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
  addEventListener("shore:quote-ready", () => { ipcRenderer.send("page:quote-ready"); });
  ipcRenderer.on("page:quote", () => { dispatchEvent(new Event("shore:quote-selection")); });
}
