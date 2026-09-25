import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import source from "../vendor/codex-apply-patch/source.json";

const root = resolve(import.meta.dir, "..");
const vendor = join(root, "vendor/codex-apply-patch");
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "shore/codex-apply-patch");
const archive = join(cache, `${source.revision}.tar.gz`);
await mkdir(cache, { recursive: true });
let bytes = await readFile(archive).catch(() => undefined);
if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`Codex source download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Codex source checksum mismatch");
  await writeFile(`${archive}.${process.pid}`, bytes);
  await rename(`${archive}.${process.pid}`, archive);
}
const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Failed: ${argv.join(" ")}`);
};
const extracted = join(cache, `codex-${source.revision}`);
const workspace = join(extracted, "codex-rs");
if (!existsSync(extracted)) {
  const staging = await mkdtemp(join(cache, "extract-"));
  await run(["tar", "-xzf", archive, "-C", staging], root);
  await rename(join(staging, `codex-${source.revision}`), extracted).catch(() => {});
  await rm(staging, { recursive: true, force: true });
}
const lock = await readFile(join(vendor, "Cargo.lock"));
if (!lock.equals(await readFile(join(workspace, "Cargo.lock")).catch(() => Buffer.alloc(0)))) {
  await writeFile(join(workspace, "Cargo.lock"), lock);
}
const target = resolve(process.env.SHORE_PATCH_TARGET_DIR ?? join(cache, "target"));
await run(["cargo", "+stable", "build", "--release", "--locked", "-p", "codex-apply-patch", "--bin", "apply_patch"], workspace, {
  ...process.env,
  CARGO_TARGET_DIR: target,
  CARGO_PROFILE_RELEASE_DEBUG: "0",
  CARGO_PROFILE_RELEASE_LTO: "false",
});
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
const extension = process.platform === "win32" ? ".exe" : "";
const temporary = join(dist, `shore-apply-patch${extension}.tmp`);
await copyFile(join(target, "release", `apply_patch${extension}`), temporary);
await chmod(temporary, 0o755);
await rename(temporary, join(dist, `shore-apply-patch${extension}`));
await copyFile(join(vendor, "LICENSE"), join(dist, "codex-apply-patch.LICENSE"));
await copyFile(join(vendor, "NOTICE"), join(dist, "codex-apply-patch.NOTICE"));
console.log(`Built shore-apply-patch from ${source.release} (${source.revision})`);
