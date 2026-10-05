import { realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, sep } from "node:path";

import { rustTrim } from "../memory/lines";

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

const PROTECTED_PATHS = ["SOUL.md", "USER.md", "TOOLS.md"] as const;

const MEMORY_INDEX_DEFERRED_PATH = "MEMORY.md";

export function resolveRoots(workspaceDir: string, relativeRaw: string): [string, string] {
  if (workspaceDir === "") throw new PathError("invalid args: workspace not configured");

  let relative = rustTrim(relativeRaw);
  while (relative.startsWith("./")) relative = relative.slice(2);
  if (relative === "") throw new PathError("invalid args: path is empty");

  if (relative === "workspace") return [workspaceDir, ""];
  if (relative.startsWith("workspace/")) return [workspaceDir, relative.slice("workspace/".length)];
  if (relative === "memory") return [rustJoin(workspaceDir, "memory"), ""];
  if (relative.startsWith("memory/")) {
    return [rustJoin(workspaceDir, "memory"), relative.slice("memory/".length)];
  }
  return [workspaceDir, relative];
}

function rustJoin(base: string, child: string): string {
  if (base === "") return child;
  return base.endsWith(sep) ? base + child : `${base}${sep}${child}`;
}

export function resolvePath(workspaceDir: string, relative: string): string {
  const [base, stripped] = resolveRoots(workspaceDir, relative);
  if (stripped === "") throw new PathError("invalid args: path is empty");

  for (const component of pathComponents(stripped)) {
    if (component === "..") {
      throw new PathError("invalid args: path traversal (..) is not allowed");
    }
    if (component === "/") {
      throw new PathError("invalid args: absolute paths are not allowed");
    }
  }

  const resolved = rustJoin(base, stripped);

  const canonicalBase = tryRealpath(base);
  if (canonicalBase === undefined) return resolved;

  const canonical = tryRealpath(resolved);
  if (canonical !== undefined) {
    if (!isInside(canonical, canonicalBase)) {
      throw new PathError("invalid args: resolved path escapes workspace");
    }
    return resolved;
  }

  let ancestor = resolved;
  for (;;) {
    const parent = parentOf(ancestor);
    if (parent === undefined) break;
    const canonicalParent = tryRealpath(parent);
    if (canonicalParent !== undefined) {
      if (!isInside(canonicalParent, canonicalBase)) {
        throw new PathError("invalid args: resolved path escapes workspace");
      }
      break;
    }
    ancestor = parent;
  }

  return resolved;
}

export function pathComponents(p: string): string[] {
  const out: string[] = [];
  if (isAbsolute(p)) out.push("/");
  for (const part of p.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return out;
}

function isInside(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const withSep = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(withSep);
}

function parentOf(p: string): string | undefined {
  const parent = dirname(p);
  if (parent === p) return undefined;
  if (parent === "." && parse(p).dir === "") return undefined;
  return parent;
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export function normalizeWorkspacePath(path: string): string {
  let normalized = rustTrim(path).replaceAll("\\", "/");
  for (;;) {
    const before = normalized.length;
    while (normalized.startsWith("/")) normalized = normalized.slice(1);
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    if (normalized.startsWith("workspace/")) normalized = normalized.slice("workspace/".length);
    if (normalized.length === before) break;
  }
  return normalized;
}

export function normalizeProtectedPath(path: string): string | undefined {
  const normalized = normalizeWorkspacePath(path);
  return (PROTECTED_PATHS as readonly string[]).includes(normalized) ? normalized : undefined;
}

export function normalizePromptVisiblePath(path: string): string | undefined {
  const normalized = normalizeWorkspacePath(path);
  const protectedName = normalizeProtectedPath(normalized);
  if (protectedName !== undefined) return protectedName;
  if (normalized === MEMORY_INDEX_DEFERRED_PATH) return MEMORY_INDEX_DEFERRED_PATH;
  return undefined;
}
