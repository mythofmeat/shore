import type { LoadedConfig } from "./loader.ts";
import { serializeConfigValue } from "./serialize.ts";

export function restartRequiredChanges(old: LoadedConfig, fresh: LoadedConfig): string[] {
  const a = old.app;
  const b = fresh.app;
  const changes: string[] = [];
  if (!same(a.daemon, b.daemon)) changes.push("[daemon]");
  if (!same(a.notifications, b.notifications)) changes.push("[notifications]");
  if (!same(a.connections, b.connections)) changes.push("[connections]");
  if (a.cache.forensics !== b.cache.forensics) {
    changes.push("[cache].forensics");
  }
  return changes;
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
