import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "..", "out", "desktop");
const ELECTRON = join(ROOT, "node_modules", "electron");
const ELECTRON_DEFAULT_APP_PLIST_KEYS = ["ElectronAsarIntegrity", "LSApplicationCategoryType"];

function run(...command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode === 0) return;
  console.error(`${command.join(" ")} exited ${String(result.exitCode)}.`);
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.error("Shore.app is built on macOS: it needs codesign, plutil and ditto.");
  process.exit(1);
}

const { version } = await Bun.file(join(ROOT, "package.json")).json() as { version: string };
const electron = (await Bun.file(join(ELECTRON, "package.json")).json() as { version: string }).version;
const download = `electron-v${electron}-darwin-arm64.zip`;
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

const work = await mkdtemp(join(tmpdir(), "shore-app-"));
try {
  await Bun.write(join(work, download), bytes);
  run("ditto", "-x", "-k", join(work, download), join(work, "electron"));
  const app = join(work, "Shore.app");
  await rename(join(work, "electron", "Electron.app"), app);
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", "Shore"));
  await rm(join(resources, "default_app.asar"));
  await rm(join(resources, "electron.icns"));
  await cp(join(ROOT, "assets", "shore.icns"), join(resources, "shore.icns"));
  await cp(join(ROOT, "package.json"), join(resources, "app", "package.json"));
  await cp(join(ROOT, "dist"), join(resources, "app", "dist"), { recursive: true });
  await cp(join(work, "electron", "LICENSE"), join(resources, "LICENSE-Electron"));
  await cp(join(work, "electron", "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));

  const plist = join(contents, "Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleDisplayName: "Shore",
    CFBundleExecutable: "Shore",
    CFBundleIconFile: "shore.icns",
    CFBundleIdentifier: "com.mythofmeat.shore",
    CFBundleName: "Shore",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  })) run("plutil", "-replace", key, "-string", value, plist);
  for (const key of ELECTRON_DEFAULT_APP_PLIST_KEYS) run("plutil", "-remove", key, plist);

  run("codesign", "--force", "--deep", "--sign", "-", app);
  run("codesign", "--verify", "--deep", "--strict", app);

  await mkdir(OUT, { recursive: true });
  const zip = join(OUT, `Shore-${version}-arm64.zip`);
  await rm(zip, { force: true });
  run("ditto", "-c", "-k", "--keepParent", app, zip);
  console.log(zip);
} finally {
  await rm(work, { recursive: true, force: true });
}
