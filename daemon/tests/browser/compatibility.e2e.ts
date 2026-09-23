import { expect, test } from "./fixtures.ts";

test("an incompatible open browser gets an actionable reload without attaching or replaying work", async ({ page }) => {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("button", { name: "All actions", exact: true })).toBeEnabled();
  let incompatible = true;
  let sockets = 0;
  page.on("websocket", () => { sockets += 1; });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    if (!incompatible) { await route.fulfill({ response }); return; }
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid session fixture");
    await route.fulfill({ response, json: { ...body, contract: "incompatible-release" } });
  });
  await page.reload();
  await expect(page.getByText("Shore was upgraded.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload workspace", exact: true })).toBeVisible();
  expect(sockets).toBe(0);
  incompatible = false;
  await page.getByRole("button", { name: "Reload workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All actions", exact: true })).toBeEnabled();
  expect(sockets).toBe(1);
});
