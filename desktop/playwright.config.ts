import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests", testMatch: "**/*.e2e.ts", workers: 1,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: "../out/desktop/playwright", reporter: "list",
});
