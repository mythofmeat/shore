import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, session, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { externalUrl, needsSecureOverride, parseAddress, sameOrigin } from "./address.ts";
import { describeHttpFailure, describeLoadFailure, retryDelay, type Failure } from "./failure.ts";
import { applicationMenuTemplate, contextMenuTemplate, trayMenuTemplate, type MenuActions } from "./menus.ts";
import { readSettings, writeSettings, ZOOM_LIMIT, type Settings } from "./settings.ts";
import { unreadCount } from "./title.ts";

const MAC = process.platform === "darwin";
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SHELL_PAGE = join(ROOT, "shell", "shell.html");
const ICON = join(ROOT, "assets", "shore.png");
const TRAY_ICON = join(ROOT, "assets", "tray.png");
const TRAY_UNREAD_ICON = join(ROOT, "assets", "tray-unread.png");
const TRAY_TEMPLATE = join(ROOT, "assets", "tray-template.png");
const TRAY_UNREAD_TEMPLATE = join(ROOT, "assets", "tray-unread-template.png");
const ADDRESS_FLAG = "--address=";
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);
const ERR_ABORTED = -3;

function trayImage(unread: boolean): NativeImage {
  if (!MAC) return nativeImage.createFromPath(unread ? TRAY_UNREAD_ICON : TRAY_ICON);
  const image = nativeImage.createFromPath(unread ? TRAY_UNREAD_TEMPLATE : TRAY_TEMPLATE);
  image.setTemplateImage(true);
  return image;
}

class Desktop {
  #settings: Settings;
  #window: BrowserWindow | null = null;
  #tray: Tray | null = null;
  #quitting = false;
  #navigation = 0;
  #attempt = 0;
  #unread = false;
  readonly #secureOrigin: string | null;

