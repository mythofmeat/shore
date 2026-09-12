import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "**/*.e2e.ts", workers: 1,
  timeout: 45_000, expect: { timeout: 8000 },
  outputDir: "../out/issue-214/playwright", reporter: "list",
  use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
