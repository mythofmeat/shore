import { conversationAction, openWorkspacePanel } from "./navigation.ts";
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as absolutePath } from "node:path";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return address.port;
}

async function start(root: string, origin: string, crashFixture: boolean) {
  const child = crashFixture
    ? spawn("bun", ["run", "tests/support/archive_restart_daemon.ts", root, "hold-tool"], { env: process.env, stdio: ["ignore", "ignore", "pipe"] })
    : spawn(join(root, "shore-daemon"), ["--config", join(root, "shore.toml"), "--addr", "127.0.0.1:0"], { cwd: join(root, "empty"), env: {
      ...process.env, SHORE_CONFIG_DIR: join(root, "config"), SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache"), SHORE_RUNTIME_DIR: join(root, "runtime"), SHORE_TOKEN: "restart-fixture-token",
    }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
  const stopped = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  void stopped.catch(() => {});
  const stop = async (crash = false) => {
    child.kill(crash ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    try { expect(await stopped, errors).toBe(crash ? null : 0); } finally { clearTimeout(timer); }
  };
  try { await expect.poll(() => fetch(`${origin}/api/session`, { method: "POST", headers: { origin } }).then((response) => response.status, () => 0), { timeout: 15_000 }).toBe(401); }
  catch (error) { await stop(true); throw error; }
  return stop;
}

for (const crash of [false, true]) test(`ordinary ${crash ? "unconfirmed tool effect survives process crash" : "confirmed tool result survives compiled-daemon restart"} without replay`, async ({ browser }) => {
  const root = await mkdtemp(join(tmpdir(), "shore-request-restart-"));
  let stop: Awaited<ReturnType<typeof start>> | undefined;
  const context = await browser.newContext();
  try {
    await mkdir(join(root, "empty"));
    await copyFile(absolutePath("dist/shore-daemon"), join(root, "shore-daemon"));
    const webPort = await port(); const origin = `http://127.0.0.1:${String(webPort)}`;
    await writeFile(join(root, "shore.toml"), `[tools]\nenabled = ["bash"]\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${String(webPort)}"\n`);
    stop = await start(root, origin, crash);
    const page = await context.newPage();
    let toolRequests = 0;
    page.on("websocket", (socket) => { socket.on("framesent", ({ payload }) => { const frame = String(payload); if (frame.includes('"name":"run_tool"') && !frame.includes('"describe":true')) toolRequests += 1; }); });
    await page.goto(origin);
    await page.getByLabel("Daemon token").fill("restart-fixture-token");
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Character name", { exact: true }).fill("restart");
    await dialog.getByRole("button", { name: "Run action" }).click();
    await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "R restart" }).click();
    await openWorkspacePanel(page, "Tool workbench");
    await dialog.getByRole("navigation", { name: "Available tools" }).getByRole("button", { name: "bash", exact: true }).click();
    const marker = join(root, "effect");
    const selected = dialog.getByRole("region", { name: "Selected tool" });
    await selected.getByLabel("command", { exact: true }).fill(`printf 'applied\\n' >> '${marker}'; printf 'confirmed tool output'`);
    await selected.getByRole("button", { name: "Review tool run", exact: true }).click();
    await dialog.getByRole("button", { name: "Run tool now", exact: true }).click();
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("applied\n");
    if (crash) await expect.poll(() => access(join(root, "tool-committed")).then(() => true, () => false)).toBe(true);
    else await expect(dialog.getByRole("region", { name: "Tool result", exact: true })).toContainText("confirmed tool output");
    await stop(crash); stop = undefined;
    stop = await start(root, origin, false);
    await page.reload();
    await conversationAction(page, "Request history");
    const history = page.getByRole("dialog", { name: "Request history", exact: true });
    const tool = history.getByRole("article").filter({ has: page.getByRole("heading", { name: "Run tool", exact: true }) });
    await expect(tool).toContainText(crash ? "Request outcome uncertain" : "Request completed.");
    if (!crash) { await tool.getByText("Retained result", { exact: true }).click(); await expect(tool).toContainText("confirmed tool output"); }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await history.screenshot({ path: `../out/issue-214/resume-2026-09-23/requests-${crash ? "uncertain" : "confirmed"}-mobile.png` });
    await tool.getByRole("button", { name: crash ? "I checked the outcome" : "Dismiss request", exact: true }).click();
    await expect(tool).toHaveCount(0);
    await history.getByRole("button", { name: "Close dialog" }).click();
    await page.reload();
    await conversationAction(page, "Request history");
    await expect(history.getByText("Run tool", { exact: true })).toHaveCount(0);
    expect(await readFile(marker, "utf8")).toBe("applied\n"); expect(toolRequests).toBe(1);
  } finally { try { await context.close(); } finally { try { await stop?.(); } finally { await rm(root, { recursive: true, force: true }); } } }
});
