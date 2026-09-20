import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as absolutePath } from "node:path";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return address.port;
}

function tcpReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
    socket.on("connect", () => { socket.write(JSON.stringify({ type: "hello", client_type: "cli", client_name: "packaged-test", capabilities: [], token: "packaged-test-token" }) + "\n"); });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('"type":"hello"')) { clearTimeout(timer); socket.destroy(); resolve(true); }
    });
  });
}

test("the compiled executable serves a real browser from an empty directory and can disable web serving", async ({ browser }) => {
  const root = await mkdtemp(join(tmpdir(), "shore-packaged-gui-"));
  try {
    const binary = join(root, "shore-daemon");
    await copyFile(absolutePath("dist/shore-daemon"), binary);
    for (const enabled of [false, true]) {
      const workingDirectory = join(root, enabled ? "enabled-empty" : "disabled-empty");
      await mkdir(workingDirectory);
      const tcp = await unusedPort(); const web = await unusedPort();
      const origin = `http://127.0.0.1:${String(web)}`;
      const config = join(root, `config-${String(enabled)}.toml`);
      await writeFile(config, `[daemon.web]\nenabled = ${String(enabled)}\nbind_addr = "127.0.0.1:${String(web)}"\n`);
      const launch = () => {
        const child = spawn(binary, ["--config", config, "--addr", `127.0.0.1:${String(tcp)}`], { cwd: workingDirectory, env: {
          HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"), SHORE_TOKEN: "packaged-test-token",
        }, stdio: ["ignore", "ignore", "pipe"] });
        let errors = "";
        child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
        const stopped = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
        void stopped.catch(() => {});
        return async () => {
          child.kill("SIGTERM");
          const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
          try { expect(await stopped, errors).toBe(0); } finally { clearTimeout(deadline); }
        };
      };
      let stop = launch();
      try {
        await expect.poll(() => tcpReady(tcp), { message: "Packaged TCP handshake must work", timeout: 10_000 }).toBe(true);
        if (!enabled) {
          const reachable = await fetch(origin).then(() => true, () => false);
          expect(reachable).toBe(false);
          expect(await access(join(root, "cache", "shore", "web")).then(() => true, () => false)).toBe(false);
          continue;
        }
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => { pageErrors.push(error.message); });
          await page.goto(`${origin}/workspace`);
          await page.getByLabel("Daemon token").fill("packaged-test-token");
          await page.getByRole("button", { name: "Open workspace" }).click();
          await page.getByRole("button", { name: "Create character", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("Character name", { exact: true }).fill("packaged");
          await dialog.getByRole("button", { name: "Run action" }).click();
          await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
          await dialog.getByRole("button", { name: "Close dialog" }).click();
          await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "P packaged" }).click();
          await expect(page.getByRole("heading", { name: "packaged / main" })).toBeVisible();
          await page.reload();
          await expect(page.getByRole("heading", { name: "packaged / main" })).toBeVisible();
          await page.getByRole("button", { name: "Character archives", exact: true }).click();
          await dialog.getByRole("button", { name: "Prepare archive", exact: true }).click();
          await expect(dialog.getByText("Export ready to download.", { exact: true })).toBeVisible();
          const downloading = page.waitForEvent("download");
          await dialog.getByRole("button", { name: "Download archive", exact: true }).click();
          const download = await downloading;
          expect(download.suggestedFilename()).toBe("packaged.shore.tar.gz");
          const archive = join(root, "picked-backup.tar.gz");
          await download.saveAs(archive);
          await dialog.getByRole("button", { name: "Delete character…", exact: true }).click();
          await dialog.getByLabel("Repeat character name", { exact: true }).fill("packaged");
          await dialog.getByRole("button", { name: "Run action" }).click();
          await dialog.getByRole("button", { name: "Confirm delete", exact: true }).click();
          await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
          await expect(page.getByRole("navigation", { name: "Characters" })).not.toContainText("packaged");
          await dialog.getByRole("button", { name: "Close dialog" }).click();
          await page.getByRole("button", { name: "Character archives", exact: true }).click();
          await expect(dialog.getByLabel("Archive file", { exact: true })).toBeEnabled();
          await dialog.getByLabel("Archive file", { exact: true }).setInputFiles(archive);
          await dialog.getByRole("button", { name: "Import archive", exact: true }).click();
          await dialog.getByRole("button", { name: "Confirm import", exact: true }).click();
          await expect(dialog.getByText("Import completed for packaged. Temporary upload removed.", { exact: true })).toBeVisible();
          await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
          await dialog.getByRole("button", { name: "Close dialog" }).click();
          await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "P packaged" }).click();
          await expect(page.getByRole("heading", { name: "packaged / main" })).toBeVisible();
          await stop(); stop = launch();
          await expect.poll(() => tcpReady(tcp), { message: "Packaged daemon must restart", timeout: 10_000 }).toBe(true);
          await page.reload();
          await expect(page.getByRole("heading", { name: "packaged / main" })).toBeVisible();
          await page.getByRole("button", { name: "Character archives", exact: true }).click();
          await expect(dialog.getByText("Import completed for packaged. Temporary upload removed.", { exact: true })).toBeVisible();
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
      } finally { await stop(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
