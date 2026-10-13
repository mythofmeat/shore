import { spawn } from "node:child_process";
import { electronCommand, exited, expect, test } from "./fixtures.ts";

test("the menu bar has macOS's own menus, with Shore's commands in them", async ({ launch }) => {
  const { app } = await launch();
  const menus = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => [item.label, item.submenu?.items.map((entry) => entry.label).filter((label) => label !== "")]));
  expect(menus?.map(([label]) => label)).toEqual(["Shore", "File", "Edit", "View", "Window"]);
  expect(menus?.[0]?.[1]).toEqual(["About Shore", "Change Daemon Address…", "Services", "Hide Shore", "Hide Others", "Show All", "Quit Shore"]);
  expect(menus?.[1]?.[1]).toEqual(["Close Window"]);
  expect(menus?.[3]?.[1]?.[0]).toBe("Reload");
});

test("closing keeps Shore in the Dock, which brings the window back, and quitting ends it", async ({ launch, profile }) => {
  const { app, page } = await launch();
  await expect(page.getByLabel("Address")).toBeVisible();
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), fullScreen: window.isFullScreen() })));
  const close = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
  await close();
  await expect.poll(windows).toEqual([{ visible: false, fullScreen: false }]);
  await app.evaluate(({ app }) => { app.emit("activate"); });
  await expect.poll(windows).toEqual([{ visible: true, fullScreen: false }]);

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setFullScreen(true); });
  await expect.poll(windows).toEqual([{ visible: true, fullScreen: true }]);
  await close();
  await expect.poll(windows).toEqual([{ visible: false, fullScreen: false }]);

  const { command, args, env } = electronCommand(profile);
  const second = spawn(command, args, { env, stdio: "ignore" });
  expect(await exited(second)).toBe(0);
  await expect.poll(windows).toEqual([{ visible: true, fullScreen: false }]);

  const quit = exited(app.process());
  await app.evaluate(({ app }) => { setTimeout(() => { app.quit(); }, 0); });
  expect(await quit).toBe(0);
});
