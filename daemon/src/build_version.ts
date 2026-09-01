import { join } from "node:path";

export const UNKNOWN_BUILD_VERSION = "unknown";

export function normalizeBuildVersion(described: string): string {
  const trimmed = described.trim().replace(/^v/, "");
  const parts = trimmed.split("-");
  const hash = parts.pop();
  const count = parts.pop();
  if (hash === undefined || count === undefined || parts.length === 0) {
    return trimmed.replaceAll("-", ".");
  }
  return `${parts.join(".")}.r${count}.${hash}`;
}

export function resolveBuildVersion(
  env: NodeJS.ProcessEnv = process.env,
  root = join(import.meta.dir, "../.."),
): string {
  const stamped = env["SHORE_BUILD_VERSION"];
  if (stamped !== undefined && stamped !== "") return stamped;

  const described = Bun.spawnSync(["git", "describe", "--long", "--tags", "--abbrev=7"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (described.exitCode !== 0) return UNKNOWN_BUILD_VERSION;
  return normalizeBuildVersion(described.stdout.toString());
}

export const BUILD_VERSION = process.env.SHORE_BUILD_VERSION || resolveBuildVersion();
