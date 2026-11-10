import { expect, test } from "./fixtures.ts";
import { signIn, watchPage } from "./helpers.ts";

test("a wrong token is rejected with a readable error and the right token connects", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  await page.addInitScript("window.shorePolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.shorePolicyViolations.push(event.violatedDirective));");
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Connect to your daemon" })).toBeVisible();
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeDisabled();
  await page.getByLabel("Access token").fill("wrong-token");
  await connect.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Access token").fill("browser-test-token");
  await connect.click();
  await expect(page.getByRole("heading", { name: "Connect to your daemon" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  expect(await page.evaluate("window.shorePolicyViolations")).toEqual([]);
  expect(errors).toEqual([]);
});

test("a sign-in code from Settings › Devices signs in another browser once, and its link leaves no trace", async ({ page, browser, baseURL }) => {
  const check = await watchPage(page);
  await signIn(page);
  await page.goto(`${new URL(page.url()).pathname}#settings/devices`);
  await expect(page.locator(".settings-page h1")).toHaveText("Devices");
  const address = page.getByLabel("Address the other device opens");
  await expect(address).toHaveValue("");
  const show = page.getByRole("button", { name: "Show sign-in code" });
  await expect(show).toBeDisabled();
  await address.fill(baseURL ?? "");
  await expect(page.getByText("only reaches this computer")).toBeVisible();
  await show.click();
  await expect(page.getByRole("img", { name: "Sign-in code" })).toBeVisible();
  await expect(page.getByText(/^Expires in [45]:\d\d$/)).toBeVisible();
  const link = await page.locator(".login-code-link").textContent() ?? "";
  expect(link).toMatch(new RegExp(`^${baseURL ?? ""}/#login=[A-Za-z0-9_-]{43}$`));
  const phone = await (await browser.newContext()).newPage();
  const phoneCheck = await watchPage(phone);
  await phone.goto(link);
  await expect(phone.getByText("Connected", { exact: true })).toBeVisible();
  expect(new URL(phone.url()).hash).toBe("");
  await phoneCheck();
  const late = await (await browser.newContext()).newPage();
  await late.goto(link);
  await expect(late.getByRole("alert")).toContainText("expired or was already used");
  await expect(late.getByLabel("Access token")).toBeVisible();
  await check();
});

test("settings chosen at one address are there at another address of the same daemon, and a change made later arrives when the page is next focused", async ({ page, browser, baseURL }) => {
  const check = await watchPage(page);
  await signIn(page);
  await page.goto(`${new URL(page.url()).pathname}#settings/appearance`);
  await page.getByRole("radio", { name: /Sodium fog/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fog");
  await page.goto(`${new URL(page.url()).pathname}#settings/keyboard`);
  await page.getByRole("switch", { name: "Vim mode", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Vim mode", exact: true })).toHaveAttribute("aria-checked", "true");

  const elsewhere = await (await browser.newContext()).newPage();
  const elsewhereCheck = await watchPage(elsewhere);
  const other = (baseURL ?? "").replace("127.0.0.1", "localhost");
  expect(other).not.toBe(baseURL);
  await signIn(elsewhere, `${other}/workspace`);
  await expect(elsewhere.locator("html")).toHaveAttribute("data-theme", "fog");
  await elsewhere.goto(`${other}${new URL(elsewhere.url()).pathname}#settings/keyboard`);
  await expect(elsewhere.getByRole("switch", { name: "Vim mode", exact: true })).toHaveAttribute("aria-checked", "true");
  await elsewhere.reload();
  await expect(elsewhere.locator("html")).toHaveAttribute("data-theme", "fog");

  await elsewhere.getByRole("switch", { name: "Vim mode", exact: true }).click();
  await expect(elsewhere.getByRole("switch", { name: "Vim mode", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => {
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    return await page.getByRole("switch", { name: "Vim mode", exact: true }).getAttribute("aria-checked");
  }).toBe("false");
  await elsewhereCheck();
  await check();
});
