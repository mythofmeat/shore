import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLAYWRIGHT = join(ROOT, "node_modules", ".bin", "playwright");

// macOS has no private display to give the journeys, so they run in the logged-in session.
if (process.platform === "darwin") {
  const playwright = Bun.spawn([PLAYWRIGHT, "test", ...process.argv.slice(2)], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await playwright.exited);
}

for (const tool of ["kwin_wayland", "dbus-run-session"]) {
  if (Bun.which(tool) !== null) continue;
  console.error(`The desktop journeys run in a private, invisible KWin session and need ${tool}.`);
  process.exit(1);
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const home = await mkdtemp(join(tmpdir(), "shore-desktop-e2e-"));
const display = `shore-desktop-e2e-${String(process.pid)}`;
const status = join(home, "status");
const session = join(home, "session.sh");
try {
  await Promise.all(["config", "data", "cache", "state"].map((name) => mkdir(join(home, name))));
  const playwright = [PLAYWRIGHT, "test", ...process.argv.slice(2)].map(quote).join(" ");
  await writeFile(session, `#!/bin/sh\nexec 2>&1\ncd ${quote(ROOT)}\n${playwright}\necho $? > ${quote(status)}\n`, { mode: 0o755 });
  const kwin = Bun.spawn([
    "dbus-run-session", "--", "kwin_wayland", "--virtual", "--no-lockscreen", "--no-global-shortcuts", "--no-kactivities",
    "--socket", display, "--width", "1280", "--height", "900", "--exit-with-session", session,
  ], {
    env: {
      ...process.env, DISPLAY: "", SHORE_DESKTOP_E2E_DISPLAY: display,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    },
    stdout: "inherit", stderr: "pipe",
  });
  const [code, log] = await Promise.all([kwin.exited, new Response(kwin.stderr).text()]);
  const result = await readFile(status, "utf8").then((text) => Number(text.trim()), () => undefined);
  if (result === undefined) console.error(`KWin exited (${String(code)}) before the journeys finished:\n${log.slice(-4000)}`);
  process.exitCode = result ?? 1;
} finally {
  await rm(home, { recursive: true, force: true });
}
