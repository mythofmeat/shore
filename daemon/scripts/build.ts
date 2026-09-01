import { BUILD_VERSION } from "../src/build_version.ts";

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "src/daemon/run.ts",
    "--compile",
    "--outfile",
    "dist/shore-daemon",
    "--env=SHORE_BUILD_*",
  ],
  {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, SHORE_BUILD_VERSION: BUILD_VERSION },
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (build.exitCode !== 0) process.exit(build.exitCode);
