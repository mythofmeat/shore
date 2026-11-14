import type { LoadedConfig } from "./loader.ts";
import { serializeConfigValue } from "./serialize.ts";

const RESTART_REQUIRED_SECTIONS = ["daemon", "notifications", "matrix"] as const;

export function requiresRestart(key: string): boolean {
  return RESTART_REQUIRED_SECTIONS.some((section) => key === section || key.startsWith(`${section}.`));
}

export function restartRequiredChanges(old: LoadedConfig, fresh: LoadedConfig): string[] {
  return RESTART_REQUIRED_SECTIONS.filter((section) => !same(old.app[section], fresh.app[section])).map((section) => `[${section}]`);
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
