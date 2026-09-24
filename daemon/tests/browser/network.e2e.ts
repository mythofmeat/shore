import { openWorkspacePanel } from "./navigation.ts";
import type { Page } from "@playwright/test";
import { connect, createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { expect, test } from "./fixtures.ts";

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP shore.test-tailnet.ts.net 127.0.0.1, MAP custom.shore.test 127.0.0.1", "--no-proxy-server"] } });

async function exerciseWorkspace(page: Page, origin: string, secureContext: boolean): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  await page.goto(`${origin}/workspace`);
  expect(await page.evaluate("window.isSecureContext")).toBe(secureContext);
  expect(await page.evaluate("typeof crypto.randomUUID")).toBe(secureContext ? "function" : "undefined");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("nova");
  await dialog.getByRole("button", { name: "Run action" }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Hello through the network");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const answer = page.getByRole("article", { name: "assistant message" });
  await expect(answer).toContainText("Answer 1: Hello through the network");
  if (!secureContext) {
    expect(await page.evaluate("typeof navigator.clipboard")).toBe("undefined");
    await page.evaluate("window.shoreCopyEvents = 0; document.addEventListener('copy', () => window.shoreCopyEvents++)");
    await answer.getByRole("button", { name: "Copy", exact: true }).click();
    expect(await page.evaluate("window.shoreCopyEvents")).toBe(1);
  }
  await page.getByLabel("Message", { exact: true }).fill("Network draft survives reload");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles({ name: "network.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==", "base64") });
  await expect(page.getByRole("status").filter({ hasText: "Draft saved on this device" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Network draft survives reload");
  await expect(page.getByRole("button", { name: "Remove network.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await openWorkspacePanel(page, "Disconnect");
  await expect(page.getByLabel("Daemon token")).toBeVisible();
  expect(errors).toEqual([]);
}

test("an SSH-style TCP forward works with localhost and a different browser port", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Missing daemon origin");
  const upstream = new URL(baseURL);
  const sockets = new Set<Socket>();
  const forwarder = createServer((incoming) => {
    const outgoing = connect(Number(upstream.port), upstream.hostname);
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); });
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => { forwarder.once("error", reject); forwarder.listen(0, "127.0.0.1", resolve); });
  try {
    const address = forwarder.address();
    if (address === null || typeof address === "string") throw new Error("Missing tunnel address");
    expect(address.port).not.toBe(Number(upstream.port));
    await exerciseWorkspace(page, `http://localhost:${String(address.port)}`, true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { forwarder.close((error) => { if (error === undefined) resolve(); else reject(error); }); });
  }
});

test.describe("LAN listener", () => {
  test.use({ webBind: "0.0.0.0:0" });
  test("plain HTTP on a LAN address supports chat, copy, attachments and draft recovery", async ({ page, baseURL }) => {
    const address = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).find((entry) => !entry.internal && entry.family === "IPv4")?.address;
    test.skip(address === undefined, "No LAN IPv4 address on this host");
    if (baseURL === undefined || address === undefined) throw new Error("Missing LAN origin");
    const origin = new URL(baseURL);
    origin.hostname = address;
    await exerciseWorkspace(page, origin.origin, false);
  });
});

test.describe("DNS access", () => {
  for (const host of ["shore.test-tailnet.ts.net", "custom.shore.test"]) {
    test(`HTTP on ${host} supports the workspace without hostname configuration`, async ({ page, baseURL }) => {
      if (baseURL === undefined) throw new Error("Missing daemon origin");
      const origin = new URL(baseURL);
      origin.hostname = host;
      await exerciseWorkspace(page, origin.origin, false);
    });
  }
});
