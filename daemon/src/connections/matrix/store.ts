import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Sidecar<T> {
  read(): T;
  write(value: T): void;
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

  return {
    read: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
      } catch {
        return fallback();
      }
    },
    write: (value) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch {
      }
    },
  };
}
