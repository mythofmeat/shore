import type { LoadedConfig } from "./loader.ts";
import { serializeConfigValue } from "./serialize.ts";

export const RESTART_REQUIRED_PATHS = [
  "daemon",
  "notifications",
  "connections",
  "cache.forensics",
] as const;

export function requiresRestart(key: string): boolean {
  return RESTART_REQUIRED_PATHS.some((path) => key === path || key.startsWith(`${path}.`));
}

function at(config: LoadedConfig, path: string): unknown {
  let node: unknown = config.app;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function displayPath(path: string): string {
  const dot = path.indexOf(".");
  if (dot < 0) return `[${path}]`;
  return `[${path.slice(0, dot)}].${path.slice(dot + 1)}`;
}

export function restartRequiredChanges(old: LoadedConfig, fresh: LoadedConfig): string[] {
  return RESTART_REQUIRED_PATHS.filter((path) => !same(at(old, path), at(fresh, path))).map(
    displayPath,
  );
}

function same(a: unknown, b: unknown): boolean {
  return equal(serializeConfigValue(a), serializeConfigValue(b));
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && equal(left[k], right[k]))
  );
}
