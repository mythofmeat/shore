import { join } from "node:path";

const ASSETS = join(import.meta.dir, "..", "assets");
const RENDERS = [
  { source: "shore.svg", output: "shore.png", size: 512 },
  { source: "tray.svg", output: "tray.png", size: 64 },
  { source: "tray-unread.svg", output: "tray-unread.png", size: 64 },
  { source: "tray-template.svg", output: "tray-template.png", size: 18 },
  { source: "tray-template.svg", output: "tray-template@2x.png", size: 36 },
  { source: "tray-unread-template.svg", output: "tray-unread-template.png", size: 18 },
  { source: "tray-unread-template.svg", output: "tray-unread-template@2x.png", size: 36 },
];
// Each .icns entry is a PNG of one size: 16 to 512 points at one and two pixels per point.
const ICNS_ENTRIES = [["icp4", 16], ["ic11", 32], ["icp5", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]] as const;
// macOS draws app icons on a 1024-unit grid whose rounded square is 824 units wide. shore.svg's tile,
// outline included, is 438 of its 512 units, so the .icns renders a wider view of the same drawing.
const MAC_TILE = 438;

function render(svg: Uint8Array, size: number, label: string): Uint8Array {
  const result = Bun.spawnSync(["rsvg-convert", "--width", String(size), "--height", String(size)], { stdin: svg, stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`rsvg-convert failed for ${label}. It comes with librsvg.`);
    process.exit(1);
  }
  return result.stdout;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, "ascii");
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

for (const { source, output, size } of RENDERS) {
  await Bun.write(join(ASSETS, output), render(await Bun.file(join(ASSETS, source)).bytes(), size, source));
}

const side = MAC_TILE * 1024 / 824;
const origin = 256 - side / 2;
const svg = await Bun.file(join(ASSETS, "shore.svg")).text();
if (!svg.includes('viewBox="0 0 512 512"')) {
  console.error("shore.svg no longer has the 512-unit viewBox the .icns grid is measured against.");
  process.exit(1);
}
const macSvg = Buffer.from(svg.replace('viewBox="0 0 512 512"', `viewBox="${origin.toFixed(2)} ${origin.toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}"`));
await Bun.write(join(ASSETS, "shore.icns"), chunk("icns", Buffer.concat(ICNS_ENTRIES.map(([type, size]) => chunk(type, render(macSvg, size, "shore.icns"))))));
