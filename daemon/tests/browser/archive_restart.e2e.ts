import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return address.port;
}

async function start(root: string, hold: boolean) {
  const child = spawn("bun", ["run", "tests/support/archive_restart_daemon.ts", root, hold ? "hold-import" : "normal"], {
    env: { ...process.env, TMPDIR: join(root, "tmp") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
  const stopped = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  void stopped.catch(() => {});
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`Restart fixture did not start: ${errors}`)), 15_000);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("SHORE_RESTART_READY")) resolve(); });
      void stopped.then(() => reject(new Error(`Restart fixture exited: ${errors}`)), reject);
    });
  } catch (error) { child.kill("SIGKILL"); await stopped; throw error; }
  finally { clearTimeout(deadline); }
  return async (crash = false) => {
    child.kill(crash ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { expect(await stopped, errors).toBe(crash ? null : 0); } finally { clearTimeout(timer); }
  };
}

for (const crash of [false, true]) test(`archive ${crash ? "uncertain committed" : "confirmed"} import survives daemon ${crash ? "crash" : "restart"} without replay`, async ({ browser }) => {
  const root = await mkdtemp(join(tmpdir(), "shore-archive-restart-"));
  let stop: Awaited<ReturnType<typeof start>> | undefined;
  const context = await browser.newContext();
  try {
    await mkdir(join(root, "tmp"));
    const webPort = await port(); const origin = `http://127.0.0.1:${String(webPort)}`;
    await writeFile(join(root, "shore.toml"), `[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${String(webPort)}"\n`);
    stop = await start(root, crash);
    const page = await context.newPage();
    let imports = 0;
    page.on("request", (request) => { if (request.url().endsWith("/import")) imports += 1; });
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
    await page.getByRole("button", { name: "Character archives", exact: true }).click();
    await dialog.getByRole("button", { name: "Prepare archive", exact: true }).click();
    await expect(dialog.getByText("Export ready to download.", { exact: true })).toBeVisible();
    const downloading = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download archive", exact: true }).click();
    const archive = join(root, "picked.tar.gz");
    await (await downloading).saveAs(archive);
    const exported = gunzipSync(await readFile(archive));
    expect(exported.includes("recovery.sqlite")).toBe(false);
    expect(exported.includes("restart-fixture-token")).toBe(false);
    for (const cookie of await context.cookies()) expect(exported.includes(cookie.value)).toBe(false);
    await dialog.getByRole("button", { name: "Delete character…", exact: true }).click();
    await dialog.getByLabel("Repeat character name", { exact: true }).fill("restart");
    await dialog.getByRole("button", { name: "Run action" }).click();
    await dialog.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Character archives", exact: true }).click();
    await expect(dialog.getByLabel("Archive file", { exact: true })).toBeEnabled();
    await dialog.getByLabel("Archive file", { exact: true }).setInputFiles(archive);
    await dialog.getByRole("button", { name: "Import archive", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm import", exact: true }).click();
    if (crash) await expect.poll(() => access(join(root, "import-committed")).then(() => true, () => false)).toBe(true);
    else await expect(dialog.getByText("Import completed for restart. Temporary upload removed.", { exact: true })).toBeVisible();
    const recoveryDirectory = (await readdir(join(root, "cache", "web"))).at(0);
    if (recoveryDirectory === undefined) throw new Error("Missing recovery directory");
    const artifacts = join(root, "cache", "web", recoveryDirectory, "artifacts");
    if (crash) expect(await readdir(artifacts)).toHaveLength(1);
    await stop(crash); stop = undefined;
    await expect(dialog.getByRole("button", { name: "Refresh transfers", exact: true })).toBeDisabled();
    stop = await start(root, false);
    if (crash) expect((await readdir(join(root, "tmp"))).filter((name) => name.startsWith("shore-web-archive-"))).toEqual([]);
    expect(await readdir(artifacts)).toEqual([]);
    await expect(dialog.getByRole("button", { name: "Refresh transfers", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Refresh transfers", exact: true }).click();
    if (crash) await expect(dialog.getByRole("alert")).toContainText("The import outcome is uncertain.");
    else await expect(dialog.getByText("Import completed for restart. Temporary upload removed.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Character archives", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Character archives", exact: true }).click();
    if (crash) await expect(dialog.getByRole("alert")).toContainText("The import outcome is uncertain.");
    else await expect(dialog.getByText("Import completed for restart. Temporary upload removed.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Import archive", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Characters" })).toContainText("restart");
    expect(imports).toBe(1);
  } finally { try { await context.close(); } finally { try { await stop?.(); } finally { await rm(root, { recursive: true, force: true }); } } }
});
