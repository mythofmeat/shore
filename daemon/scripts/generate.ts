import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const DAEMON = join(import.meta.dir, "..");
const CLIENT = join(DAEMON, "..", "client");
const STATE = join(DAEMON, "node_modules", ".cache", "shore-generate");
const PROTOCOL = join(DAEMON, "src", "protocol");
const SCHEMAS = ["src/protocol/wire.generated.json", "src/web/schemas.generated.json", "src/operations/schemas.generated.json"].map((path) => join(DAEMON, path));
const VALIDATOR_SOURCES = ["scripts/browser_validators.ts", "src/operations/validation.ts", "src/operations/number_formats.ts", "bun.lock"].map((path) => join(DAEMON, path));
const BROWSER = join(DAEMON, "src", "browser");
const VALIDATORS = ["validators", "operation_validators"].flatMap((name) => [`${name}.generated.js`, `${name}.generated.d.ts`]).map((name) => join(BROWSER, name));
const ASSETS = join(DAEMON, "src", "web", "assets.generated.ts");

type Stamp = { rust?: string; validators?: string };

function update(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function holder(path: string): number | undefined {
  try {
    return Number(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lock(): () => void {
  mkdirSync(STATE, { recursive: true });
  const path = join(STATE, "lock");
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = holder(path);
    if (pid !== undefined && !running(pid)) rmSync(path, { force: true });
    else Bun.sleepSync(100);
  }
}

function cargo(args: readonly string[]): string {
  const ran = Bun.spawnSync(["cargo", ...args], { cwd: CLIENT, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`cargo ${args.join(" ")} failed in ${CLIENT}\n${ran.stdout.toString()}${ran.stderr.toString()}`);
  return ran.stdout.toString();
}

function wireBuild(): string {
  for (const line of cargo(["test", "--quiet", "--no-run", "--lib", "-p", "shore-common", "--message-format=json-render-diagnostics"]).split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as { reason?: string; executable?: string | null; target?: { name?: string } };
    if (message.reason !== "compiler-artifact" || message.target?.name !== "shore_common" || typeof message.executable !== "string") continue;
    const { size, mtimeMs } = statSync(message.executable);
    return `${message.executable}:${String(size)}:${String(mtimeMs)}`;
  }
  throw new Error("cargo did not report the shore-common test binary");
}

function digest(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex");
}

async function generate(): Promise<void> {
  const release = lock();
  try {
    const stampPath = join(STATE, "stamp.json");
    const stamp = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, "utf8")) as Stamp : {};
    const rust = wireBuild();
    if (rust !== stamp.rust || !SCHEMAS.every((path) => existsSync(path))) {
      rmSync(PROTOCOL, { recursive: true, force: true });
      cargo(["test", "--quiet", "--lib", "-p", "shore-common", "export"]);
    }
    const validators = digest([...SCHEMAS, ...VALIDATOR_SOURCES]);
    if (validators !== stamp.validators || !VALIDATORS.every((path) => existsSync(path))) {
      const { browserValidators } = await import("./browser_validators.ts");
      for (const [name, source] of Object.entries(browserValidators())) update(join(BROWSER, name), source);
    }
    const { buildBrowserAssets } = await import("./build_browser.ts");
    update(ASSETS, await buildBrowserAssets());
    update(stampPath, JSON.stringify({ rust, validators } satisfies Stamp));
  } finally {
    release();
  }
}

if (import.meta.main) await generate();
else if (process.env.SHORE_GENERATED !== "1") {
  const ran = Bun.spawnSync([process.execPath, import.meta.path], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (ran.exitCode !== 0) throw new Error("Generating the wire types, validators and browser assets failed");
}
