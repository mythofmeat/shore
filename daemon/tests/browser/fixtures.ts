import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";

export { expect };
export const test = base.extend<{ usageSeed: boolean; calmBudget: boolean; galleryMedia: boolean }>({
  usageSeed: [false, { option: true }],
  calmBudget: [false, { option: true }],
  galleryMedia: [false, { option: true }],
  baseURL: async ({ browserName, usageSeed, calmBudget, galleryMedia }, use) => {
    const child = spawn("bun", ["run", "tests/browser/server.ts"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SHORE_BROWSER_USAGE_SEED: usageSeed ? "true" : "false", SHORE_BROWSER_CALM_BUDGET: calmBudget ? "true" : "false", SHORE_BROWSER_MEDIA_FIXTURE: galleryMedia ? "true" : "false" } });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
    const stopped = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    void stopped.catch(() => {});
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`${browserName} daemon did not become ready: ${errors}`)), 20_000);
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4000);
          const match = /SHORE_BROWSER_READY (http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output);
          if (match?.[1] !== undefined) resolve(match[1]);
        });
        void stopped.then((code) => reject(new Error(`Browser daemon exited (${String(code)}): ${errors}`)), reject);
      });
      clearTimeout(deadline);
      await use(origin);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGTERM");
      const killDeadline = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
      try { expect(await stopped, errors).toBe(0); } finally { clearTimeout(killDeadline); }
    }
  },
});
