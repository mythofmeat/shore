import { expect, test } from "bun:test";
import { join } from "node:path";

const DESKTOP = join(import.meta.dir, "..");
const ELECTRON = join(DESKTOP, "node_modules", "electron");

test("the Homebrew formula bundles the Electron that bun.lock pins", async () => {
  const { version } = await Bun.file(join(ELECTRON, "package.json")).json() as { version: string };
  const checksums = await Bun.file(join(ELECTRON, "checksums.json")).json() as Record<string, string>;
  const zip = `electron-v${version}-darwin-arm64.zip`;
  const resource = /resource "electron" do\n\s+url "(.*)"\n\s+sha256 "(.*)"\n/.exec(await Bun.file(join(DESKTOP, "..", "HomebrewFormula", "shore-desktop.rb")).text());
  expect(resource?.slice(1)).toEqual([`https://github.com/electron/electron/releases/download/v${version}/${zip}`, checksums[zip] ?? "a checksum for the zip"]);
});
