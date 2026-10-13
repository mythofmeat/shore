import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ELECTRON = join(ROOT, "node_modules", "electron");
const ARCHITECTURES: Partial<Record<NodeJS.Architecture, string>> = { arm64: "arm64", x64: "x64" };

function run(...command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode === 0) return;
  console.error(`${command.join(" ")} exited ${String(result.exitCode)}.`);
  process.exit(1);
}

const architecture = ARCHITECTURES[process.arch];
if (process.platform !== "linux" || architecture === undefined) {
  console.error(`The bundled app is built on Linux for arm64 or x64, not ${process.platform} ${process.arch}.`);
  process.exit(1);
}

const electron = (await Bun.file(join(ELECTRON, "package.json")).json() as { version: string }).version;
const download = `electron-v${electron}-linux-${architecture}.zip`;
const checksum = (await Bun.file(join(ELECTRON, "checksums.json")).json() as Record<string, string>)[download];
const response = await fetch(`https://github.com/electron/electron/releases/download/v${electron}/${download}`);
if (!response.ok) {
  console.error(`Couldn't download ${download}: HTTP ${String(response.status)}.`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());
if (checksum === undefined || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== checksum) {
  console.error(`${download} doesn't match the checksum the electron package ships.`);
  process.exit(1);
}

const app = join(ROOT, "..", "out", "desktop", `shore-desktop-linux-${architecture}`);
const work = await mkdtemp(join(tmpdir(), "shore-app-"));
try {
  await Bun.write(join(work, download), bytes);
  await rm(app, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  run("unzip", "-q", join(work, download), "-d", app);
  await rename(join(app, "electron"), join(app, "shore-desktop"));
  await rm(join(app, "resources", "default_app.asar"));
  await cp(join(ROOT, "package.json"), join(app, "resources", "app", "package.json"));
  await cp(join(ROOT, "dist"), join(app, "resources", "app", "dist"), { recursive: true });
  console.log(app);
} finally {
  await rm(work, { recursive: true, force: true });
}
