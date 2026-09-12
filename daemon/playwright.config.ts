import { defineConfig } from "@playwright/test";

const port = process.env["SHORE_BROWSER_TEST_PORT"] ?? "17349";
export default defineConfig({
  testDir: "./tests/browser", testMatch: "**/*.e2e.ts", workers: 1,
  timeout: 45_000, expect: { timeout: 8000 },
  outputDir: "../out/issue-214/playwright", reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "bun run tests/browser/server.ts", url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 20_000, gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 } },
});
