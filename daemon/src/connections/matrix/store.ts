import { readState, writeState, deleteState } from "../../storage/store.ts";
import { basename, dirname, relative } from "node:path";

import { shoreLog } from "../../log.ts";

export interface Sidecar<T> {
  read(): T;
  write(value: T): void;
}

function isMissing(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "ENOENT";
}

function quarantine(data: string, key: string, reason: string): void {
  const aside = `${key}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    const content = readState(data, key);
    if (content !== undefined) {
      writeState(data, aside, content);
      deleteState(data, key);
    }
    shoreLog.warn(`shore: ${key} was unreadable (${reason}); preserved as ${aside} in shore.db`);
  } catch (e) {
    shoreLog.warn(`shore: could not quarantine ${key}: ${String(e)}`);
  }
}

export function jsonSidecar<T>(path: string | undefined, fallback: () => T): Sidecar<T> {
  if (path === undefined) {
    let held = fallback();
    return {
      read: () => held,
      write: (value) => {
        held = value;
      },
    };
  }

  const data = basename(dirname(path)) === "matrix" ? dirname(dirname(path)) : dirname(path);
  const key = relative(data, path);
  return {
    read: () => {
      let raw: string;
      try {
        const stored = readState(data, key);
        if (stored === undefined) return fallback();
        raw = stored;
      } catch (e) {
        if (!isMissing(e)) quarantine(data, key, String(e));
        return fallback();
      }
      try {
        return JSON.parse(raw) as T;
      } catch (e) {
        quarantine(data, key, String(e));
        return fallback();
      }
    },
    write: (value) => {
      writeState(data, key, JSON.stringify(value));
    },
  };
}
