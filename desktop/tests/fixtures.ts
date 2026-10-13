import { _electron, expect, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { expect };

export const TOKEN = "browser-test-token";
const DESKTOP = join(import.meta.dirname, "..");
const DAEMON = join(DESKTOP, "..", "daemon");
const ELECTRON = process.env["SHORE_DESKTOP_ELECTRON"] ?? "electron";
const APP = process.env["SHORE_DESKTOP_APP"] ?? DESKTOP;

export interface Daemon { origin: string; port: number; tcpPort: number }
export interface LaunchOptions { address?: string }
export interface Launched { app: ElectronApplication; page: Page; settings(): Promise<{ address: string | null; closeToTray: boolean; zoom: number; window: { width: number; height: number; maximized: boolean } }> }

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function electronCommand(profile: string, options: LaunchOptions = {}): { command: string; args: string[]; env: Record<string, string> } {
  const address = options.address === undefined ? [] : [`--address=${options.address}`];
  if (process.platform === "darwin") {
    if (process.env["SHORE_DESKTOP_ELECTRON"] === undefined) throw new Error("Point SHORE_DESKTOP_ELECTRON at a built Shore.app/Contents/MacOS/Shore: on macOS the journeys run the app bundle.");
    return { command: ELECTRON, args: [`--user-data-dir=${join(profile, "shore-desktop")}`, "--use-mock-keychain", ...address], env: environment() };
  }
  const nested = process.env["SHORE_DESKTOP_E2E_DISPLAY"];
  if (nested === undefined || process.env["WAYLAND_DISPLAY"] !== nested) throw new Error("Run the desktop journeys with `bun run test:e2e`: it starts the private KWin session they need.");
  return {
    command: ELECTRON,
    args: ["--ozone-platform=wayland", "--disable-gpu", "--host-resolver-rules=MAP shore.test 127.0.0.1", APP, ...address],
    env: environment({ XDG_CONFIG_HOME: profile, DISPLAY: "" }),
  };
}

export async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
}

export const test = base.extend<{ profile: string; launch: (options?: LaunchOptions) => Promise<Launched> }, { daemon: Daemon }>({
  daemon: [async ({}, use) => {
    const child = spawn("bun", ["run", "tests/browser/server.ts"], { cwd: DAEMON, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SHORE_BROWSER_WEB_BIND: "127.0.0.1:0" } });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
    const stopped = exited(child);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const daemon = await new Promise<Daemon>((resolve, reject) => {
        deadline = setTimeout(() => { reject(new Error(`The fixture daemon did not start. Run \`bun install\` in daemon/ first.\n${errors}`)); }, 30_000);
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4000);
          const match = /SHORE_BROWSER_READY (http:\/\/127\.0\.0\.1:(\d+)) (\d+)\r?\n/.exec(output);
          if (match?.[1] !== undefined) resolve({ origin: match[1], port: Number(match[2]), tcpPort: Number(match[3]) });
        });
        void stopped.then((code) => { reject(new Error(`The fixture daemon exited (${String(code)}).\n${errors}`)); }, reject);
      });
      clearTimeout(deadline);
      await use(daemon);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGTERM");
      expect(await stopped, errors).toBe(0);
    }
  }, { scope: "worker" }],

  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "shore-desktop-profile-"));
    await use(profile);
    await rm(profile, { recursive: true, force: true });
  },

  launch: async ({ profile }, use) => {
    const running: ElectronApplication[] = [];
    await use(async (options = {}) => {
      const { command, args, env } = electronCommand(profile, options);
      const app = await _electron.launch({ executablePath: command, args, env, timeout: 30_000 });
      running.push(app);
      const page = await app.firstWindow();
      const settings = async () => JSON.parse(await readFile(join(profile, "shore-desktop", "settings.json"), "utf8")) as Awaited<ReturnType<Launched["settings"]>>;
      return { app, page, settings };
    });
    for (const app of running) await app.close().catch(() => {});
  },
});

export async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}
