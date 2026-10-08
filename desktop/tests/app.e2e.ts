import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { electronCommand, exited, expect, signIn, test } from "./fixtures.ts";

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  return port;
}

test("first run asks for the daemon's address, then stays signed in", async ({ daemon, launch }) => {
  const first = await launch();
  const address = first.page.getByLabel("Address");
  await expect(address).toBeFocused();
  expect(await first.page.evaluate(() => ["shoreDesktop" in window, Notification.permission])).toEqual([true, "denied"]);
  expect(await first.page.evaluate(() => document.fonts.check("14px Geist"))).toBe(true);
  await address.fill("ftp://example.com");
  await first.page.getByRole("button", { name: "Continue" }).click();
  await expect(first.page.getByRole("alert")).toHaveText("Use an http:// or https:// address.");
  await address.fill(`127.0.0.1:${String(daemon.port)}`);
  await first.page.getByRole("button", { name: "Continue" }).click();
  await signIn(first.page);
  expect(await first.page.evaluate(() => "shoreDesktop" in window)).toBe(false);
  expect((await first.settings()).address).toBe(daemon.origin);
  await first.app.close();

  const second = await launch();
  await expect(second.page.getByText("Connected", { exact: true })).toBeVisible();
  expect(new URL(second.page.url()).origin).toBe(daemon.origin);
});

test("chats through the app, and the window title follows the conversation", async ({ daemon, launch }) => {
  const { app, page } = await launch({ address: daemon.origin });
  await signIn(page);
  await page.getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });
  await dialog.getByLabel("Name").fill("Nova");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("hello from the desktop app");
  await box.press("Enter");
  await expect(page.locator("article.message.assistant").last()).toContainText("hello from the desktop app");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe("Nova · Shore");
});

test("right-clicking selected reply text offers Quote, which puts it in the message box", async ({ daemon, launch }) => {
  const { app, page } = await launch({ address: daemon.origin });
  await signIn(page);
  await page.getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });
  await dialog.getByLabel("Name").fill("Quill");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("quote me please");
  await box.press("Enter");
  const reply = page.locator("article.message.assistant .prose p").last();
  await expect(reply).toContainText("quote me please");
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function (this: Electron.Menu) { (globalThis as { shown?: Electron.Menu }).shown = this; };
  });
  const shown = () => app.evaluate(() => (globalThis as { shown?: Electron.Menu }).shown?.items.map((item) => item.label || item.role) ?? []);
  await reply.click({ clickCount: 3 });
  await reply.click({ button: "right" });
  await expect.poll(shown).toEqual(["Copy", "Quote"]);
  await app.evaluate(() => { (globalThis as { shown?: Electron.Menu }).shown?.items.find((item) => item.label === "Quote")?.click(); });
  await expect(box).toHaveValue(/^> Answer \d+: quote me please\n\n$/);
  await expect(box).toBeFocused();
});

test("plain HTTP to another host still gets a secure context and notifications", async ({ daemon, launch }) => {
  const { page } = await launch({ address: `http://shore.test:${String(daemon.port)}` });
  await expect(page.getByLabel("Access token")).toBeVisible();
  expect(await page.evaluate(() => [isSecureContext, Notification.permission])).toEqual([true, "granted"]);
  expect(await page.evaluate(() => Notification.requestPermission())).toBe("granted");
  await signIn(page);
});

test("links open in the system browser and the window stays on the daemon", async ({ daemon, launch }) => {
  const { app, page } = await launch({ address: daemon.origin });
  await expect(page.getByLabel("Access token")).toBeVisible();
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url: string) => { opened.push(url); };
  });
  await page.evaluate(() => {
    window.open("https://example.com/from-window-open");
    window.open("file:///etc/passwd");
    location.href = "https://example.org/from-navigation";
  });
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual(["https://example.com/from-window-open", "https://example.org/from-navigation"]);
  expect(app.windows()).toHaveLength(1);
  expect(new URL(page.url()).origin).toBe(daemon.origin);
});

test("an unreachable daemon explains itself, retries, and the address can change", async ({ daemon, launch }) => {
  const port = await closedPort();
  const { page, settings } = await launch({ address: `127.0.0.1:${String(port)}` });
  await expect(page.getByRole("heading", { name: "Nothing is listening at this address" })).toBeVisible();
  await expect(page.getByText(`http://127.0.0.1:${String(port)}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/^Trying again in [12] s$/)).toBeVisible();
  await expect(page.getByText(/^Trying again in [345] s$/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Change address" }).click();
  await expect(page.getByLabel("Address")).toHaveValue(`http://127.0.0.1:${String(port)}`);
  await page.getByLabel("Address").fill(daemon.origin);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  expect((await settings()).address).toBe(daemon.origin);
});

test("the CLI's port is recognized as not being the browser listener", async ({ daemon, launch }) => {
  const { page } = await launch({ address: `127.0.0.1:${String(daemon.tcpPort)}` });
  await expect(page.getByRole("heading", { name: "Something answered, but not Shore's browser listener" })).toBeVisible();
});

test("a starting daemon and a redirect elsewhere are explained", async ({ launch }) => {
  let redirect = false;
  const server = createHttpServer((_request, response) => {
    if (redirect) response.writeHead(302, { location: "https://example.com/elsewhere" }).end();
    else response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ code: "unavailable", message: "The daemon is not ready" }));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const { page } = await launch({ address: `127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    await expect(page.getByRole("heading", { name: "The daemon isn't ready yet" })).toBeVisible();
    redirect = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "This address redirects somewhere else" })).toBeVisible();
    await expect(page.getByText("https://example.com/elsewhere", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Change address" }).click();
    await expect(page.getByLabel("Address")).toBeFocused();
  } finally {
    server.close();
  }
});

test("KWin draws the frame, closing keeps Shore running, and a notification click or second launch brings it back", async ({ daemon, launch, profile }) => {
  const { app, page, settings } = await launch({ address: daemon.origin });
  await expect(page.getByLabel("Access token")).toBeVisible();
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(900, 700);
    return { outer: window?.getBounds(), inner: window?.getContentBounds() };
  });
  expect(bounds.outer).toEqual(bounds.inner);
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));
  const close = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
  await close();
  await expect.poll(visible).toEqual([false]);
  expect((await settings()).window).toEqual({ width: 900, height: 700, maximized: false });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript("window.focus()", true));
  await expect.poll(visible).toEqual([true]);
  await close();
  await expect.poll(visible).toEqual([false]);

  const { command, args, env } = electronCommand(profile);
  const second = spawn(command, args, { env, stdio: "ignore" });
  expect(await exited(second)).toBe(0);
  await expect.poll(visible).toEqual([true]);
});
