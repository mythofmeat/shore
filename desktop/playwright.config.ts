import { defineConfig } from "@playwright/test";

// The shared journeys start the daemon, which only runs on Linux, so macOS runs just its own.
export default defineConfig({
  testDir: "./tests", testMatch: process.platform === "darwin" ? "**/macos.e2e.ts" : "**/app.e2e.ts", workers: 1,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: "../out/desktop/playwright", reporter: "list",
});
