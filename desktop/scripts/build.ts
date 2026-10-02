import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");
const FONTS = join(ROOT, "..", "daemon", "src", "browser", "fonts");
const SHELL_FONTS = ["geist-latin-wght-normal.woff2", "geist-mono-latin-wght-normal.woff2", "LICENSE-Geist.txt", "LICENSE-GeistMono.txt"];

const builds: Parameters<typeof Bun.build>[0][] = [
  { entrypoints: [join(ROOT, "src", "main.ts")], outdir: OUT, target: "node", format: "esm", external: ["electron"] },
  { entrypoints: [join(ROOT, "src", "preload.ts")], outdir: OUT, target: "node", format: "cjs", external: ["electron"], naming: "[name].cjs" },
  { entrypoints: [join(ROOT, "src", "shell", "shell.ts")], outdir: join(OUT, "shell"), target: "browser", format: "iife" },
];

await rm(OUT, { recursive: true, force: true });
for (const options of builds) {
  const result = await Bun.build(options);
  if (result.success) continue;
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await mkdir(join(OUT, "shell", "fonts"), { recursive: true });
await Promise.all([
  cp(join(ROOT, "src", "shell", "shell.html"), join(OUT, "shell", "shell.html")),
  cp(join(ROOT, "src", "shell", "shell.css"), join(OUT, "shell", "shell.css")),
  cp(join(ROOT, "assets"), join(OUT, "assets"), { recursive: true, filter: (source) => !source.endsWith(".icns") && (!source.endsWith(".svg") || source.endsWith("shore.svg")) }),
  ...SHELL_FONTS.map((file) => cp(join(FONTS, file), join(OUT, "shell", "fonts", file))),
]);
