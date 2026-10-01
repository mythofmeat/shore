import { join } from "node:path";

const ASSETS = join(import.meta.dir, "..", "assets");
const RENDERS = [
  { source: "shore.svg", output: "shore.png", size: 512 },
  { source: "tray.svg", output: "tray.png", size: 64 },
  { source: "tray-unread.svg", output: "tray-unread.png", size: 64 },
];

for (const { source, output, size } of RENDERS) {
  const result = Bun.spawnSync(["rsvg-convert", "--width", String(size), "--height", String(size), "--output", join(ASSETS, output), join(ASSETS, source)], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`rsvg-convert failed for ${source}. It comes with librsvg.`);
    process.exit(1);
  }
}