  constructor(readonly settingsPath: string) {
    this.#settings = readSettings(settingsPath);
    const requested = process.argv.find((arg) => arg.startsWith(ADDRESS_FLAG));
    if (requested !== undefined) {
      const parsed = parseAddress(requested.slice(ADDRESS_FLAG.length));
      if (parsed.ok) this.#save({ address: parsed.origin });
      else console.error(`shore-desktop: ${parsed.message}`);
    }
    const address = this.#settings.address;
    this.#secureOrigin = address !== null && needsSecureOverride(address) ? address : null;
    if (this.#secureOrigin !== null) app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", this.#secureOrigin);
  }

  start(): void {
    app.on("second-instance", () => { this.#show(); });
    app.on("activate", () => { this.#show(); });
    app.on("before-quit", () => { this.#quitting = true; });
    ipcMain.handle("shell:connect", (event, input: unknown) => this.#connect(event, input));
    ipcMain.on("shell:retry", (event) => { if (this.#fromShell(event)) this.#showDaemon(); });
    ipcMain.on("shell:edit", (event) => { if (this.#fromShell(event)) this.#showConnect(); });
    ipcMain.on("page:focus", (event) => { if (this.#onDaemon(event.senderFrame?.url ?? "")) this.#show(); });
    void app.whenReady().then(() => { this.#ready(); });
  }

  #ready(): void {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(PERMISSIONS.has(permission) && this.#onDaemon(details.requestingUrl));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => PERMISSIONS.has(permission) && this.#onDaemon(origin));
    this.#tray = this.#createTray();
    this.#refreshMenus();
    this.#window = this.#createWindow();
    this.#showDaemon();
  }

  readonly #menuActions: MenuActions = {
    show: () => { this.#show(); },
    changeAddress: () => { this.#show(); this.#showConnect(); },
    reload: () => { this.#reload(); },
    setCloseToTray: (enabled) => { this.#save({ closeToTray: enabled }); this.#refreshMenus(); },
    zoom: (step) => { this.#zoom(step); },
    quit: () => { app.quit(); },
  };

  #refreshMenus(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(this.#settings.closeToTray, this.#menuActions, MAC)));
    this.#tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(this.#settings.closeToTray, this.#menuActions, MAC)));
  }

  #createWindow(): BrowserWindow {
    const { width, height, maximized } = this.#settings.window;
    const window = new BrowserWindow({
      width, height, minWidth: 360, minHeight: 420, title: "Shore", icon: ICON, backgroundColor: "#111214", autoHideMenuBar: true,
      webPreferences: { preload: join(ROOT, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, spellcheck: true },
    });
    if (maximized) window.maximize();
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => { this.#openExternal(url); return { action: "deny" }; });
    contents.on("will-navigate", (event) => {
      if (this.#onDaemon(event.url) || this.#isShell(event.url)) return;
      event.preventDefault();
      this.#openExternal(event.url);
    });
    contents.on("will-redirect", (event) => {
      if (this.#onDaemon(event.url)) return;
      event.preventDefault();
      if (event.isMainFrame) this.#failAfterLoad({ title: "This address redirects somewhere else", detail: `It sent Shore to ${event.url}. If that is the daemon, use that address instead.` });
    });
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== ERR_ABORTED && this.#onDaemon(url)) this.#failAfterLoad(describeLoadFailure(description));
    });
    contents.on("did-navigate", (_event, url, status) => {
      if (!this.#onDaemon(url)) return;
      if (status >= 400) { this.#showFailure(describeHttpFailure(status)); return; }
      this.#attempt = 0;
      contents.setZoomLevel(this.#settings.zoom);
      contents.navigationHistory.clear();
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") this.#showFailure({ title: "The page stopped unexpectedly", detail: `Chromium reported: ${details.reason}` });
    });
    contents.on("zoom-changed", (_event, direction) => { this.#zoom(direction === "in" ? 1 : -1); });
    contents.on("page-title-updated", (_event, title) => { this.#updateTray(title); });
    contents.on("context-menu", (_event, params) => {
      const template = contextMenuTemplate(params, {
        replaceMisspelling: (word) => { contents.replaceMisspelling(word); },
        addToDictionary: (word) => { contents.session.addWordToSpellCheckerDictionary(word); },
        openExternal: (url) => { this.#openExternal(url); },
        copyText: (text) => { clipboard.writeText(text); },
        copyImage: () => { contents.copyImageAt(params.x, params.y); },
        saveImage: (url) => { contents.downloadURL(url); },
      });
      if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
    });
    window.on("close", (event) => {
      const bounds = window.getNormalBounds();
      this.#save({ window: { width: bounds.width, height: bounds.height, maximized: window.isMaximized() } });
      if (this.#quitting || (!MAC && (!this.#settings.closeToTray || this.#tray === null))) return;
      event.preventDefault();
      if (MAC && window.isFullScreen()) {
        window.once("leave-full-screen", () => { window.hide(); });
        window.setFullScreen(false);
      } else {
        window.hide();
      }
    });
    window.on("closed", () => { this.#window = null; });
    return window;
  }

  #createTray(): Tray | null {
    try {
      const tray = new Tray(trayImage(false));
      tray.setToolTip("Shore");
      if (!MAC) tray.on("click", () => { this.#toggle(); });
      return tray;
    } catch (error) {
      console.error("shore-desktop: no system tray, so closing the window quits", error);
      return null;
    }
  }

  #updateTray(title: string): void {
    const tray = this.#tray;
    if (tray === null) return;
    tray.setToolTip(title);
    const unread = unreadCount(title) > 0;
    if (unread === this.#unread) return;
    this.#unread = unread;
    tray.setImage(trayImage(unread));
  }

  #show(): void {
    const window = this.#window;
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  #toggle(): void {
    if (this.#window?.isVisible() === true && this.#window.isFocused()) this.#window.hide();
    else this.#show();
  }

  #showDaemon(): void {
    const address = this.#settings.address;
    const contents = this.#window?.webContents;
    if (address === null) { this.#showConnect(); return; }
    if (contents === undefined) return;
    this.#navigation += 1;
    const navigation = this.#navigation;
    void (async () => {
      if (!this.#onDaemon(contents.getURL())) await contents.loadFile(SHELL_PAGE, { query: { view: "connecting", address } }).catch(() => {});
      if (navigation === this.#navigation) await contents.loadURL(`${address}/`).catch(() => {});
    })();
  }

  #showShell(query: Record<string, string>): void {
    this.#navigation += 1;
    this.#window?.loadFile(SHELL_PAGE, { query }).catch(() => {});
  }

  #showConnect(): void {
    this.#showShell({ view: "connect", address: this.#settings.address ?? "" });
  }

  #failAfterLoad(failure: Failure): void {
    const navigation = this.#navigation;
    this.#window?.webContents.once("did-stop-loading", () => { if (navigation === this.#navigation) this.#showFailure(failure); });
  }

  #showFailure(failure: Failure): void {
    this.#attempt += 1;
    this.#showShell({ view: "unreachable", address: this.#settings.address ?? "", title: failure.title, detail: failure.detail, retry: String(retryDelay(this.#attempt)) });
  }

  #reload(): void {
    const contents = this.#window?.webContents;
    if (contents === undefined || !this.#onDaemon(contents.getURL())) { this.#showDaemon(); return; }
    this.#navigation += 1;
    contents.reload();
  }

  #zoom(step: -1 | 0 | 1): void {
    const contents = this.#window?.webContents;
    if (contents === undefined) return;
    const level = step === 0 ? 0 : Math.min(ZOOM_LIMIT, Math.max(-ZOOM_LIMIT, contents.getZoomLevel() + step / 2));
    contents.setZoomLevel(level);
    if (this.#onDaemon(contents.getURL())) this.#save({ zoom: level });
  }

  #connect(event: IpcMainInvokeEvent, input: unknown): string | null {
    if (!this.#fromShell(event) || typeof input !== "string") return "Only Shore's own address page can change the address.";
    const parsed = parseAddress(input);
    if (!parsed.ok) return parsed.message;
    this.#save({ address: parsed.origin });
    this.#attempt = 0;
    if (needsSecureOverride(parsed.origin) && parsed.origin !== this.#secureOrigin) {
      app.relaunch({ args: process.argv.slice(1).filter((arg) => !arg.startsWith(ADDRESS_FLAG)) });
      app.quit();
    } else {
      this.#showDaemon();
    }
    return null;
  }

  #openExternal(url: string): void {
    const target = externalUrl(url);
    if (target !== null) shell.openExternal(target).catch(() => {});
  }

  #onDaemon(url: string): boolean {
    return this.#settings.address !== null && sameOrigin(url, this.#settings.address);
  }

  #isShell(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "file:" && fileURLToPath(parsed) === SHELL_PAGE;
    } catch { return false; }
  }

  #fromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url;
    return url !== undefined && this.#isShell(url);
  }

  #save(patch: Partial<Settings>): void {
    this.#settings = { ...this.#settings, ...patch };
    try { writeSettings(this.settingsPath, this.#settings); } catch (error) { console.error("shore-desktop: couldn't save settings", error); }
  }
}

if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(app.getPath("appData"), "shore-desktop"));
if (app.requestSingleInstanceLock()) new Desktop(join(app.getPath("userData"), "settings.json")).start();
else app.quit();
